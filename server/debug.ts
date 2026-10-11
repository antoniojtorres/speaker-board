import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL debug log. One JSON object per line, each stamped with `ts`
 * (ms). Uses synchronous appends so nothing is lost if the process is Ctrl+C'd
 * mid-session. Disabled (no-op) when constructed with a null path.
 */
export class DebugLogger {
  constructor(private readonly file: string | null) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      this.log({ event: "session_start", pid: process.pid });
    }
  }

  log(record: Record<string, unknown>): void {
    if (!this.file) return;
    try {
      appendFileSync(this.file, JSON.stringify({ ts: Date.now(), ...record }) + "\n");
    } catch {
      /* never let logging break the pipeline */
    }
  }

  close(): void {
    this.log({ event: "session_end" });
  }
}
