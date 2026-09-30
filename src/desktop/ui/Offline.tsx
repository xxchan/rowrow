// A server's window while the server can't be reached: why, and what to do. The window goes
// back to the server's own page by itself once it's reachable (the main process moves it).
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import type { ShellState } from "../api.ts";
import { RowrowMark } from "./mark.tsx";
import { api, run } from "./state.ts";

export function Offline({ state, serverId }: { state: ShellState; serverId: string }) {
  const server = state.servers.find((s) => s.id === serverId);
  if (server === undefined)
    return (
      <Centered
        title="This server was removed"
        body="Close this window, or open another server from the menu bar."
      />
    );
  const { status } = server;
  const waiting = status.kind === "connecting" || status.kind === "setting-up";
  const reason =
    status.kind === "offline"
      ? status.reason
      : status.kind === "signed-out"
        ? status.reason
        : status.kind === "error"
          ? status.message
          : status.kind === "setting-up"
            ? status.step
            : status.kind === "connecting"
              ? (status.detail ?? "Connecting…")
              : "Connected; opening it…";
  return (
    <Centered
      title={waiting ? `Connecting to ${server.name}` : `Can't reach ${server.name}`}
      body={reason}
      spinning={waiting}
    >
      <Button onClick={() => void run("Retrying", () => api().retry(server.id))}>Retry</Button>
      {server.host !== null && server.host.owner !== "terminal" && status.kind !== "setting-up" && (
        <Button
          variant="outline"
          onClick={() => void run("Starting the server", () => api().hostAction(server.id, "start"))}
        >
          Start the server
        </Button>
      )}
      <Button variant="ghost" onClick={() => void run("Showing the log", () => api().showLogs(server.id))}>
        Show the log
      </Button>
    </Centered>
  );
}

function Centered({
  title,
  body,
  spinning = false,
  children,
}: {
  title: string;
  body: string;
  spinning?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
          {spinning ? <Loader2 className="size-5 animate-spin" /> : <RowrowMark className="size-5" />}
        </span>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm break-words text-muted-foreground">{body}</p>
        {children !== undefined && <div className="flex flex-wrap gap-2">{children}</div>}
      </div>
    </div>
  );
}
