import type { Utterance } from "../../src/shared/events";
import type { EventBus } from "../bus";
import type { DebugLogger } from "../debug";
import type { Board } from "./board";
import { chat, OpenRouterError, type ChatRequest, type Message, type TextPart } from "./openrouter";
import { SYSTEM_PROMPT } from "./prompt";
import { ToolExecutor, toolDefinitions } from "./tools";

export type Effort = NonNullable<ChatRequest["reasoning"]>["effort"];

export interface ModelChoice {
  model: string;
  effort: Effort;
}

export interface BoardAgentOptions {
  apiKey: string;
  /** Exa key for web search run by this server; without it, OpenRouter's built-in search. */
  exaApiKey?: string;
  /** Frequent, small updates as speech comes in. */
  update: ModelChoice;
  /** Periodic pass that steps back and reorganizes the whole board. */
  editor: ModelChoice & { intervalMs: number };
  /** Never start runs closer together than this. */
  minIntervalMs: number;
  /** Run once this many new words have been said… */
  minWords: number;
  /** …or once the room has been quiet this long with anything unprocessed. */
  quietMs: number;
}

type Task = "update" | "reorganize";

const MAX_STEPS = 10; // model round-trips per run
const TICK_MS = 2000;
const EPHEMERAL = { type: "ephemeral" } as const;

const INSTRUCTIONS: Record<Task, (chunk: number) => string> = {
  update: (chunk) =>
    `Update the board for chunk ${chunk}: add what is new and adjust positions that moved. Only rewrite a tile when its meaning changes, never just to rephrase it. Leave reorganizing the board to the periodic editor pass.`,
  reorganize: (chunk) =>
    `Editor pass. Step back and reorganize the board around what the conversation is about now (the transcript through chunk ${chunk}). Merge tiles that overlap, remove ones the conversation has left behind, and keep about 6-9 tiles. Feature exactly one tile, the live center of the conversation (usually the debate being had), and set background tiles to minor; re-rank with set_prominence rather than rewriting tiles. Rewrite a tile only to merge or correct it, and search only if a key fact is missing.`,
};

/**
 * Watches finalized speech and keeps the board current via OpenRouter, in two
 * rhythms: a fast, cheaper model makes small updates as speech arrives, and
 * every few minutes (while the board is changing) a stronger model steps back
 * and reorganizes it — merging, retiring, and picking the one featured tile.
 *
 * Each run is one fresh, self-contained request rather than turn N of an
 * ever-growing agent conversation: the board itself is the agent's memory. That
 * keeps search results and tool chatter from piling up in context, and makes
 * every run independent of how earlier ones went.
 *
 * The request is laid out for prompt caching. The system prompt and tools never
 * change; the transcript is a list of chunk blocks that only ever grows at the
 * end, and earlier chunks are kept byte-identical, so each run re-reads
 * everything before the newest chunk from cache (caches are per model, so the
 * updater and the editor each keep their own). The board state, which changes
 * every run, sits after the last cache marker.
 */
export class BoardAgent {
  private readonly tools: ReturnType<typeof toolDefinitions>;
  private readonly executor: ToolExecutor;
  private readonly speakers = new Set<string>();
  private chunks: string[] = []; // rendered once, never edited
  private pending: string[] = [];
  private pendingWords = 0;
  private lastFinalAt = 0;
  private lastRunAt = 0;
  private lastEditorAt = Date.now(); // first editor pass comes one interval after start
  private changesSinceEditor = 0;
  private failures = 0;
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private abort = new AbortController();

  constructor(
    private readonly bus: EventBus,
    private readonly board: Board,
    private readonly opts: BoardAgentOptions,
    private readonly debug: DebugLogger,
  ) {
    this.tools = toolDefinitions(Boolean(opts.exaApiKey));
    this.executor = new ToolExecutor(board, () => this.speakers, opts.exaApiKey);
  }

  start(): void {
    this.board.setAgent({ state: "idle", model: this.opts.update.model, detail: "waiting for conversation" });
    this.bus.subscribe((e) => {
      if (e.type === "utterance" && e.utterance.state === "final") this.onFinal(e.utterance);
    });
    this.timer = setInterval(() => this.maybeRun(), TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
  }

  private onFinal(u: Utterance): void {
    const text = u.text.trim();
    if (!text) return;
    if (u.speaker !== "UNKNOWN") this.speakers.add(u.speaker);
    this.pending.push(`${u.speaker}: ${text}`);
    this.pendingWords += text.split(/\s+/).length;
    this.lastFinalAt = Date.now();
  }

  private maybeRun(): void {
    if (this.running || this.stopped) return;
    const now = Date.now();
    // Back off after failures so a broken upstream isn't hammered every interval.
    const interval = this.opts.minIntervalMs * 2 ** Math.min(this.failures, 4);
    if (now - this.lastRunAt < interval) return;
    // Reorganize only a board that has changed since the last pass; a quiet room costs nothing.
    if (this.changesSinceEditor > 0 && now - this.lastEditorAt >= this.opts.editor.intervalMs) {
      void this.run("reorganize");
      return;
    }
    if (this.pending.length === 0) return;
    const enoughSaid = this.pendingWords >= this.opts.minWords;
    const quiet = now - this.lastFinalAt >= this.opts.quietMs;
    if (enoughSaid || quiet) void this.run("update");
  }

  private async run(task: Task): Promise<void> {
    this.running = true;
    this.lastRunAt = Date.now();
    if (this.pending.length) {
      this.chunks.push(`Chunk ${this.chunks.length + 1}:\n${this.pending.join("\n")}`);
      this.pending = [];
      this.pendingWords = 0;
    }
    const choice = task === "reorganize" ? this.opts.editor : this.opts.update;
    this.board.setAgent({ state: "thinking", task, model: choice.model });
    const started = Date.now();
    try {
      const summary = await this.converse(task, choice);
      this.failures = 0;
      if (task === "reorganize") {
        this.lastEditorAt = Date.now();
        this.changesSinceEditor = 0;
      } else {
        this.changesSinceEditor += summary.changes;
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`board: ${task === "reorganize" ? "[reorganize] " : ""}${summary.note} (${summary.detail}, ${seconds}s)`);
      this.debug.log({ scope: "board", event: "run", task, model: choice.model, note: summary.note, detail: summary.detail, seconds: Number(seconds) });
      this.board.setAgent({ state: "idle", model: this.opts.update.model, detail: summary.note });
    } catch (err) {
      if (this.stopped) return;
      if (task === "reorganize") {
        // The editor pass is a refinement: when it fails, try again next
        // interval and let updates carry on rather than backing them off too.
        this.lastEditorAt = Date.now();
      } else {
        this.failures++;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.debug.log({ scope: "board", event: "run_error", task, message });
      if (err instanceof OpenRouterError && err.fatal) {
        // A bad key or an empty account won't fix itself; stop spending attempts.
        console.error(`board: ${message}; agent stopped`);
        this.stop();
        this.board.setAgent({ state: "off", model: choice.model, detail: message });
        return;
      }
      console.error(`board: ${task} failed: ${message}`);
      this.board.setAgent({ state: "error", model: choice.model, detail: message });
    } finally {
      this.running = false;
    }
  }

  /** One run: a short tool-use loop on a freshly assembled request. */
  private async converse(task: Task, choice: ModelChoice): Promise<{ note: string; detail: string; changes: number }> {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT, cache_control: EPHEMERAL }] },
      { role: "user", content: [...this.transcriptParts(), { type: "text", text: this.boardBrief(task) }] },
    ];
    let calls = 0;
    let changes = 0;
    let searches = 0;
    let cost = 0;
    let cached = 0;
    this.executor.beginRun();
    // Exa searches run here, not inside OpenRouter, so they're billed and counted separately.
    const totals = (): string => {
      const exa = this.executor.runStats;
      return describe(calls, changes, searches + exa.searches, cost + exa.cost, cached);
    };
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await chat(
        this.opts.apiKey,
        {
          model: choice.model,
          messages,
          tools: this.tools,
          max_tokens: 16000,
          reasoning: { effort: choice.effort },
          cache_control: EPHEMERAL, // moves along the in-run tail as tool turns append
          max_tool_calls: 6,
        },
        this.abort.signal,
      );
      cost += res.usage?.cost ?? 0;
      cached += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      searches += res.usage?.server_tool_use_details?.web_search_requests ?? 0;
      this.debug.log({ scope: "board", event: "response", task, step, model: res.model, usage: res.usage });

      const choiceOut = res.choices[0];
      if (!choiceOut) throw new Error("OpenRouter returned no choices");
      const { message } = choiceOut;
      // Append exactly what came back; Claude's reasoning_details must round-trip untouched.
      messages.push({
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls,
        reasoning_details: message.reasoning_details,
      });
      if (!message.tool_calls?.length) {
        const note = (message.content ?? "").trim().split("\n")[0] || "no change";
        if (choiceOut.finish_reason === "length") this.debug.log({ scope: "board", event: "truncated", task });
        return { note, detail: totals(), changes };
      }
      for (const call of message.tool_calls) {
        calls++;
        const result = await this.executor.run(call.function.name, call.function.arguments);
        if (result.startsWith("ok:")) changes++;
        this.debug.log({ scope: "board", event: "tool", task, name: call.function.name, args: call.function.arguments, result });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    return { note: `stopped after ${MAX_STEPS} steps`, detail: totals(), changes };
  }

  /** Transcript chunks, with the cache marker on the newest so the next run reads all of them from cache. */
  private transcriptParts(): TextPart[] {
    return this.chunks.map((text, i) =>
      i === this.chunks.length - 1 ? { type: "text", text, cache_control: EPHEMERAL } : { type: "text", text },
    );
  }

  /** What's on the board now; changes every run, so it lives after the cache markers. */
  private boardBrief(task: Task): string {
    const now = Date.now();
    const tiles = this.board.snapshot().tiles.map(({ image: _i, link: _l, updatedAt, ...tile }) => ({
      ...tile,
      minutesSinceUpdate: Math.round((now - updatedAt) / 60_000),
    }));
    return [
      `Current board (${tiles.length} tiles, in display order; stance "history" lists each speaker's stances, oldest first):`,
      tiles.length ? JSON.stringify(tiles) : "(empty)",
      `Speakers so far: ${[...this.speakers].join(", ") || "none attributed yet"}.`,
      INSTRUCTIONS[task](this.chunks.length),
    ].join("\n");
  }
}

function describe(calls: number, changes: number, searches: number, cost: number, cached: number): string {
  const parts = [`${calls} tool call${calls === 1 ? "" : "s"}, ${changes} change${changes === 1 ? "" : "s"}`];
  if (searches) parts.push(`${searches} web search${searches === 1 ? "" : "es"}`);
  if (cached) parts.push(`${cached} cached tokens`);
  if (cost) parts.push(`$${cost.toFixed(4)}`);
  return parts.join(", ");
}
