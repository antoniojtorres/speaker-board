import type { BusEvent } from "../shared/events";

type Handler = (e: BusEvent) => void;
type StatusHandler = (connected: boolean) => void;

/** Connects to the server event bus and re-syncs via the connect-time snapshot. */
export class BusClient {
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<StatusHandler>();
  private backoffMs = 1000;
  private ws: WebSocket | null = null;
  private reconnectTimer = 0;

  constructor(private readonly path = "/bus") {
    this.connect();
  }

  on(fn: Handler): void {
    this.handlers.add(fn);
  }

  onStatus(fn: StatusHandler): void {
    this.statusHandlers.add(fn);
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${this.path}`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.backoffMs = 1000;
      for (const fn of this.statusHandlers) fn(true);
    });
    ws.addEventListener("message", (ev) => {
      let e: BusEvent;
      try {
        e = JSON.parse(ev.data as string) as BusEvent;
      } catch {
        return;
      }
      for (const fn of this.handlers) fn(e);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const fn of this.statusHandlers) fn(false);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 10000);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }
}
