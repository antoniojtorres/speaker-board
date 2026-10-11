import "dotenv/config";
import { createServer } from "node:http";
import sirv from "sirv";
import { WebSocketServer } from "ws";
import { MetricsAnalyzer } from "./analysis/analyzer";
import { parseArgs, parseBoardMode } from "./args";
import { BoardAgent, type BoardAgentOptions, type Effort } from "./board/agent";
import { Board } from "./board/board";
import { startMockBoard } from "./board/mock";
import { EventBus } from "./bus";
import { DebugLogger } from "./debug";
import { AssemblyAiAdapter } from "./ingest/assemblyai";
import { MockIngestAdapter } from "./ingest/mock";
import type { IngestAdapter } from "./ingest/types";

// CLI flags win over .env. Normalize them into the environment at the entry
// point so every consumer keeps reading its config from one place.
const cli = parseArgs(process.argv.slice(2));
if (cli.maxSpeakers !== undefined) process.env.MAX_SPEAKERS = String(cli.maxSpeakers);
if (cli.board !== undefined) process.env.BOARD = cli.board;

const PORT = Number(process.env.PORT ?? 8787);
const INGEST = process.env.INGEST ?? "mock";
const BOARD = parseBoardMode(process.env.BOARD?.trim() || "off", "BOARD");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const isProd = process.env.NODE_ENV === "production";
const DEBUG_LOG_FILE =
  process.env.DEBUG_LOG_FILE ?? (process.env.DEBUG_LOG ? `logs/debug-${Date.now()}.jsonl` : null);
const debug = new DebugLogger(DEBUG_LOG_FILE);

const bus = new EventBus();

// Analysis stage: derive live metrics from finalized utterances.
const analyzer = new MetricsAnalyzer();
bus.subscribe((e) => {
  if (e.type === "utterance" && e.utterance.state === "final") {
    for (const out of analyzer.onFinal(e.utterance)) bus.publish(out);
  }
});

const serve = isProd ? sirv("dist", { single: true }) : null;
const server = createServer((req, res) => {
  if (serve) {
    serve(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  } else {
    res.statusCode = 404;
    res.end("dev: open the Vite server on :5173");
  }
});

const wss = new WebSocketServer({ server, path: "/bus" });
wss.on("connection", (ws) => bus.addClient(ws));

const adapter: IngestAdapter =
  INGEST === "assemblyai" ? new AssemblyAiAdapter(debug) : new MockIngestAdapter();

// Board stage: an agent (or the mock) keeps a tile board about the conversation.
const board = new Board(bus);
let stopBoard = (): void => {};

function startBoard(): () => void {
  if (BOARD === "mock") return startMockBoard(board);
  if (BOARD === "off") {
    board.setAgent({ state: "off", detail: "The board is turned off (BOARD=off)" });
    return () => {};
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    console.warn("board: OPENROUTER_API_KEY is not set; the board agent is off");
    board.setAgent({ state: "off", detail: "Set OPENROUTER_API_KEY in .env to turn on the board agent" });
    return () => {};
  }
  const effortOf = (raw: string | undefined, fallback: Effort): Effort =>
    EFFORTS.find((e) => e === raw?.trim()) ?? fallback;
  const opts: BoardAgentOptions = {
    apiKey,
    exaApiKey: process.env.EXA_API_KEY?.trim() || undefined,
    update: {
      model: process.env.BOARD_MODEL?.trim() || "anthropic/claude-sonnet-5.5",
      effort: effortOf(process.env.BOARD_EFFORT, "medium"),
    },
    editor: {
      model: process.env.BOARD_EDITOR_MODEL?.trim() || "anthropic/claude-opus-5.5",
      effort: effortOf(process.env.BOARD_EDITOR_EFFORT, "high"),
      intervalMs: Number(process.env.BOARD_EDITOR_INTERVAL_S || 180) * 1000,
    },
    minIntervalMs: Number(process.env.BOARD_INTERVAL_S || 30) * 1000,
    minWords: 40,
    quietMs: 12_000,
  };
  const agent = new BoardAgent(bus, board, opts, debug);
  agent.start();
  const { update, editor } = opts;
  console.log(
    `board: agent on — updates ${update.model} (${update.effort}) at most every ${opts.minIntervalMs / 1000}s; ` +
      `editor ${editor.model} (${editor.effort}) every ${editor.intervalMs / 1000}s while the board changes; ` +
      `${opts.exaApiKey ? "Exa" : "OpenRouter"} search`,
  );
  return () => agent.stop();
}

server.listen(PORT, () => {
  const speakers = process.env.MAX_SPEAKERS ? `, max_speakers=${process.env.MAX_SPEAKERS}` : "";
  console.log(`listening on :${PORT} (ingest=${INGEST}${speakers}, board=${BOARD})`);
  if (DEBUG_LOG_FILE) console.log(`debug log → ${DEBUG_LOG_FILE}`);
  adapter.start(bus).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("ingest failed:", message);
    bus.publish({ type: "session", status: "error", message });
  });
  stopBoard = startBoard();
});

async function shutdown(): Promise<void> {
  stopBoard();
  try {
    await adapter.stop();
  } catch {
    /* ignore */
  }
  debug.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
