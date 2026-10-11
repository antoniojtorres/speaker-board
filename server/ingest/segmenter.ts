import type { SpeakerId, Utterance, Word } from "../../src/shared/events";

// AssemblyAI stamps these on finalized words whose diarization isn't resolved yet.
// They are not speakers — fold them into the surrounding run.
export const NON_SPEAKER = new Set(["UNKNOWN", "PENDING"]);

// Lane for words whose speaker never resolved. Already neutral in the renderer
// (grey, no name, no palette slot) and excluded from per-speaker stats.
export const PROVISIONAL: SpeakerId = "UNKNOWN";

export interface SegmenterOptions {
  debounceMs: number;
  sessionId: () => string;
  emit: (u: Utterance) => void;
  log?: (record: Record<string, unknown>) => void;
}

export function commitDebounceMs(): number {
  return Number(process.env.COMMIT_DEBOUNCE_MS ?? process.env.BUCKET_DEBOUNCE_MS ?? 900);
}

interface Run {
  id: string;
  order: number;
  speaker: SpeakerId;
  words: Word[];
  provisional: boolean; // speaker is PROVISIONAL, still open to adoption
}

/**
 * Turns AssemblyAI's word-level speaker labels into an ordered, contiguous
 * timeline: consecutive words from the same speaker coalesce into one row, and a
 * new row starts the moment the speaker changes — so an A→B→A exchange renders as
 * three chronological rows, never one lumped line and never a merged A row.
 *
 * Words whose label is unresolved ("UNKNOWN"/"PENDING") or missing fold into the
 * current run (seeded from the turn's dominant speaker for the first word), so
 * not-yet-attributed words never spawn a phantom speaker lane. When nothing has
 * resolved yet — AssemblyAI can label a whole turn "PENDING", and never revises
 * it — the run opens in the neutral PROVISIONAL lane and adopts the first real
 * label that arrives while it is still streaming.
 *
 * The current run streams as a live row and commits (final) when the speaker
 * changes or after `debounceMs` of silence.
 */
export class TranscriptSegmenter {
  private current: Run | null = null;
  private consumed = new Set<number>(); // word.start keys already placed (dedup across repeats)
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SegmenterOptions) {}

  /** Feed finalized words from a Turn; `turnSpeaker` seeds attribution for leading unresolved words. */
  ingest(words: Word[], turnSpeaker?: SpeakerId): void {
    const seed = turnSpeaker && !NON_SPEAKER.has(turnSpeaker) ? turnSpeaker : null;
    for (const w of words) {
      if (this.consumed.has(w.start)) continue;
      const labeled = w.speaker && !NON_SPEAKER.has(w.speaker) ? w.speaker : null;
      // Fall back down the chain: the word's own label, the open run, the turn's
      // dominant speaker, then the neutral lane. Never drop the word — an
      // unattributed word is still something that was said.
      const speaker = labeled ?? this.current?.speaker ?? seed ?? PROVISIONAL;
      this.consumed.add(w.start);
      let action: string;
      if (this.current?.provisional && labeled) {
        // Diarization caught up mid-run: relabel the open run in place, so one
        // sentence never splits across a neutral row and a speaker row.
        this.current.speaker = labeled;
        this.current.provisional = false;
        this.current.words.push(w);
        action = "adopt";
      } else if (this.current && this.current.speaker === speaker) {
        this.current.words.push(w);
        action = labeled ? "append" : "fold";
      } else {
        if (this.current) this.commit();
        this.current = { id: `${this.opts.sessionId()}:${this.seq}`, order: this.seq, speaker, words: [w], provisional: !labeled };
        this.seq++;
        action = "new_run";
      }
      this.opts.log?.({ scope: "segmenter", event: "word", action, start: w.start, text: w.text, rawSpeaker: w.speaker ?? null, resolved: speaker, runId: this.current.id });
      this.publish("live");
      this.restartTimer();
    }
  }

  /** Commit the open run immediately (e.g. on session stop). */
  flushAll(): void {
    this.commit();
  }

  private restartTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.commit(), this.opts.debounceMs);
  }

  private commit(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.current) return;
    this.opts.log?.({ scope: "segmenter", event: "commit", id: this.current.id, speaker: this.current.speaker, wordCount: this.current.words.length, text: this.current.words.map((w) => w.text).join(" ") });
    this.publish("final");
    this.current = null;
  }

  private publish(state: "live" | "final"): void {
    const r = this.current;
    if (!r) return;
    this.opts.emit({
      id: r.id,
      turnOrder: r.order,
      speaker: r.speaker,
      text: r.words.map((w) => w.text).join(" "),
      words: r.words.slice(),
      tStart: r.words[0].start,
      tEnd: r.words[r.words.length - 1].end,
      state,
      annotations: [],
    });
  }
}
