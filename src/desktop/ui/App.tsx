// The Mac app's own window: welcome, servers, adding one; and, in a server's window, what to do
// while it can't be reached (docs/desktop.md).
import { Button } from "@/components/ui/button";
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { Toaster } from "sonner";
import type { ShellState } from "../api.ts";
import { AddServer } from "./AddServer.tsx";
import { RowrowMark } from "./mark.tsx";
import { Offline } from "./Offline.tsx";
import { Servers } from "./Servers.tsx";
import { api, run, useRoute, useShellState } from "./state.ts";
import { Welcome } from "./Welcome.tsx";

export function App() {
  const state = useShellState();
  const route = useRoute();
  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      {/* The window has no title bar (D-057): this strip, under its buttons, drags it. */}
      <div aria-hidden className="fixed inset-x-0 top-0 h-8 [-webkit-app-region:drag]" />
      <Toaster theme="system" position="bottom-center" />
      {state === null ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : route.startsWith("/offline/") ? (
        <Offline state={state} serverId={decodeURIComponent(route.slice("/offline/".length))} />
      ) : (
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
          <Header state={state} />
          {route.startsWith("/add") ? (
            <AddServer
              state={state}
              kind={route === "/add/ssh" ? "ssh" : route === "/add/link" ? "link" : null}
            />
          ) : state.servers.length === 0 ? (
            <Welcome state={state} />
          ) : (
            <Servers state={state} />
          )}
        </main>
      )}
    </div>
  );
}

function Header({ state }: { state: ShellState }) {
  const { update } = state;
  return (
    <header className="flex items-center gap-3">
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
        <RowrowMark className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-base leading-5 font-semibold">rowrow</h1>
        <p className="text-xs text-muted-foreground">{`Version ${state.version}`}</p>
      </div>
      {update.state === "ready" ? (
        <Button size="sm" onClick={() => void run("Updating", () => api().installUpdate())}>
          <ArrowUpCircle /> {`Restart to update to ${update.version ?? "the new version"}`}
        </Button>
      ) : update.state === "downloading" ? (
        <span className="text-xs text-muted-foreground">
          {`Downloading ${update.version ?? "an update"}${update.progress === null ? "" : ` · ${Math.round(update.progress * 100)}%`}`}
        </span>
      ) : update.state === "error" ? (
        <Button
          size="sm"
          variant="outline"
          title={update.error ?? undefined}
          onClick={() => void run("Checking for updates", () => api().checkForUpdates())}
        >
          Update failed · Try again
        </Button>
      ) : update.state === "disabled" ? null : (
        <Button
          size="sm"
          variant="ghost"
          disabled={update.state === "checking"}
          onClick={() => void run("Checking for updates", () => api().checkForUpdates())}
        >
          {update.state === "checking" ? "Checking…" : "Check for updates"}
        </Button>
      )}
    </header>
  );
}
