import type {
  AgentStatus,
  BoardState,
  BoardTile,
  Prominence,
  PublishedStance,
  Stance,
  TileDraft,
} from "../../src/shared/board";
import type { EventBus } from "../bus";

export const MAX_TILES = 12;

export type PutResult = "placed" | "unchanged";

// Fields the server derives; a rewrite that differs only in these is no change.
const SERVER_FIELDS = new Set(["image", "link", "updatedAt", "prominence", "history"]);

/**
 * Server-authoritative board: the tile set and the status of whatever fills it.
 * Publishes the whole state on every change, and owns the board's rules:
 * - Order: the featured tile first, then newest first, so fresh cards land at
 *   the top. A replaced tile keeps its slot (Map preserves insertion order on
 *   `set`), so updates don't reshuffle the layout under someone's eyes.
 * - At most one tile is featured; featuring another demotes the previous one.
 * - Positions remember each speaker's earlier stances, so a shift shows even
 *   when whoever wrote the update didn't mention it.
 * - Rewriting a tile with identical content is refused, so it doesn't flash.
 */
export class Board {
  private tiles = new Map<string, BoardTile>();
  private agent: AgentStatus = { state: "off", updatedAt: Date.now() };

  constructor(private readonly bus: EventBus) {}

  get size(): number {
    return this.tiles.size;
  }

  has(id: string): boolean {
    return this.tiles.has(id);
  }

  put(draft: TileDraft): PutResult {
    const existing = this.tiles.get(draft.id);
    const prominence: Prominence = draft.prominence ?? existing?.prominence ?? "normal";
    if (existing && prominence === existing.prominence && contentKey(existing) === contentKey(draft)) {
      return "unchanged";
    }
    // `draft` is one member of the union; the spread keeps it that member.
    const tile = { ...draft, prominence, updatedAt: Date.now() } as BoardTile;
    if (tile.kind === "positions" && draft.kind === "positions") {
      tile.stances = withHistory(draft.stances, existing?.kind === "positions" ? existing.stances : []);
    }
    if (prominence === "featured") this.demoteFeaturedExcept(tile.id);
    this.tiles.set(tile.id, tile);
    this.publish();
    return "placed";
  }

  /** Re-ranks a tile without rewriting it (and without the replaced-tile flash). */
  setProminence(id: string, prominence: Prominence): PutResult | "missing" {
    const tile = this.tiles.get(id);
    if (!tile) return "missing";
    if (tile.prominence === prominence) return "unchanged";
    if (prominence === "featured") this.demoteFeaturedExcept(id);
    this.tiles.set(id, { ...tile, prominence });
    this.publish();
    return "placed";
  }

  remove(id: string): boolean {
    const removed = this.tiles.delete(id);
    if (removed) this.publish();
    return removed;
  }

  setAgent(status: Omit<AgentStatus, "updatedAt">): void {
    this.agent = { ...status, updatedAt: Date.now() };
    this.publish();
  }

  snapshot(): BoardState {
    const newestFirst = [...this.tiles.values()].reverse();
    return {
      tiles: [
        ...newestFirst.filter((t) => t.prominence === "featured"),
        ...newestFirst.filter((t) => t.prominence !== "featured"),
      ],
      agent: this.agent,
    };
  }

  private demoteFeaturedExcept(id: string): void {
    for (const [key, t] of this.tiles) {
      if (key !== id && t.prominence === "featured") this.tiles.set(key, { ...t, prominence: "normal" });
    }
  }

  private publish(): void {
    this.bus.publish({ type: "board", board: this.snapshot() });
  }
}

/** Each speaker's stances over time on this topic: oldest first, current last, consecutive repeats collapsed. */
function withHistory(next: Stance[], previous: PublishedStance[]): PublishedStance[] {
  return next.map((s) => {
    const before = previous.find((p) => p.speaker === s.speaker)?.history ?? [];
    const history = before.at(-1) === s.stance ? before : [...before, s.stance].slice(-4);
    return { ...s, history };
  });
}

/** The tile's content as the writer supplied it, for spotting no-op rewrites. */
function contentKey(tile: object): string {
  return JSON.stringify(tile, (key, value: unknown) => (SERVER_FIELDS.has(key) ? undefined : value));
}
