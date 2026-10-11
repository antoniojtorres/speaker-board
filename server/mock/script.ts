import type { Annotation, SpeakerId } from "../../src/shared/events";

export interface ScriptItem {
  atMs: number;
  turnOrder: number;
  speaker: SpeakerId;
  text: string;
  state: "live" | "final";
  annotations?: Annotation[];
}

// Deterministic conversation replayed by the mock adapter: three people debating
// whether the American Civil War was inevitable, with names, dates and numbers
// for the board to pick up. turnOrder 1 appears twice (live then final) — the
// same turn delivered incrementally — and turnOrder 3 is an unattributed
// backchannel. All other items are distinct turns: 13 finals (turnOrder 0-12).
export const SCRIPT: ScriptItem[] = [
  { atMs: 500, turnOrder: 0, speaker: "A", state: "final", text: "So was the Civil War actually inevitable, or could it have been avoided?" },
  { atMs: 3000, turnOrder: 1, speaker: "B", state: "live", text: "Honestly, once Lincoln won" },
  { atMs: 4200, turnOrder: 1, speaker: "B", state: "final", text: "Honestly, once Lincoln won in 1860, secession was basically guaranteed." },
  {
    atMs: 7000,
    turnOrder: 2,
    speaker: "C",
    state: "final",
    text: "I'm not sure. Slavery was the core issue, and compromise had held before, like in 1850.",
    annotations: [{ kind: "tag", payload: { label: "topic: causes" }, tStart: 7000 }],
  },
  { atMs: 9500, turnOrder: 3, speaker: "UNKNOWN", state: "final", text: "Mm-hm." },
  { atMs: 11000, turnOrder: 4, speaker: "A", state: "final", text: "But the Fugitive Slave Act is exactly what made that compromise fall apart." },
  { atMs: 14000, turnOrder: 5, speaker: "B", state: "final", text: "And the North had something like twenty-two million people against nine million in the South." },
  { atMs: 17000, turnOrder: 6, speaker: "C", state: "final", text: "Grant's memoirs say as much, but he's hardly a neutral witness." },
  { atMs: 20000, turnOrder: 7, speaker: "A", state: "final", text: "What about Lee? People still argue about whether he was a reluctant rebel." },
  { atMs: 23000, turnOrder: 8, speaker: "B", state: "final", text: "He chose Virginia over the Union. That was a choice, not fate." },
  { atMs: 26000, turnOrder: 9, speaker: "C", state: "final", text: "Gettysburg in July 1863 is where it really turned, I think." },
  { atMs: 29000, turnOrder: 10, speaker: "A", state: "final", text: "And the Emancipation Proclamation that January changed what the war was about." },
  { atMs: 32000, turnOrder: 11, speaker: "B", state: "final", text: "By Appomattox in April 1865 the outcome was obvious." },
  { atMs: 35000, turnOrder: 12, speaker: "C", state: "final", text: "So maybe the war wasn't inevitable, but once it started, the result was." },
];

// Loop offset (> last atMs + word tail) so the installation keeps moving.
export const SCRIPT_SPAN_MS = 40000;
