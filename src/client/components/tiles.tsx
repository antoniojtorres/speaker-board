import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, BarChart3, CalendarClock, Lightbulb, Quote, Scale, User, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BoardTile, Prominence, PublishedStance, StanceKind, TileImage, TileKind, TileSource } from "../../shared/board";
import { speakers } from "../store";
import { SpeakerName } from "./speaker";

type TileOf<K extends TileKind> = Extract<BoardTile, { kind: K }>;
type BodyProps<K extends TileKind> = { tile: TileOf<K>; size: Prominence };

const KIND: Record<TileKind, { label: string; icon: LucideIcon }> = {
  person: { label: "Person", icon: User },
  fact: { label: "Context", icon: Lightbulb },
  positions: { label: "Where they stand", icon: Scale },
  timeline: { label: "Timeline", icon: CalendarClock },
  quote: { label: "Quote", icon: Quote },
  chart: { label: "By the numbers", icon: BarChart3 },
};

// How a heated or lively debate tints its card ("goes red", as the room put it).
const TONE_TINT = {
  heated: "ring-1 ring-rose-500/50 bg-linear-to-br from-rose-950/60 to-card/85",
  lively: "ring-1 ring-amber-400/25 bg-linear-to-br from-amber-950/30 to-card/85",
  friendly: "",
} as const;

/**
 * One board tile. Arrives with a fade/zoom and flashes briefly when replaced.
 * Featured tiles take the full row; minor ones render compact; a normal debate
 * spans two columns because it needs the room.
 */
export function Tile({ tile }: { tile: BoardTile }) {
  const flashing = useFlash(tile.updatedAt);
  const size = tile.prominence;
  const tone = tile.kind === "positions" && tile.tone ? TONE_TINT[tile.tone] : "";
  return (
    <Card
      className={cn(
        "gap-3 bg-card/85 backdrop-blur-md transition-shadow duration-700",
        "animate-in fade-in zoom-in-95 duration-500",
        size === "featured" && "col-span-full ring-1 ring-white/15",
        size === "normal" && tile.kind === "positions" && "md:col-span-2",
        size === "minor" && "gap-2 py-3 opacity-80",
        tone,
        flashing && "ring-2 ring-sky-400/70",
      )}
    >
      <div className="px-4">
        <KindLabel kind={tile.kind} featured={size === "featured"} />
      </div>
      <div className="px-4">
        <TileBody tile={tile} size={size} />
      </div>
      <TileFooter tile={tile} />
    </Card>
  );
}

function TileBody({ tile, size }: { tile: BoardTile; size: Prominence }) {
  switch (tile.kind) {
    case "person":
      return <PersonBody tile={tile} size={size} />;
    case "fact":
      return <FactBody tile={tile} size={size} />;
    case "positions":
      return <PositionsBody tile={tile} size={size} />;
    case "timeline":
      return <TimelineBody tile={tile} size={size} />;
    case "quote":
      return <QuoteBody tile={tile} size={size} />;
    case "chart":
      return <ChartBody tile={tile} size={size} />;
  }
}

function KindLabel({ kind, featured }: { kind: TileKind; featured: boolean }) {
  const { label, icon: Icon } = KIND[kind];
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
      <Icon className="size-3.5" />
      {label}
      {featured && <span className="ml-1 text-sky-300">· In focus</span>}
    </div>
  );
}

function PersonBody({ tile, size }: BodyProps<"person">) {
  return (
    <div className="flex gap-4">
      <Portrait
        image={tile.image}
        name={tile.name}
        className={size === "featured" ? "h-52 w-40" : size === "minor" ? "h-16 w-14" : "h-36 w-28"}
      />
      <div className="min-w-0">
        <div className={cn("leading-tight font-semibold", size === "featured" ? "text-3xl" : size === "minor" ? "text-base" : "text-xl")}>
          {tile.name}
        </div>
        <div className="mt-0.5 text-sm text-muted-foreground">{tile.role}</div>
        <p
          className={cn(
            "mt-2.5 leading-relaxed text-foreground/90",
            size === "featured" ? "max-w-3xl text-lg" : "text-[15px]",
            size === "minor" && "mt-1 line-clamp-2 text-sm",
          )}
        >
          {tile.summary}
        </p>
      </div>
    </div>
  );
}

function FactBody({ tile, size }: BodyProps<"fact">) {
  return (
    <div className="flex gap-4">
      {tile.image && (
        <Portrait
          image={tile.image}
          name={tile.headline}
          className={size === "featured" ? "h-40 w-40" : size === "minor" ? "h-14 w-14" : "h-24 w-24"}
        />
      )}
      <div className="min-w-0">
        <div className={cn("leading-snug font-semibold", size === "featured" ? "text-3xl" : size === "minor" ? "text-base" : "text-lg")}>
          {tile.headline}
        </div>
        <p
          className={cn(
            "mt-2 leading-relaxed text-foreground/90",
            size === "featured" ? "max-w-3xl text-lg" : "text-[15px]",
            size === "minor" && "mt-1 line-clamp-2 text-sm",
          )}
        >
          {tile.body}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the debate

const STANCE_STYLE: Record<StanceKind, { badge: string; bar: string }> = {
  for: { badge: "border-emerald-400/40 bg-emerald-400/15 text-emerald-300", bar: "bg-emerald-400" },
  mixed: { badge: "border-amber-400/40 bg-amber-400/15 text-amber-300", bar: "bg-amber-400" },
  undecided: { badge: "border-slate-400/40 bg-slate-400/15 text-slate-300", bar: "bg-slate-400" },
  against: { badge: "border-rose-400/40 bg-rose-400/15 text-rose-300", bar: "bg-rose-400" },
};
const SPECTRUM: StanceKind[] = ["for", "mixed", "undecided", "against"];

function PositionsBody({ tile, size }: BodyProps<"positions">) {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className={cn("leading-snug font-semibold", size === "featured" ? "text-3xl" : size === "minor" ? "text-base" : "text-xl")}>
          {tile.topic}
        </div>
        <div className="flex items-center gap-3">
          <LiveBadge updatedAt={tile.updatedAt} />
          {tile.tone && tile.tone !== "friendly" && <ToneBadge tone={tile.tone} />}
        </div>
      </div>
      <AgreementMeter stances={tile.stances} />
      {size === "minor" ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {tile.stances.map((s) => (
            <span key={s.speaker} className="flex items-center gap-1.5">
              <SpeakerName id={s.speaker} className="text-[11px]" />
              <StanceBadge stance={s} />
            </span>
          ))}
        </div>
      ) : size === "featured" ? (
        // Debate-stage layout: one column per speaker.
        <div className="mt-5 grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          {tile.stances.map((s) => (
            <div key={s.speaker} className="border-l-2 pl-4" style={{ borderColor: speakers.colorOf(s.speaker) }}>
              <div className="flex flex-wrap items-center gap-2.5">
                <SpeakerName id={s.speaker} className="text-sm" />
                <StanceBadge stance={s} />
              </div>
              <p className="mt-2.5 text-lg leading-snug">{s.summary}</p>
              <Points points={s.points} className="text-[15px]" />
              {s.quote && <p className="mt-2.5 text-sm text-muted-foreground italic">“{s.quote}”</p>}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {tile.stances.map((s) => (
            <div key={s.speaker} className="grid grid-cols-[6.5rem_auto_1fr] items-baseline gap-3">
              <SpeakerName id={s.speaker} className="text-sm" />
              <StanceBadge stance={s} />
              <div>
                <p className="text-[15px] leading-relaxed">{s.summary}</p>
                <Points points={s.points} className="text-sm" />
                {s.quote && <p className="mt-1 text-sm text-muted-foreground italic">“{s.quote}”</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The current stance, preceded by the previous one when the speaker has shifted. */
function StanceBadge({ stance }: { stance: PublishedStance }) {
  const previous = stance.history.length > 1 ? stance.history[stance.history.length - 2] : null;
  return (
    <span className="flex items-center gap-1 justify-self-start">
      {previous && (
        <>
          <Badge variant="outline" className={cn("capitalize line-through opacity-50", STANCE_STYLE[previous].badge)}>
            {previous}
          </Badge>
          <ArrowRight className="size-3 text-muted-foreground" />
        </>
      )}
      <Badge variant="outline" className={cn("capitalize", STANCE_STYLE[stance.stance].badge)}>
        {stance.stance}
      </Badge>
    </span>
  );
}

function Points({ points, className }: { points?: string[]; className?: string }) {
  if (!points?.length) return null;
  return (
    <ul className={cn("mt-1.5 space-y-0.5 text-foreground/80", className)}>
      {points.map((p, i) => (
        <li key={i} className="flex gap-2">
          <span className="text-muted-foreground">•</span>
          {p}
        </li>
      ))}
    </ul>
  );
}

/** Where the room stands at a glance: one segment per speaker, ordered for → against. */
function AgreementMeter({ stances }: { stances: PublishedStance[] }) {
  const ordered = [...stances].sort((a, b) => SPECTRUM.indexOf(a.stance) - SPECTRUM.indexOf(b.stance));
  return (
    <div className="mt-3 flex items-center gap-3">
      <div className="flex h-2 w-40 gap-0.5 overflow-hidden rounded-full">
        {ordered.map((s) => (
          <div key={s.speaker} className={cn("flex-1 transition-colors duration-700", STANCE_STYLE[s.stance].bar)} />
        ))}
      </div>
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{agreementLabel(stances)}</span>
    </div>
  );
}

function agreementLabel(stances: PublishedStance[]): string {
  const count = (k: StanceKind): number => stances.filter((s) => s.stance === k).length;
  const pro = count("for");
  const con = count("against");
  if (pro && con) return "Split";
  if (stances.length > 1 && (pro === stances.length || con === stances.length)) return "In agreement";
  if (pro) return "Leaning for";
  if (con) return "Leaning against";
  return "Unsettled";
}

function ToneBadge({ tone }: { tone: "lively" | "heated" }) {
  return (
    <Badge
      variant="outline"
      className={tone === "heated" ? "border-rose-400/50 text-rose-300" : "border-amber-400/40 text-amber-200"}
    >
      {tone === "heated" ? "Heated" : "Lively"}
    </Badge>
  );
}

/** "Live" while the debate has been updated in the last minute and a half. */
function LiveBadge({ updatedAt }: { updatedAt: number }) {
  const now = useNow(10_000);
  if (now - updatedAt > 90_000) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-rose-300 uppercase">
      <span className="size-2 animate-pulse rounded-full bg-rose-400" />
      Live
    </span>
  );
}

// ----------------------------------------------------------------- the rest

function TimelineBody({ tile, size }: BodyProps<"timeline">) {
  const events = size === "minor" ? tile.events.slice(-3) : tile.events;
  return (
    <div>
      <div className={cn("leading-snug font-semibold", size === "featured" ? "text-2xl" : size === "minor" ? "text-base" : "text-lg")}>
        {tile.title}
      </div>
      <ol className="relative mt-3 ml-1 space-y-2.5 border-l border-border pl-4">
        {events.map((e, i) => (
          <li key={i} className="relative">
            <span className="absolute top-2 -left-[1.3rem] size-2 rounded-full bg-sky-400" />
            <span className="mr-2 text-sm text-muted-foreground tabular-nums">{e.when}</span>
            <span className={size === "minor" ? "text-sm" : "text-[15px]"}>{e.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function QuoteBody({ tile, size }: BodyProps<"quote">) {
  return (
    <figure>
      <blockquote
        className={cn(
          "leading-snug font-medium",
          size === "featured" ? "text-4xl" : size === "minor" ? "line-clamp-3 text-lg" : "text-2xl",
        )}
      >
        “{tile.text}”
      </blockquote>
      <figcaption className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <SpeakerName id={tile.speaker} className="text-sm" />
        {tile.note && <span className="text-sm text-muted-foreground">— {tile.note}</span>}
      </figcaption>
    </figure>
  );
}

function ChartBody({ tile, size }: BodyProps<"chart">) {
  const max = Math.max(...tile.bars.map((b) => Math.abs(b.value)), Number.EPSILON);
  return (
    <div>
      <div className={cn("leading-snug font-semibold", size === "featured" ? "text-2xl" : size === "minor" ? "text-base" : "text-lg")}>
        {tile.title}
        {tile.unit && <span className="ml-2 text-sm font-normal text-muted-foreground">({tile.unit})</span>}
      </div>
      <div className="mt-3 space-y-2">
        {tile.bars.map((b, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3">
            <span className="truncate text-sm text-muted-foreground">{b.label}</span>
            <div className={cn("overflow-hidden rounded bg-white/5", size === "minor" ? "h-3" : "h-5")}>
              <div
                style={{ width: `${(Math.abs(b.value) / max) * 100}%` }}
                className="h-full rounded bg-sky-400/80 transition-[width] duration-700"
              />
            </div>
            <span className="text-sm tabular-nums">{b.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Portrait({ image, name, className }: { image?: TileImage; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) {
    const initials = name
      .split(/\s+/)
      .filter((w) => /^[A-Z]/.test(w))
      .slice(0, 2)
      .map((w) => w[0])
      .join("");
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg bg-muted text-2xl font-semibold text-muted-foreground",
          className,
        )}
      >
        {initials || "?"}
      </div>
    );
  }
  return (
    <img
      src={image.url}
      alt={image.alt}
      onError={() => setFailed(true)}
      className={cn("shrink-0 rounded-lg bg-muted object-cover object-top", className)}
    />
  );
}

/** Attribution. Web-sourced facts and photos must show where they came from. */
function TileFooter({ tile }: { tile: BoardTile }) {
  const sources: TileSource[] = "sources" in tile ? (tile.sources ?? []) : [];
  const links: ReactNode[] = [];
  if (tile.link) links.push(<SourceLink key="wiki" url={tile.link} label="Wikipedia" />);
  for (const s of sources) {
    if (s.url !== tile.link) links.push(<SourceLink key={s.url} url={s.url} label={hostOf(s.url)} />);
  }
  // A photo from a search result rather than the tile's Wikipedia article gets its own credit.
  const photoFrom = tile.image && tile.image.pageUrl !== tile.link ? tile.image.pageUrl : null;
  if (!links.length && !photoFrom) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 border-t border-border/60 px-4 pt-2.5 text-xs text-muted-foreground">
      {photoFrom && (
        <span className="mr-3">
          Photo: <SourceLink url={photoFrom} label={hostOf(photoFrom)} />
        </span>
      )}
      {links.length > 0 && <span>{tile.image && !photoFrom ? "Photo & sources:" : "Sources:"}</span>}
      {links.map((l, i) => (
        <span key={i}>
          {i > 0 && <span className="mr-1.5">·</span>}
          {l}
        </span>
      ))}
    </div>
  );
}

function SourceLink({ url, label }: { url: string; label: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-foreground hover:underline">
      {label}
    </a>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** True for a moment after `updatedAt` changes (not on first mount). */
function useFlash(updatedAt: number): boolean {
  const [first] = useState(updatedAt);
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (updatedAt === first) return;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), 1600);
    return () => clearTimeout(t);
  }, [updatedAt, first]);
  return flashing;
}

/** The current time, refreshed every `ms`, for labels that expire. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
