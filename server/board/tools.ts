import { z } from "zod";
import { tileInputSchemas, type TileDraft, type TileImage, type TileKind, type TileSource } from "../../src/shared/board";
import { MAX_TILES, type Board } from "./board";
import { exaSearch } from "./exa";
import { linkResolves } from "./links";
import type { Tool } from "./openrouter";
import * as wiki from "./wikipedia";

const KINDS = Object.keys(tileInputSchemas) as TileKind[];
const SEARCHES_PER_RUN = 3; // one update can't fan out into a costly research session

const PUT_DESCRIPTIONS: Record<TileKind, string> = {
  person:
    "Show (or replace, by id) a tile about a person being discussed. Set `wikipedia` to their article title so the board shows their photo.",
  fact: "Show (or replace, by id) a tile with a fact, place, event or idea the conversation depends on.",
  positions:
    "Show (or replace, by id) a tile comparing where the speakers stand on a question they are discussing. Only include speakers who took a position.",
  timeline: "Show (or replace, by id) a tile of dated events the conversation refers to, oldest first.",
  quote: "Show (or replace, by id) a tile highlighting one memorable line, verbatim from the transcript.",
  chart:
    "Show (or replace, by id) a bar chart of numbers the conversation turns on. Use only numbers stated in the conversation or found by search, and cite searched ones.",
};

const searchInput = z.object({ query: z.string().min(1).max(200) });
const lookupInput = z.object({ title: z.string().min(1).max(200) });
const removeInput = z.object({ id: z.string().min(1).max(48) });
const prominenceInput = z.object({
  id: z.string().min(1).max(48),
  prominence: z.enum(["featured", "normal", "minor"]),
});

function functionTool(name: string, description: string, schema: z.ZodType): Tool {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  return { type: "function", function: { name, description, parameters } };
}

/** With an Exa key, search is a tool this server runs; without one, OpenRouter's built-in search. */
export function toolDefinitions(exa: boolean): Tool[] {
  const search: Tool = exa
    ? functionTool(
        "web_search",
        `Search the web (Exa). Returns up to 5 results with title, url, date and key passages, and whether the page has an image. For recent or niche facts; at most ${SEARCHES_PER_RUN} searches per update.`,
        searchInput,
      )
    : // Runs inside OpenRouter's request (native Claude search when available).
      { type: "openrouter:web_search", parameters: { max_results: 5, max_total_results: 10, max_uses: SEARCHES_PER_RUN } };
  return [
    search,
    functionTool(
      "wikipedia_search",
      "Search English Wikipedia; returns up to 5 article titles with snippets. Free and fast — prefer it to web search for people, places and history.",
      searchInput,
    ),
    functionTool(
      "wikipedia_lookup",
      "Fetch an English Wikipedia article's summary by exact title (redirects followed): description, lead paragraph, url, and whether it has a lead image.",
      lookupInput,
    ),
    ...KINDS.map((kind) => functionTool(`put_${kind}`, PUT_DESCRIPTIONS[kind], tileInputSchemas[kind])),
    functionTool(
      "set_prominence",
      "Re-rank a tile without rewriting it: featured (the one tile shown large at the top; featuring another demotes it), normal, or minor (compact, for background).",
      prominenceInput,
    ),
    functionTool("remove_tile", "Remove a tile the conversation has moved past.", removeInput),
  ];
}

const fail = (message: string): string => `Error: ${message}`;

/** A page a search or lookup actually returned: the only URLs a tile may cite. */
interface SeenPage {
  title: string;
  image?: string;
}

export interface SearchStats {
  searches: number;
  cost: number; // dollars billed by Exa
}

/** Runs the agent's function calls. Every result is a string the model reads. */
export class ToolExecutor {
  private readonly seen = new Map<string, SeenPage>(); // normalized url → page; lives as long as the board
  private stats: SearchStats = { searches: 0, cost: 0 };

  constructor(
    private readonly board: Board,
    private readonly speakers: () => ReadonlySet<string>,
    private readonly exaKey?: string,
  ) {}

  /** Resets the per-update search budget and returns what the previous update spent. */
  beginRun(): SearchStats {
    const previous = this.stats;
    this.stats = { searches: 0, cost: 0 };
    return previous;
  }

  get runStats(): SearchStats {
    return this.stats;
  }

  async run(name: string, rawArgs: string): Promise<string> {
    let args: unknown;
    try {
      args = JSON.parse(rawArgs || "{}");
    } catch {
      return fail("arguments were not valid JSON");
    }
    try {
      if (name === "web_search" && this.exaKey) return await this.webSearch(this.exaKey, args);
      if (name === "wikipedia_search") return await this.wikiSearch(args);
      if (name === "wikipedia_lookup") return await this.lookup(args);
      if (name === "remove_tile") return this.remove(args);
      if (name === "set_prominence") return this.prominence(args);
      const kind = name.replace(/^put_/, "") as TileKind;
      if (name.startsWith("put_") && kind in tileInputSchemas) return await this.put(kind, args);
      return fail(`unknown tool ${name}`);
    } catch (err) {
      return fail(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async webSearch(apiKey: string, args: unknown): Promise<string> {
    const parsed = searchInput.safeParse(args);
    if (!parsed.success) return fail(z.prettifyError(parsed.error));
    if (this.stats.searches >= SEARCHES_PER_RUN) {
      return fail(`search budget for this update is spent (${SEARCHES_PER_RUN}); work with what you have`);
    }
    this.stats.searches++;
    const { results, cost } = await exaSearch(apiKey, parsed.data.query);
    this.stats.cost += cost;
    for (const r of results) this.seen.set(normalize(r.url), { title: r.title, image: r.image });
    if (!results.length) return "No results.";
    return JSON.stringify(
      results.map((r) => ({
        title: r.title,
        url: r.url,
        published: r.publishedDate?.slice(0, 10),
        hasImage: Boolean(r.image),
        passages: r.highlights.map((h) => h.replace(/\s+/g, " ").trim()),
      })),
    );
  }

  private async wikiSearch(args: unknown): Promise<string> {
    const parsed = searchInput.safeParse(args);
    if (!parsed.success) return fail(z.prettifyError(parsed.error));
    const hits = await wiki.search(parsed.data.query);
    return hits.length ? JSON.stringify(hits) : "No Wikipedia articles matched.";
  }

  private async lookup(args: unknown): Promise<string> {
    const parsed = lookupInput.safeParse(args);
    if (!parsed.success) return fail(z.prettifyError(parsed.error));
    const page = await wiki.lookup(parsed.data.title);
    if (!page) return `No Wikipedia article is titled "${parsed.data.title}". Try wikipedia_search.`;
    this.seen.set(normalize(page.url), { title: page.title });
    return JSON.stringify({
      title: page.title,
      description: page.description,
      extract: page.extract.slice(0, 700),
      url: page.url,
      hasImage: Boolean(page.image),
      disambiguation: page.disambiguation,
    });
  }

  private remove(args: unknown): string {
    const parsed = removeInput.safeParse(args);
    if (!parsed.success) return fail(z.prettifyError(parsed.error));
    return this.board.remove(parsed.data.id)
      ? `ok: removed "${parsed.data.id}"`
      : fail(`no tile has id "${parsed.data.id}"`);
  }

  private prominence(args: unknown): string {
    const parsed = prominenceInput.safeParse(args);
    if (!parsed.success) return fail(z.prettifyError(parsed.error));
    const { id, prominence } = parsed.data;
    const result = this.board.setProminence(id, prominence);
    if (result === "missing") return fail(`no tile has id "${id}"`);
    return result === "unchanged" ? `unchanged: "${id}" is already ${prominence}` : `ok: "${id}" is now ${prominence}`;
  }

  private async put(kind: TileKind, args: unknown): Promise<string> {
    const parsed = tileInputSchemas[kind].safeParse(args);
    if (!parsed.success) return fail(z.prettifyError(parsed.error));
    const input = parsed.data;
    // Several tile kinds share these optional fields; read them without
    // narrowing the union kind by kind.
    const shared = input as {
      wikipedia?: string;
      imageFrom?: string;
      sources?: TileSource[];
      speaker?: string;
      stances?: { speaker: string }[];
    };

    const known = this.speakers();
    const named = [shared.speaker, ...(shared.stances ?? []).map((s) => s.speaker)].filter(
      (s): s is string => Boolean(s),
    );
    const strangers = named.filter((s) => !known.has(s));
    if (strangers.length) {
      return fail(
        `no speaker ${strangers.join(", ")} in the transcript (known: ${[...known].join(", ") || "none yet"})`,
      );
    }
    if (!this.board.has(input.id) && this.board.size >= MAX_TILES) {
      return fail(`the board is full (${MAX_TILES} tiles); reuse an id or remove a tile first`);
    }

    const notes: string[] = [];
    let image: TileImage | undefined;
    let link: string | undefined;
    if (shared.wikipedia) {
      const page = await wiki.lookup(shared.wikipedia);
      if (!page) return fail(`no Wikipedia article titled "${shared.wikipedia}"; confirm it with wikipedia_lookup`);
      if (page.disambiguation) return fail(`"${page.title}" is a disambiguation page; use the specific article`);
      this.seen.set(normalize(page.url), { title: page.title });
      image = page.image;
      link = page.url;
    }
    // Wikimedia images are preferred (mostly freely licensed); a search
    // result's image is the fallback for subjects Wikipedia doesn't picture.
    if (!image && shared.imageFrom) {
      const page = this.seen.get(normalize(shared.imageFrom));
      if (page?.image) image = { url: page.image, alt: page.title, pageUrl: shared.imageFrom };
      else notes.push(`no image: ${shared.imageFrom} is not a web_search result with an image`);
    }

    if (shared.sources?.length) {
      const kept = await this.verifiedSources(shared.sources);
      const dropped = shared.sources.filter((s) => !kept.includes(s)).map((s) => s.url);
      if (dropped.length) notes.push(`dropped sources that no search or lookup returned: ${dropped.join(", ")}`);
      shared.sources = kept;
    }

    // The union can't be correlated with `kind` through the generic schema
    // lookup; `parsed` was validated against exactly this kind's schema.
    const result = this.board.put({ ...input, kind, image, link } as TileDraft);
    if (result === "unchanged") {
      return `unchanged: "${input.id}" already says exactly this, so nothing was redrawn`;
    }
    return [`ok: ${kind} tile "${input.id}" is on the board${image ? " with a photo" : ""}`, ...notes].join(". ");
  }

  /**
   * With Exa, the server saw every result, so a cited source must be one of
   * them (or a looked-up Wikipedia page). With OpenRouter's built-in search the
   * results never reach this server, so the best available check is that the
   * link exists.
   */
  private async verifiedSources(sources: TileSource[]): Promise<TileSource[]> {
    if (this.exaKey) return sources.filter((s) => this.seen.has(normalize(s.url)));
    const live = await Promise.all(sources.map((s) => linkResolves(s.url)));
    return sources.filter((_, i) => live[i]);
  }
}

/** Compares URLs the way a person would: ignoring fragments, tracking params and trailing slashes. */
function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) if (key.startsWith("utm_")) u.searchParams.delete(key);
    u.hostname = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname}${path}${u.search}`;
  } catch {
    return url;
  }
}
