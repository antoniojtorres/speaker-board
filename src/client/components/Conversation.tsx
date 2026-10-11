import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Annotation, Utterance } from "../../shared/events";
import { speakers, useAppState } from "../store";
import { SpeakerName, speakerStyle } from "./speaker";

/** The live transcript beside per-speaker talk-time stats. */
export function Conversation() {
  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_340px]">
      <Transcript />
      <TalkPanel />
    </div>
  );
}

/**
 * Rows flow up from the bottom and fade under the top edge. A row streams in as
 * `live` (dimmed, italic, with a caret) and settles when its speaker pauses.
 */
function Transcript() {
  const { utterances } = useAppState();
  return (
    <section className="flex min-h-0 flex-col justify-end overflow-hidden px-10 py-8 [mask-image:linear-gradient(to_bottom,transparent_0%,#000_12%,#000_100%)]">
      {utterances.map((u) => (
        <Row key={u.id} u={u} />
      ))}
    </section>
  );
}

function Row({ u }: { u: Utterance }) {
  const unknown = u.speaker === "UNKNOWN";
  return (
    <div
      style={speakerStyle(u.speaker)}
      className={cn(
        "flex items-baseline gap-3 border-l-4 border-[var(--spk)] py-2 pl-3.5 text-[30px] leading-snug",
        "animate-in fade-in slide-in-from-bottom-2 duration-500",
        unknown && "border-muted-foreground text-muted-foreground",
        u.state === "live" && "italic opacity-60",
      )}
    >
      <SpeakerName id={u.speaker} className="min-w-[5.5rem] shrink-0 pt-1.5 text-[15px]" />
      <span className={cn("flex-1", u.state === "live" && "live-caret")}>{u.text}</span>
      {u.annotations.map((a, i) => (
        <AnnotationChip key={i} a={a} />
      ))}
    </div>
  );
}

function AnnotationChip({ a }: { a: Annotation }) {
  const p = a.payload as { label?: string; url?: string };
  const label = a.kind === "link" ? (p.url ?? "link") : a.kind === "image" ? "image" : (p.label ?? a.kind);
  return (
    <Badge variant="outline" className="self-center font-normal not-italic text-muted-foreground">
      {label}
    </Badge>
  );
}

function TalkPanel() {
  const { stats, totalTurns, wpm } = useAppState();
  const maxTalk = Math.max(1, ...stats.map((s) => s.talkMs));
  return (
    <aside className="overflow-y-auto border-l border-border/60 bg-black/30 p-6 backdrop-blur-sm">
      <h2 className="mb-5 text-sm font-semibold tracking-[0.08em] text-muted-foreground uppercase">Talk time</h2>
      <div className="space-y-3">
        {stats.map((s) => (
          <div key={s.speaker} className="grid grid-cols-[6rem_1fr_auto] items-center gap-2">
            <SpeakerName id={s.speaker} />
            <div className="h-3 overflow-hidden rounded bg-white/10">
              <div
                style={{ width: `${(s.talkMs / maxTalk) * 100}%`, background: speakers.colorOf(s.speaker) }}
                className="h-full rounded transition-[width] duration-500"
              />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">{s.words}w</span>
          </div>
        ))}
      </div>
      <dl className="mt-6 grid gap-1.5 text-[15px]">
        <Stat label="Turns" value={String(totalTurns)} />
        <Stat label="WPM" value={String(Math.round(wpm))} />
        <Stat label="Elapsed" value={<Elapsed />} />
      </dl>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

const startedAt = Date.now();

function Elapsed() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - startedAt) / 1000);
  return (
    <>
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </>
  );
}
