import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Ambient } from "./ambient";
import { BoardView } from "./components/Board";
import { Conversation } from "./components/Conversation";
import { store, useAppState } from "./store";

const VIEWS = ["conversation", "board"] as const;
type View = (typeof VIEWS)[number];

// Kiosks pick their view by URL (`?view=board`); keyboards switch with 1 / 2.
function initialView(): View {
  const v = new URLSearchParams(location.search).get("view");
  return VIEWS.find((x) => x === v) ?? "conversation";
}

export function App() {
  const [view, setView] = useState<View>(initialView);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") setView("conversation");
      else if (e.key === "2") setView("board");
      else if (e.key === "f") void document.documentElement.requestFullscreen().catch(() => {});
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative h-svh overflow-hidden bg-background text-foreground">
      <AmbientLayer dim={view === "board"} />
      <Tabs
        value={view}
        onValueChange={(v) => setView(v as View)}
        className="relative z-10 flex h-full flex-col gap-0"
      >
        <header className="flex items-center gap-5 border-b border-border/60 bg-background/50 px-6 py-3 backdrop-blur-md">
          <span className="text-sm font-semibold tracking-[0.14em] text-muted-foreground uppercase">Speaker Board</span>
          <TabsList>
            <TabsTrigger value="conversation" className="px-3">
              Conversation
            </TabsTrigger>
            <TabsTrigger value="board" className="px-3">
              Board <BoardCount />
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
            <AgentIndicator />
            <ConnectionIndicator />
          </div>
        </header>
        <TabsContent value="conversation" className="min-h-0 flex-1">
          <Conversation />
        </TabsContent>
        <TabsContent value="board" className="min-h-0 flex-1 overflow-y-auto">
          <BoardView />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The wall-piece spectrum, full-bleed behind everything; dimmed under the board. */
function AmbientLayer({ dim }: { dim: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ambient = new Ambient(ref.current);
    const off = store.onAudio((spectrum) => ambient.setSpectrum(spectrum));
    return () => {
      off();
      ambient.destroy();
    };
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn("fixed inset-0 z-0 transition-opacity duration-700 [&_canvas]:block", dim && "opacity-25")}
    />
  );
}

function BoardCount() {
  const { board } = useAppState();
  const n = board?.tiles.length ?? 0;
  if (!n) return null;
  return <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{n}</span>;
}

function AgentIndicator() {
  const { board } = useAppState();
  const agent = board?.agent;
  if (!agent) return null;
  if (agent.state === "thinking") {
    return (
      <span className="flex items-center gap-1.5 text-sky-300">
        <Loader2 className="size-3.5 animate-spin" />
        {agent.task === "reorganize" ? "Reorganizing board" : "Updating board"}
      </span>
    );
  }
  if (agent.state === "error") {
    return (
      <span className="flex items-center gap-1.5 text-amber-300" title={agent.detail}>
        <AlertTriangle className="size-3.5" /> Board agent error
      </span>
    );
  }
  if (agent.state === "off") return <span title={agent.detail}>Board off</span>;
  return <span title={agent.detail}>Board idle{agent.model ? ` · ${agent.model}` : ""}</span>;
}

function ConnectionIndicator() {
  const { connected, session } = useAppState();
  const [label, dot] = !connected
    ? ["Reconnecting", "bg-amber-400"]
    : session.status === "error"
      ? ["Transcription error", "bg-rose-400"]
      : ["Live", "bg-emerald-400"];
  return (
    <span className="flex items-center gap-1.5" title={session.message}>
      <span className={cn("size-2 rounded-full", dot)} />
      {label}
    </span>
  );
}
