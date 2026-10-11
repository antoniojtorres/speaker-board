import { useSyncExternalStore } from "react";
import type { BoardState } from "../shared/board";
import type { BusEvent, SpeakerStat, Utterance } from "../shared/events";
import { BusClient } from "./bus";
import { SpeakerRegistry } from "./speakers";

export interface AppState {
  connected: boolean;
  session: { status: "connecting" | "ready" | "error" | "ended"; message?: string };
  /** Rows in first-seen order; a live row is updated in place until it goes final. */
  utterances: Utterance[];
  stats: SpeakerStat[];
  totalTurns: number;
  wpm: number;
  board: BoardState | null;
}

type AudioListener = (spectrum: number[]) => void;

// Committed rows kept for the conversation view (`?max=` overrides); live rows
// are never pruned.
const MAX_ROWS = Math.max(1, Number(new URLSearchParams(location.search).get("max") ?? 60));

/**
 * Turns the bus into React state. Everything except audio flows through
 * `useAppState`; audio arrives ~16 times a second and goes straight to the
 * ambient canvas through `onAudio`, so it never re-renders the page.
 */
class Store {
  private state: AppState = {
    connected: false,
    session: { status: "connecting" },
    utterances: [],
    stats: [],
    totalTurns: 0,
    wpm: 0,
    board: null,
  };
  private listeners = new Set<() => void>();
  private audioListeners = new Set<AudioListener>();

  constructor(
    bus: BusClient,
    private readonly speakers: SpeakerRegistry,
  ) {
    bus.on((e) => this.apply(e));
    bus.onStatus((connected) => this.set({ connected }));
  }

  getState = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  onAudio(fn: AudioListener): () => void {
    this.audioListeners.add(fn);
    return () => this.audioListeners.delete(fn);
  }

  private apply(e: BusEvent): void {
    switch (e.type) {
      case "audio":
        for (const fn of this.audioListeners) fn(e.spectrum);
        return;
      case "snapshot":
        this.set({
          utterances: e.utterances.reduce(upsertRow(this.speakers), this.state.utterances),
          stats: e.stats,
          totalTurns: e.totalTurns,
          wpm: e.wpm,
        });
        return;
      case "utterance":
        this.set({ utterances: upsertRow(this.speakers)(this.state.utterances, e.utterance) });
        return;
      case "opinion":
        this.set({ stats: e.stats, totalTurns: e.totalTurns, wpm: e.wpm });
        return;
      case "session":
        this.set({ session: { status: e.status, message: e.message } });
        return;
      case "board":
        this.set({ board: e.board });
        return;
    }
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
}

function upsertRow(speakers: SpeakerRegistry) {
  return (rows: Utterance[], u: Utterance): Utterance[] => {
    if (!u.text) return rows;
    speakers.register(u.speaker);
    const i = rows.findIndex((r) => r.id === u.id);
    const next = i === -1 ? [...rows, u] : rows.map((r, j) => (j === i ? u : r));
    return prune(next);
  };
}

function prune(rows: Utterance[]): Utterance[] {
  let excess = rows.filter((r) => r.state === "final").length - MAX_ROWS;
  if (excess <= 0) return rows;
  return rows.filter((r) => r.state !== "final" || excess-- <= 0);
}

export const speakers = new SpeakerRegistry();
export const store = new Store(new BusClient(), speakers);

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
