import { z } from "zod";

// The board's tile catalog. Each tile kind has one model-facing input schema
// (what the board agent fills in through a `put_<kind>` tool) and one published
// shape (what display clients render). The server adds what the model must never
// supply itself — images and links resolved from Wikipedia or from a search
// result, timestamps — so a tile can't carry an invented URL.

const tileId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/)
  .describe(
    "Stable slug for this tile, e.g. \"grant\" or \"war-causes\". Reusing an id replaces that tile in place.",
  );

const speaker = z
  .string()
  .min(1)
  .max(12)
  .describe("Speaker label exactly as it appears in the transcript, e.g. \"A\". Never \"UNKNOWN\".");

const wikipedia = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "Exact English Wikipedia article title (as returned by wikipedia_lookup). The server attaches its lead image and link.",
  );

const imageFrom = z
  .url()
  .describe(
    "For a subject with no Wikipedia photo: the url of a web_search result that has an image. The server attaches that page's image.",
  );

const prominence = z
  .enum(["featured", "normal", "minor"])
  .describe(
    "featured: the center of the conversation right now, shown large at the top (only one tile can be). minor: background, shown compact. Omit to keep the tile's current prominence.",
  );

const stanceKind = z.enum(["for", "against", "mixed", "undecided"]);

const source = z.object({
  title: z.string().min(1).max(120),
  url: z.url().describe("A URL you actually saw in search results or a lookup. Never construct one."),
});

export const tileInputSchemas = {
  person: z.object({
    id: tileId,
    name: z.string().min(1).max(60),
    role: z.string().min(1).max(80).describe("Who they are, in a few words"),
    summary: z.string().min(1).max(280).describe("Why they matter to what is being discussed"),
    wikipedia: wikipedia.optional(),
    imageFrom: imageFrom.optional(),
    sources: z.array(source).max(3).optional(),
    prominence: prominence.optional(),
  }),
  fact: z.object({
    id: tileId,
    headline: z.string().min(1).max(90),
    body: z.string().min(1).max(320),
    wikipedia: wikipedia.optional(),
    imageFrom: imageFrom.optional(),
    sources: z.array(source).max(3).optional(),
    prominence: prominence.optional(),
  }),
  positions: z.object({
    id: tileId,
    topic: z.string().min(1).max(90).describe("The question the speakers disagree or agree on"),
    tone: z
      .enum(["friendly", "lively", "heated"])
      .optional()
      .describe("How the exchange sounds: friendly, lively (spirited but warm), or heated (genuinely confrontational)"),
    stances: z
      .array(
        z.object({
          speaker,
          stance: stanceKind.describe("Relative to the topic as phrased"),
          summary: z.string().min(1).max(160).describe("Their position in one sentence"),
          points: z
            .array(z.string().min(1).max(90))
            .max(3)
            .optional()
            .describe("Up to 3 short arguments they have actually made, strongest first"),
          quote: z.string().max(140).optional().describe("A short verbatim quote from the transcript"),
        }),
      )
      .min(1)
      .max(6),
    prominence: prominence.optional(),
  }),
  timeline: z.object({
    id: tileId,
    title: z.string().min(1).max(80),
    events: z
      .array(
        z.object({
          when: z.string().min(1).max(24).describe("Date or period, e.g. \"Jul 1863\""),
          label: z.string().min(1).max(90),
        }),
      )
      .min(2)
      .max(8),
    prominence: prominence.optional(),
  }),
  quote: z.object({
    id: tileId,
    speaker,
    text: z.string().min(1).max(220).describe("Verbatim from the transcript"),
    note: z.string().max(100).optional().describe("Why this line matters"),
    prominence: prominence.optional(),
  }),
  chart: z.object({
    id: tileId,
    title: z.string().min(1).max(80),
    unit: z.string().max(16).optional(),
    bars: z
      .array(z.object({ label: z.string().min(1).max(40), value: z.number() }))
      .min(2)
      .max(8),
    sources: z.array(source).max(3).optional(),
    prominence: prominence.optional(),
  }),
};

export type TileKind = keyof typeof tileInputSchemas;
export type TileInput<K extends TileKind = TileKind> = z.infer<(typeof tileInputSchemas)[K]>;
export type TileSource = z.infer<typeof source>;
export type Prominence = z.infer<typeof prominence>;
export type StanceKind = z.infer<typeof stanceKind>;
export type Stance = TileInput<"positions">["stances"][number];

export interface TileImage {
  url: string;
  alt: string;
  pageUrl: string; // the page it came from (Wikipedia article or search result), shown as the credit
}

/** A tile as the agent (or mock) hands it to the board: input plus server-resolved media. */
export type TileDraft = {
  [K in TileKind]: TileInput<K> & { kind: K; image?: TileImage; link?: string };
}[TileKind];

/** A stance as published: the board remembers every distinct stance a speaker took on the topic. */
export type PublishedStance = Stance & { history: StanceKind[] }; // oldest first; last is current

type PublishedBody<K extends TileKind> = K extends "positions"
  ? Omit<TileInput<"positions">, "stances"> & { stances: PublishedStance[] }
  : TileInput<K>;

/** A tile as published to display clients. */
export type BoardTile = {
  [K in TileKind]: Omit<PublishedBody<K>, "prominence"> & {
    kind: K;
    prominence: Prominence;
    image?: TileImage;
    link?: string;
    updatedAt: number;
  };
}[TileKind];

export interface AgentStatus {
  state: "off" | "idle" | "thinking" | "error";
  task?: "update" | "reorganize"; // what a "thinking" agent is doing
  detail?: string; // why it is off / what failed
  model?: string;
  updatedAt: number;
}

export interface BoardState {
  tiles: BoardTile[]; // display order
  agent: AgentStatus;
}
