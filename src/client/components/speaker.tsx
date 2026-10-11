import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { speakers } from "../store";

/** Inline style exposing a speaker's color as `--spk` for border/text utilities. */
export function speakerStyle(id: string): CSSProperties {
  return { "--spk": speakers.colorOf(id) } as CSSProperties;
}

/** A speaker's display name in their color, e.g. "Speaker 2". */
export function SpeakerName({ id, className }: { id: string; className?: string }) {
  return (
    <span
      style={speakerStyle(id)}
      className={cn("text-[var(--spk)] text-xs font-semibold tracking-wider uppercase", className)}
    >
      {speakers.nameOf(id)}
    </span>
  );
}
