import type { EventBus } from "../bus";

/** An audio source that normalizes to `Utterance`/`audio`/`session` bus events. */
export interface IngestAdapter {
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
}
