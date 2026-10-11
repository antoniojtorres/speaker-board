import type { SpeakerId } from "../shared/events";

// Dark-bg legible palette, assigned in arrival order. Stable for the session.
const PALETTE = [
  "#ff6b6b",
  "#4ecdc4",
  "#ffd93d",
  "#6c5ce7",
  "#51cf66",
  "#ff922b",
  "#74c0fc",
  "#f783ac",
];
const UNKNOWN_COLOR = "#868e96";

/**
 * Maps diarization labels to a stable visual identity. UNKNOWN renders neutral
 * and never consumes a color slot, so short backchannels don't spawn a lane.
 */
export class SpeakerRegistry {
  private order: SpeakerId[] = [];

  private index(id: SpeakerId): number {
    let i = this.order.indexOf(id);
    if (i === -1) {
      i = this.order.length;
      this.order.push(id);
    }
    return i;
  }

  /** Assigns the next name/color slot; call in transcript order. */
  register(id: SpeakerId): void {
    if (id !== "UNKNOWN") this.index(id);
  }

  colorOf(id: SpeakerId): string {
    if (id === "UNKNOWN") return UNKNOWN_COLOR;
    return PALETTE[this.index(id) % PALETTE.length];
  }

  nameOf(id: SpeakerId): string {
    if (id === "UNKNOWN") return "—";
    return `Speaker ${this.index(id) + 1}`;
  }
}
