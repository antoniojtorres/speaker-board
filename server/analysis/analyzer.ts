import type { BusEvent, SpeakerId, SpeakerStat, Utterance } from "../../src/shared/events";

/**
 * Consumes finalized utterances and emits derived bus events.
 *
 * v1 = MetricsAnalyzer (pure metrics, no model). The extension seam: a future
 * `LlmAnalyzer implements Analyzer` returns `annotation`-bearing events keyed by
 * utterance id (images, tags, sentiment). The renderer already consumes them, so
 * adding it touches neither the ingest path nor the render path. No LLM in v1.
 */
export interface Analyzer {
  onFinal(u: Utterance): BusEvent[];
}

export class MetricsAnalyzer implements Analyzer {
  private stats = new Map<SpeakerId, SpeakerStat>();
  private totalTurns = 0;
  private totalWords = 0;
  private readonly startMs = Date.now();

  onFinal(u: Utterance): BusEvent[] {
    this.totalTurns += 1;
    const wordCount = u.words.length || u.text.split(" ").length;
    this.totalWords += wordCount;

    // UNKNOWN turns count toward totals/WPM but never get a per-speaker lane.
    if (u.speaker !== "UNKNOWN") {
      const s = this.stats.get(u.speaker) ?? { speaker: u.speaker, words: 0, turns: 0, talkMs: 0 };
      s.words += wordCount;
      s.turns += 1;
      s.talkMs += Math.max(0, u.tEnd - u.tStart);
      this.stats.set(u.speaker, s);
    }

    const elapsedMin = Math.max((Date.now() - this.startMs) / 60000, 1 / 60);
    const wpm = this.totalWords / elapsedMin;
    const stats = [...this.stats.values()].sort((a, b) => b.talkMs - a.talkMs);
    return [{ type: "opinion", kind: "stats", stats, totalTurns: this.totalTurns, wpm }];
  }
}
