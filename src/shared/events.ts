// The whole system's contract. Imported by both server and client.
// Do not redefine these shapes elsewhere.

import type { BoardState } from "./board";

export type SpeakerId = string; // "A","B",... or "UNKNOWN"

export interface Word {
  text: string;
  start: number; // ms
  end: number; // ms
  speaker?: SpeakerId; // present only on final words; may be absent
}

export interface Annotation {
  kind: "image" | "tag" | "sentiment" | "link";
  payload: unknown;
  tStart: number;
}

export interface Utterance {
  id: string; // `${sessionId}:${turnOrder}` (real) | `mock:${turnOrder}` (mock)
  turnOrder: number;
  speaker: SpeakerId; // turn-level; "UNKNOWN" allowed
  text: string;
  words: Word[];
  tStart: number; // ms since session start
  tEnd: number; // ms since session start
  state: "live" | "final"; // live = end_of_turn:false; final = end_of_turn:true
  annotations: Annotation[]; // [] in v1 except the mock-tagged utterance
}

export interface SpeakerStat {
  speaker: SpeakerId;
  words: number;
  turns: number;
  talkMs: number;
}

export type BusEvent =
  | { type: "utterance"; utterance: Utterance }
  | {
      type: "audio";
      rms: number;
      activeSpeaker?: SpeakerId;
      spectrum: number[]; // 64 bytes (0-255), low → high frequency; see server/ingest/spectrum.ts
    }
  | {
      type: "opinion";
      kind: "stats";
      stats: SpeakerStat[];
      totalTurns: number;
      wpm: number;
    }
  | { type: "session"; status: "ready" | "error" | "ended"; message?: string }
  // The whole board on every change: it is a dozen tiles at most, so clients
  // replace rather than patch, and a reconnect needs no replay.
  | { type: "board"; board: BoardState }
  | {
      type: "snapshot";
      utterances: Utterance[];
      stats: SpeakerStat[];
      totalTurns: number;
      wpm: number;
    };
