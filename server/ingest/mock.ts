import type { SpeakerId, Utterance, Word } from "../../src/shared/events";
import type { EventBus } from "../bus";
import type { IngestAdapter } from "./types";
import type { ScriptItem } from "../mock/script";
import { SCRIPT, SCRIPT_SPAN_MS } from "../mock/script";
import { SPECTRUM_BINS } from "./spectrum";

/**
 * Replays the deterministic SCRIPT on a loop with no audio device. Each loop uses
 * unique utterance ids (`mock:<loop>:<turnOrder>`) so committed rows accumulate and
 * prune rather than upsert in place. Also emits a synthetic audio level so the
 * ambient layer animates deterministically.
 */
export class MockIngestAdapter implements IngestAdapter {
  private bus!: EventBus;
  private timers = new Set<NodeJS.Timeout>();
  private audioTimer: NodeJS.Timeout | null = null;
  private loopTimer: NodeJS.Timeout | null = null;
  private loop = 0;
  private active: { until: number; speaker: SpeakerId } | null = null;
  private rms = 0.15;

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    bus.publish({ type: "session", status: "ready" });
    this.scheduleLoop(0);
    this.loopTimer = setInterval(() => this.scheduleLoop(++this.loop), SCRIPT_SPAN_MS);
    this.audioTimer = setInterval(() => this.tickAudio(), 60);
  }

  private scheduleLoop(loop: number): void {
    const offset = loop * SCRIPT_SPAN_MS;
    for (const item of SCRIPT) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.emit(item, loop, offset);
      }, item.atMs);
      this.timers.add(t);
    }
  }

  private emit(item: ScriptItem, loop: number, offset: number): void {
    const words: Word[] = item.text.split(" ").map((text, i) => {
      const start = item.atMs + offset + i * 350;
      return { text, start, end: start + 300, speaker: item.speaker };
    });
    const utterance: Utterance = {
      id: `mock:${loop}:${item.turnOrder}`,
      turnOrder: item.turnOrder,
      speaker: item.speaker,
      text: item.text,
      words,
      tStart: words[0].start,
      tEnd: words[words.length - 1].end,
      state: item.state,
      annotations: item.annotations ?? [],
    };
    if (item.state === "final") {
      this.active = { until: Date.now() + 700, speaker: item.speaker };
    }
    this.bus.publish({ type: "utterance", utterance });
  }

  private tickAudio(): void {
    const target = this.active && Date.now() < this.active.until ? 0.7 : 0.15;
    this.rms = this.rms * 0.9 + target * 0.1;
    this.bus.publish({
      type: "audio",
      rms: this.rms,
      activeSpeaker: this.active?.speaker,
      spectrum: mockSpectrum(this.rms, Date.now()),
    });
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.audioTimer) clearInterval(this.audioTimer);
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.audioTimer = null;
    this.loopTimer = null;
  }
}

/** Speech-shaped stand-in for the real analyzer: energy concentrated in the low
 * bins, scaled by the synthetic level, with a slow shimmer so it reads as alive. */
function mockSpectrum(rms: number, nowMs: number): number[] {
  return Array.from({ length: SPECTRUM_BINS }, (_, k) => {
    const shimmer = 0.85 + 0.15 * Math.sin(nowMs / 180 + k * 0.7);
    return Math.round(255 * Math.min(1, 1.3 * rms * Math.exp(-k / 16) * shimmer));
  });
}
