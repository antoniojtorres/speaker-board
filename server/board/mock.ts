import type { TileDraft, TileInput, TileKind } from "../../src/shared/board";
import type { Board } from "./board";
import * as wiki from "./wikipedia";

type MockTile = { [K in TileKind]: TileInput<K> & { kind: K } }[TileKind];

const wikiUrl = (title: string): string => `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}`;

const debate = (aStance: "undecided" | "mixed", aPoints: string[]): MockTile => ({
  kind: "positions",
  id: "inevitable",
  topic: "Was the Civil War inevitable?",
  tone: "lively",
  prominence: "featured",
  stances: [
    {
      speaker: "B",
      stance: "for",
      summary: "Lincoln's 1860 win made secession all but certain.",
      points: ["Secession followed the 1860 election", "The North had 22M people to the South's 9M"],
      quote: "secession was basically guaranteed",
    },
    {
      speaker: "C",
      stance: "against",
      summary: "Compromise had held before; the war was avoidable, only its outcome wasn't.",
      points: ["The 1850 compromise held for a decade", "Grant's memoirs aren't neutral evidence"],
      quote: "once it started, the result was",
    },
    {
      speaker: "A",
      stance: aStance,
      summary:
        aStance === "mixed"
          ? "The Fugitive Slave Act broke the compromise, but people still made choices."
          : "Asking the question; hasn't taken a side yet.",
      points: aPoints,
    },
  ],
});

// A finished board for the mock conversation (server/mock/script.ts), built up
// tile by tile so the UI's arrival animation and layout can be judged without
// an API key. The debate opens featured, and its last step shifts a stance.
const TILES: MockTile[] = [
  debate("undecided", []),
  {
    kind: "person",
    id: "grant",
    name: "Ulysses S. Grant",
    role: "Union general; 18th U.S. president",
    summary: "Led the Union to victory; his memoirs came up as a partisan account of the war's causes.",
    wikipedia: "Ulysses S. Grant",
  },
  {
    kind: "person",
    id: "lee",
    name: "Robert E. Lee",
    role: "Confederate general",
    summary: "Chose Virginia over the Union in 1861 — debated as reluctant rebel or deliberate choice.",
    wikipedia: "Robert E. Lee",
  },
  {
    kind: "timeline",
    id: "road-to-appomattox",
    title: "From compromise to surrender",
    events: [
      { when: "Sep 1850", label: "Compromise of 1850, incl. Fugitive Slave Act" },
      { when: "Nov 1860", label: "Lincoln elected president" },
      { when: "Apr 1861", label: "Fort Sumter; war begins" },
      { when: "Jan 1863", label: "Emancipation Proclamation takes effect" },
      { when: "Jul 1863", label: "Battle of Gettysburg" },
      { when: "Apr 1865", label: "Lee surrenders at Appomattox" },
    ],
  },
  {
    kind: "chart",
    id: "population-1860",
    title: "Population, 1860",
    unit: "millions",
    prominence: "minor",
    bars: [
      { label: "Union states", value: 22.1 },
      { label: "Confederate states", value: 9.1 },
    ],
    sources: [{ title: "1860 United States census", url: wikiUrl("1860 United States census") }],
  },
  {
    kind: "fact",
    id: "emancipation",
    headline: "The war's purpose changed in 1863",
    body: "The Emancipation Proclamation declared enslaved people in Confederate states free, making abolition a Union war aim.",
    wikipedia: "Emancipation Proclamation",
  },
  {
    kind: "quote",
    id: "result-quote",
    speaker: "C",
    text: "So maybe the war wasn't inevitable, but once it started, the result was.",
    note: "Separates the war's cause from its outcome",
  },
  debate("mixed", ["The Fugitive Slave Act broke the 1850 compromise", "Lee chose Virginia; that was a choice"]),
];

/** Plays the mock board onto `board`; returns a stop function. */
export function startMockBoard(board: Board, intervalMs = 2500): () => void {
  board.setAgent({ state: "thinking", model: "mock", detail: "mock board" });
  const timers = TILES.map((tile, i) =>
    setTimeout(async () => {
      const page = "wikipedia" in tile && tile.wikipedia ? await wiki.lookup(tile.wikipedia).catch(() => null) : null;
      board.put({ ...tile, image: page?.image, link: page?.url } as TileDraft);
      if (i === TILES.length - 1) board.setAgent({ state: "idle", model: "mock", detail: "mock board" });
    }, (i + 1) * intervalMs),
  );
  return () => timers.forEach(clearTimeout);
}
