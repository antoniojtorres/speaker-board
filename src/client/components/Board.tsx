import { AlertTriangle, Ear, Loader2, PowerOff } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentStatus } from "../../shared/board";
import { useAppState } from "../store";
import { Tile } from "./tiles";

/** The generated board: a dense grid of tiles in the order the agent placed them. */
export function BoardView() {
  const { board } = useAppState();
  const tiles = board?.tiles ?? [];
  if (!tiles.length) return <EmptyBoard agent={board?.agent} />;
  return (
    <div className="grid grid-flow-dense gap-4 p-6 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
      {tiles.map((t) => (
        <Tile key={t.id} tile={t} />
      ))}
    </div>
  );
}

function EmptyBoard({ agent }: { agent?: AgentStatus }) {
  const view = emptyCopy(agent);
  const Icon = view.icon;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-10 text-center">
      <Icon className={agent?.state === "thinking" ? "size-8 animate-spin text-sky-400" : "size-8 text-muted-foreground"} />
      <div>
        <div className="text-xl font-semibold">{view.title}</div>
        <p className="mt-2 max-w-md text-muted-foreground">{view.body}</p>
      </div>
      {agent?.state === "thinking" && (
        <div className="grid w-full max-w-3xl grid-cols-3 gap-4 opacity-60">
          <Skeleton className="col-span-2 h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-28" />
          <Skeleton className="col-span-2 h-28" />
        </div>
      )}
    </div>
  );
}

function emptyCopy(agent?: AgentStatus): { icon: typeof Ear; title: string; body: string } {
  switch (agent?.state) {
    case "off":
      return { icon: PowerOff, title: "The board is off", body: agent.detail ?? "" };
    case "error":
      return { icon: AlertTriangle, title: "The board agent hit a problem", body: agent.detail ?? "It will retry." };
    case "thinking":
      return { icon: Loader2, title: "Reading the conversation…", body: "The first tiles are on their way." };
    case "idle":
      return {
        icon: Ear,
        title: "Listening",
        body: "Tiles appear here as the conversation develops: who and what is being discussed, and where everyone stands.",
      };
    default:
      return { icon: Loader2, title: "Connecting…", body: "" };
  }
}
