import { WebSocket } from "ws";
import type { BusEvent, SpeakerStat, Utterance } from "../src/shared/events";

const MAX_UTTERANCES = 200;

/**
 * Server-authoritative event bus. Broadcasts JSON events to every connected
 * display client, notifies in-process subscribers (e.g. the analyzer), and keeps
 * a small ring buffer of recent finals + latest stats so a newly-connected or
 * reconnecting client is re-synced immediately via a `snapshot`, followed by the
 * latest `board`.
 */
export class EventBus {
  private clients = new Set<WebSocket>();
  private subscribers = new Set<(e: BusEvent) => void>();
  private recent: Utterance[] = [];
  private stats: SpeakerStat[] = [];
  private totalTurns = 0;
  private wpm = 0;
  private board: BusEvent | null = null;

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    this.sendTo(ws, {
      type: "snapshot",
      utterances: this.recent,
      stats: this.stats,
      totalTurns: this.totalTurns,
      wpm: this.wpm,
    });
    if (this.board) this.sendTo(ws, this.board);
  }

  subscribe(fn: (e: BusEvent) => void): void {
    this.subscribers.add(fn);
  }

  publish(e: BusEvent): void {
    if (e.type === "utterance" && e.utterance.state === "final") {
      this.recent.push(e.utterance);
      if (this.recent.length > MAX_UTTERANCES) this.recent.shift();
    } else if (e.type === "opinion") {
      this.stats = e.stats;
      this.totalTurns = e.totalTurns;
      this.wpm = e.wpm;
    } else if (e.type === "board") {
      this.board = e;
    }
    const data = JSON.stringify(e);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
    for (const fn of this.subscribers) fn(e);
  }

  private sendTo(ws: WebSocket, e: BusEvent): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  }
}
