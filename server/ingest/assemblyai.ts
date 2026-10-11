import { WebSocket } from "ws";
import type { PvRecorder } from "@picovoice/pvrecorder-node";
import type { SpeakerId, Word } from "../../src/shared/events";
import type { EventBus } from "../bus";
import type { IngestAdapter } from "./types";
import { TranscriptSegmenter, NON_SPEAKER, commitDebounceMs } from "./segmenter";
import { SPECTRUM_BINS, spectrum } from "./spectrum";
import type { DebugLogger } from "../debug";

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 800; // ~50ms @ 16kHz
const SILENCE_RMS = 0.0005; // below this the capture is effectively dead air
const SILENCE_REPORT_MS = 10_000; // how long of it to tolerate before warning

interface AaiWord {
  text: string;
  start: number;
  end: number;
  speaker?: string;
  word_is_final?: boolean;
}
interface AaiTurn {
  type: "Turn";
  turn_order: number;
  end_of_turn: boolean;
  transcript: string;
  speaker_label?: string;
  words?: AaiWord[];
}
type AaiMessage =
  | AaiTurn
  | { type: "Begin"; id: string }
  | { type: "Termination" | "SpeakerRevision"; [k: string]: unknown };

/**
 * Picks the capture device. A plugged-in USB mic wins over the built-in one, so
 * the installation upgrades itself just by being plugged in and degrades to the
 * laptop mic when it is not.
 *
 * Matching is by name, not index: PvRecorder numbers devices by position, so
 * indices shift whenever anything is plugged or unplugged and a pinned number
 * silently starts meaning a different mic. `AUDIO_DEVICE_INDEX` stays available
 * as an explicit override, and -1 means "whatever macOS calls the default".
 */
export function selectDevice(
  devices: string[],
  env: NodeJS.ProcessEnv = process.env,
): { index: number; reason: string } {
  const pinned = env.AUDIO_DEVICE_INDEX?.trim();
  if (pinned) {
    const i = Number(pinned);
    if (Number.isInteger(i) && i >= -1 && i < devices.length) {
      return { index: i, reason: `AUDIO_DEVICE_INDEX=${i}` };
    }
    console.warn(`mic: AUDIO_DEVICE_INDEX=${pinned} is not a device here; falling back to auto-select`);
  }
  // An empty AUDIO_DEVICE_MATCH in .env reads as "" rather than undefined, so
  // treat blank as unset instead of as "match nothing".
  const match = (env.AUDIO_DEVICE_MATCH?.trim() || "usb").toLowerCase();
  const i = devices.findIndex((d) => d.toLowerCase().includes(match));
  if (i !== -1) return { index: i, reason: `matched "${match}"` };
  return { index: -1, reason: "system default input" };
}

/**
 * Real-time transcription + diarization via AssemblyAI streaming (v3). Captures
 * the mic server-side (PvRecorder), streams 16kHz PCM16, normalizes `Turn`
 * messages into `Utterance` events, and reconnects with backoff. Sends a
 * `Terminate` on stop so sessions are not billed for the full idle window.
 */
export class AssemblyAiAdapter implements IngestAdapter {
  private bus!: EventBus;
  private ws: WebSocket | null = null;
  private recorder: PvRecorder | null = null;
  private sessionId = "session";
  private lastSpeaker: SpeakerId | undefined;
  private running = false;
  private backoffMs = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private rms = 0;
  private spectrum: number[] = new Array<number>(SPECTRUM_BINS).fill(0);
  private rmsTimer: NodeJS.Timeout | null = null;
  private segmenter: TranscriptSegmenter | null = null;
  private pumping = false;
  private framesSent = 0;
  private windowPeak = 0;
  private micEverLive = false;
  private levelTimer: NodeJS.Timeout | null = null;

  constructor(private readonly debug: DebugLogger) {}

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    const key = process.env.ASSEMBLYAI_API_KEY;
    if (!key) {
      throw new Error("ASSEMBLYAI_API_KEY is not set (required for INGEST=assemblyai)");
    }
    this.running = true;

    // Platform-specific native addon (Apple Silicon mic capture). Loaded lazily so
    // mock mode never touches the native binding.
    const { PvRecorder: Recorder } = await import("@picovoice/pvrecorder-node");
    const devices = Recorder.getAvailableDevices();
    const { index: deviceIndex, reason } = selectDevice(devices);
    this.recorder = new Recorder(FRAME_LENGTH, deviceIndex);
    this.recorder.start();
    // Which mic we actually opened is the first thing to check when nothing
    // transcribes, so say it out loud rather than burying it in the debug log.
    console.log(`mic: ${this.recorder.getSelectedDevice()} (${reason})`);
    devices.forEach((d, i) => console.log(`  [${i}] ${d}`));

    this.rmsTimer = setInterval(() => {
      this.bus.publish({
        type: "audio",
        rms: this.rms,
        activeSpeaker: this.lastSpeaker,
        spectrum: this.spectrum,
      });
    }, 60);
    this.levelTimer = setInterval(() => this.reportLevel(), SILENCE_REPORT_MS);
    this.segmenter = new TranscriptSegmenter({
      debounceMs: commitDebounceMs(),
      sessionId: () => this.sessionId,
      emit: (u) => this.bus.publish({ type: "utterance", utterance: u }),
      log: (rec) => this.debug.log(rec),
    });
    this.debug.log({
      event: "config",
      speech_model: process.env.SPEECH_MODEL ?? "universal-3-6-pro",
      max_speakers: process.env.MAX_SPEAKERS ?? null,
      debounce_ms: commitDebounceMs(),
      sample_rate: SAMPLE_RATE,
      endpoint: this.buildEndpoint(),
      device: this.recorder.getSelectedDevice(),
      device_index: deviceIndex,
      device_reason: reason,
      devices,
    });

    this.connect(key);
  }

  private buildEndpoint(): string {
    const params = new URLSearchParams({
      sample_rate: String(SAMPLE_RATE),
      speech_model: process.env.SPEECH_MODEL ?? "universal-3-6-pro",
      speaker_labels: "true",
    });
    if (process.env.MAX_SPEAKERS) {
      params.set("max_speakers", String(Number(process.env.MAX_SPEAKERS)));
    }
    return `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
  }

  private connect(key: string): void {
    const ws = new WebSocket(this.buildEndpoint(), { headers: { Authorization: key } });
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 1000;
      this.bus.publish({ type: "session", status: "ready" });
      void this.pump(ws);
    });
    ws.on("message", (data: Buffer) => this.onMessage(data.toString()));
    ws.on("error", (err: Error) => {
      // A silent socket used to be indistinguishable from a silent mic; both
      // ends of the stream now report themselves.
      console.error(`assemblyai: socket error: ${err.message}`);
      this.debug.log({ event: "ws_error", message: err.message });
      this.bus.publish({ type: "session", status: "error", message: err.message });
    });
    ws.on("close", (code: number, reason: Buffer) => {
      const why = reason.toString() || "no reason given";
      this.debug.log({ event: "ws_close", code, reason: why, willReconnect: this.running });
      if (this.running) {
        console.warn(`assemblyai: socket closed (${code}: ${why}); reconnecting in ${this.backoffMs}ms`);
        this.scheduleReconnect(key);
      }
    });
  }

  private async pump(ws: WebSocket): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    // One reader only: a reconnect must not start a second loop while the first
    // is still parked in `recorder.read()`, or the two split the frames between
    // them and every other 50ms of audio goes to a dead socket.
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running && ws.readyState === WebSocket.OPEN) {
        const frame = await recorder.read(); // Int16Array
        this.rms = frameRms(frame);
        this.spectrum = spectrum(frame);
        if (this.rms > this.windowPeak) this.windowPeak = this.rms;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
          this.framesSent++;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`mic: capture stopped: ${message}`);
      this.debug.log({ event: "pump_error", message });
      this.bus.publish({ type: "session", status: "error", message });
    } finally {
      this.pumping = false;
      // Go quiet rather than freezing the visual on the last frame heard.
      this.rms = 0;
      this.spectrum = new Array<number>(SPECTRUM_BINS).fill(0);
    }
  }

  /** Periodic mic-level report: dead air here means nothing can ever transcribe. */
  private reportLevel(): void {
    const peak = this.windowPeak;
    const frames = this.framesSent;
    this.windowPeak = 0;
    this.framesSent = 0;
    this.debug.log({ event: "mic_level", peak_rms: peak, frames_sent: frames });
    if (peak >= SILENCE_RMS) {
      if (!this.micEverLive) {
        console.log(`mic: live (peak rms ${peak.toFixed(4)})`);
        this.micEverLive = true;
      }
      return;
    }
    if (frames === 0) {
      console.warn("mic: no frames reaching AssemblyAI — capture or socket is down");
      return;
    }
    console.warn(
      `mic: silent for ${SILENCE_REPORT_MS / 1000}s (peak rms ${peak.toFixed(4)}, ${frames} frames sent). ` +
        "Check System Settings → Privacy & Security → Microphone for your terminal app, " +
        "and that the right input device is selected (AUDIO_DEVICE_INDEX).",
    );
  }

  private onMessage(raw: string): void {
    this.debug.log({ event: "aai_raw", raw });
    let msg: AaiMessage;
    try {
      msg = JSON.parse(raw) as AaiMessage;
    } catch {
      this.debug.log({ event: "parse_error", raw });
      return;
    }
    if (msg.type === "Begin") {
      this.sessionId = msg.id;
      this.debug.log({ event: "begin", id: msg.id });
      return;
    }
    // future: apply SpeakerRevision to recolor still-visible nodes by turn_order.
    if (msg.type !== "Turn") {
      this.debug.log({ event: "other", messageType: msg.type });
      return;
    }

    const turn = msg;
    this.debug.log({
      event: "aai_turn",
      turn_order: turn.turn_order,
      end_of_turn: turn.end_of_turn,
      speaker_label: turn.speaker_label ?? null,
      transcript: turn.transcript,
      words: (turn.words ?? []).map((w) => ({
        text: w.text,
        start: w.start,
        end: w.end,
        final: Boolean(w.word_is_final),
        speaker: w.speaker ?? null,
      })),
    });
    // Track the dominant speaker so the ambient layer tints to whoever is active.
    if (turn.speaker_label && !NON_SPEAKER.has(turn.speaker_label)) {
      this.lastSpeaker = turn.speaker_label;
    }
    // Only finalized words carry reliable speaker labels; segment those by contiguous speaker.
    const finalWords: Word[] = (turn.words ?? [])
      .filter((w) => w.word_is_final)
      .map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker }));
    this.segmenter?.ingest(finalWords, turn.speaker_label);
  }

  private scheduleReconnect(key: string): void {
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.connect(key);
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, 10000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.rmsTimer) {
      clearInterval(this.rmsTimer);
      this.rmsTimer = null;
    }
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.segmenter?.flushAll();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Terminate" }));
      this.ws.close();
    }
    this.ws = null;
    if (this.recorder) {
      try {
        this.recorder.stop();
        this.recorder.release();
      } catch {
        /* ignore */
      }
      this.recorder = null;
    }
    this.bus.publish({ type: "session", status: "ended" });
  }
}

function frameRms(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}
