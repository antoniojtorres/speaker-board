import { readFileSync } from "node:fs";
import { TranscriptSegmenter, NON_SPEAKER } from "../server/ingest/segmenter.js";
import type { Word } from "../src/shared/events.js";

// Usage: npx tsx scripts/analyze-log.mts <path-to-jsonl>
const file = process.argv[2];
if (!file) {
  console.error("usage: npx tsx scripts/analyze-log.mts <debug.jsonl>");
  process.exit(1);
}

interface WordRec {
  text: string;
  start: number;
  end: number;
  final: boolean;
  speaker: string | null;
}
interface Rec {
  ts: number;
  event: string;
  scope?: string;
  [k: string]: unknown;
}

const records: Rec[] = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    records.push(JSON.parse(line) as Rec);
  } catch {
    /* skip malformed */
  }
}

const config = records.find((r) => r.event === "config");
const turns = records.filter((r) => r.event === "aai_turn");
const segmenterCommits = records.filter((r) => r.scope === "segmenter" && r.event === "commit");
const bucketerFlushes = records.filter((r) => r.scope === "bucketer" && r.event === "flush");
const segmenterWords = records.filter((r) => r.scope === "segmenter" && r.event === "word");
const bucketWords = records.filter((r) => r.scope === "bucketer" && r.event === "word");

// Latest complete message per turn_order (prefer end_of_turn:true).
const byTurn = new Map<number, Rec>();
for (const t of turns) {
  const id = t.turn_order as number;
  const prev = byTurn.get(id);
  if (!prev || t.end_of_turn === true || (t.words as WordRec[]).length >= (prev.words as WordRec[]).length) {
    byTurn.set(id, t);
  }
}

const runsOf = (words: WordRec[]): string => {
  const parts: string[] = [];
  for (const w of words) {
    const s = w.speaker ?? "∅";
    const last = parts[parts.length - 1];
    if (last && last.startsWith(s + "×")) {
      parts[parts.length - 1] = `${s}×${Number(last.split("×")[1]) + 1}`;
    } else {
      parts.push(`${s}×1`);
    }
  }
  return parts.join(" ");
};

const isRealSpeaker = (s: string | null | undefined): s is string =>
  Boolean(s && !NON_SPEAKER.has(s));

const turnLevelSpeakers = new Set<string>();
const wordLevelSpeakers = new Set<string>();
const distinctPerTurn: number[] = [];

console.log("=== CONFIG ===");
console.log(JSON.stringify(config ?? {}, null, 2));

console.log("\n=== FINALIZED TURNS (turn_order: [turn_label] distinctWordSpeakers | runs) ===");
for (const [id, t] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
  const words = (t.words as WordRec[]).filter((w) => w.final);
  const label = (t.speaker_label as string | null) ?? "∅";
  if (isRealSpeaker(label)) turnLevelSpeakers.add(label);
  const distinct = new Set<string>();
  for (const w of words) {
    if (isRealSpeaker(w.speaker)) {
      wordLevelSpeakers.add(w.speaker);
      distinct.add(w.speaker);
    }
  }
  distinctPerTurn.push(distinct.size);
  console.log(
    `#${id} [${label}] end=${t.end_of_turn} wordSpeakers=${distinct.size} | ${runsOf(words)}\n    "${t.transcript as string}"`,
  );
}

const hist = new Map<number, number>();
for (const n of distinctPerTurn) hist.set(n, (hist.get(n) ?? 0) + 1);

console.log("\n=== SUMMARY ===");
console.log("turn-level speaker labels seen:", [...turnLevelSpeakers].sort());
console.log("word-level speaker labels seen (excl PENDING/UNKNOWN):", [...wordLevelSpeakers].sort());
console.log("finalized turns:", byTurn.size);
console.log("distinct-word-speakers-per-turn histogram:", Object.fromEntries([...hist.entries()].sort()));
console.log(
  "turns with >1 word speaker (splittable):",
  distinctPerTurn.filter((n) => n > 1).length,
  "| single-speaker turns (lumped by AAI):",
  distinctPerTurn.filter((n) => n <= 1).length,
);

if (segmenterCommits.length > 0) {
  console.log("\n=== SEGMENTER COMMITS (rows we rendered) ===");
  for (const c of segmenterCommits) {
    console.log(`${c.id as string} [${c.speaker as string}] (${c.wordCount as number}w) "${c.text as string}"`);
  }
  const foldCount = segmenterWords.filter((w) => w.action === "fold").length;
  const noTarget = segmenterWords.filter((w) => w.action === "no_target_skip").length;
  console.log("\nsegmenter: commits:", segmenterCommits.length, "| pending/unknown-folds:", foldCount, "| no-target-skips:", noTarget);
} else if (bucketerFlushes.length > 0) {
  console.log("\n=== BUCKETER FLUSHES (legacy log — rows we rendered) ===");
  for (const f of bucketerFlushes) {
    console.log(`${f.id as string} [${f.speaker as string}] (${f.wordCount as number}w) "${f.text as string}"`);
  }
  const foldCount = bucketWords.filter((w) => w.action === "fold_unknown").length;
  const noTarget = bucketWords.filter((w) => w.action === "no_target_skip").length;
  console.log("\nbucketer: flushes:", bucketerFlushes.length, "| unknown-folds:", foldCount, "| no-target-skips:", noTarget);
}

// Replay all Turn messages through the segmenter to preview what the new pipeline would emit.
const simulated: Array<{ id: string; speaker: string; wordCount: number; text: string }> = [];
const debounceMs = Number(config?.debounce_ms ?? 900);
const seg = new TranscriptSegmenter({
  debounceMs,
  sessionId: () => "sim",
  emit: (u) => {
    if (u.state === "final") {
      simulated.push({ id: u.id, speaker: u.speaker, wordCount: u.words.length, text: u.text });
    }
  },
});
for (const t of [...turns].sort((a, b) => a.ts - b.ts)) {
  const finalWords: Word[] = (t.words as WordRec[])
    .filter((w) => w.final)
    .map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker ?? undefined }));
  seg.ingest(finalWords, (t.speaker_label as string | undefined) ?? undefined);
}
seg.flushAll();

console.log(`\n=== SIMULATED SEGMENTER OUTPUT (replay @ ${debounceMs}ms debounce) ===`);
for (const row of simulated) {
  console.log(`${row.id} [${row.speaker}] (${row.wordCount}w) "${row.text}"`);
}
console.log(`\nsegmenter simulation: ${simulated.length} rows from ${turns.length} turn messages`);
