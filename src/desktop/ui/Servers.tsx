// The machines this Mac knows (where agents run, D-059): each one's state, who runs rowrow there
// (and so who updates it, D-032), an upgrade waiting for agents to finish, and what you can do
// about it.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Laptop, Link2, MoreHorizontal, Plus, Server } from "lucide-react";
import type { HostAction, HostView, ServerStatus, ServerView, ShellState } from "../api.ts";
import { api, go, run } from "./state.ts";

export function Servers({ state }: { state: ShellState }) {
  return (
    <>
      <section aria-labelledby="machines" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="machines" className="text-sm font-semibold text-muted-foreground">
              Machines
            </h2>
            <p className="text-xs text-muted-foreground">
              Where your agents run. Each has its own agents, workspaces and settings.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => go("/add")}>
            <Plus /> Add a machine
          </Button>
        </div>
        {state.servers.map((server) => (
          <ServerCard key={server.id} server={server} />
        ))}
      </section>
      <section aria-label="This app" className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>
            <span className="block">Open rowrow when you log in</span>
            <span className="block text-xs text-muted-foreground">
              So notifications keep coming; it stays in the menu bar.
            </span>
          </span>
          <Switch
            checked={state.openAtLogin}
            onCheckedChange={(open) => void run("Changing that", () => api().setOpenAtLogin(open))}
          />
        </label>
        {state.servers.some((server) => server.kind === "local") && (
          <div className="flex items-center justify-between gap-4 text-sm">
            <span>
              <span className="block">The rowrow command</span>
              <span className="block text-xs text-muted-foreground">
                {state.commandInstalled
                  ? "Installed in /usr/local/bin: it matches the rowrow this Mac runs."
                  : "rowrow agents, rowrow logs… in your terminal, matching the rowrow this Mac runs."}
              </span>
            </span>
            {!state.commandInstalled && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void run("Installing the command", () => api().installCommand())}
              >
                Install
              </Button>
            )}
          </div>
        )}
      </section>
    </>
  );
}

const KIND_ICON = { local: Laptop, ssh: Server, url: Link2 } as const;

/** A status in words (a machine's own Settings says the same: src/desktop/machines.ts). */
function statusWords(status: ServerStatus): { tone: string; text: string } {
  switch (status.kind) {
    case "online":
      return { tone: "bg-success", text: "Connected" };
    case "connecting":
      return { tone: "bg-warning", text: status.detail ?? "Connecting…" };
    case "setting-up":
      return { tone: "bg-primary", text: status.step };
    case "offline":
      return { tone: "bg-muted-foreground/45", text: status.reason };
    case "signed-out":
      return { tone: "bg-destructive", text: status.reason };
    case "error":
      return { tone: "bg-destructive", text: status.message };
  }
}

const FROM: Readonly<Record<string, string>> = {
  npm: " from npm",
  pnpm: " from pnpm",
  npx: " from npx",
  checkout: " from a checkout",
};

/** Who runs rowrow on a machine, and so who updates it. */
function ownerWords(host: HostView): string {
  const version = host.runningVersion === null ? "" : ` ${host.runningVersion}`;
  switch (host.owner) {
    case "app":
      return `rowrow${version}, a service this app runs and keeps up to date${host.service === null ? "" : ` (${host.service})`}.`;
    case "cli":
      return `rowrow${version}, a service installed with the rowrow command${FROM[host.installKind ?? ""] ?? ""}: you update it (or let this app run it).`;
    case "terminal":
      return `rowrow${version}, started in a terminal. To let this app keep it running and up to date, stop it there, then Start here.`;
    case "background":
      return `rowrow${version}, started by this app in the background: this machine has no user service manager, so it won't come back after a reboot.`;
    case "none":
      return "rowrow isn't running there.";
  }
}

function ServerCard({ server }: { server: ServerView }) {
  const Icon = KIND_ICON[server.kind];
  const words = statusWords(server.status);
  const host = server.host;
  const act = (action: HostAction, what: string): void =>
    void run(what, () => api().hostAction(server.id, action));
  const busy = server.status.kind === "setting-up";
  return (
    <article aria-label={server.name} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{server.name}</h3>
            {server.badge !== null && server.badge > 0 && (
              <Badge>{`${server.badge} need${server.badge === 1 ? "s" : ""} you`}</Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {server.where}
            {server.version === null ? "" : ` · rowrow ${server.version}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" disabled={busy} onClick={() => void run("Opening", () => api().open(server.id))}>
            Open
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`More for ${server.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {host !== null && host.owner !== "none" && host.owner !== "terminal" && (
                <>
                  <DropdownMenuItem onSelect={() => act("restart", "Restarting rowrow")}>
                    Restart rowrow there
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => act("stop", "Stopping rowrow")}>
                    Stop rowrow there
                  </DropdownMenuItem>
                </>
              )}
              {host !== null &&
                (host.owner === "none" || server.status.kind === "offline") &&
                host.owner !== "terminal" && (
                  <DropdownMenuItem onSelect={() => act("start", "Starting rowrow")}>
                    Start rowrow there
                  </DropdownMenuItem>
                )}
              {host?.owner === "cli" && (
                <DropdownMenuItem onSelect={() => act("adopt", "Handing the service to this app")}>
                  Let this app run it
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void run("Showing the log", () => api().showLogs(server.id))}>
                Show the log
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  const name = window.prompt("Name", server.name);
                  if (name !== null) void run("Renaming", () => api().rename(server.id, name));
                }}
              >
                Rename…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void run("Removing", () => api().remove(server.id))}
              >
                Remove from this Mac…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <p className="flex items-start gap-2 text-sm">
        <span
          className={cn("mt-1.5 inline-flex size-2 shrink-0 rounded-full", words.tone)}
          aria-hidden="true"
        />
        <span className={cn("min-w-0", server.status.kind === "online" ? "" : "text-muted-foreground")}>
          {words.text}
        </span>
      </p>

      {host !== null && server.status.kind !== "setting-up" && (
        <p className="text-xs text-muted-foreground">{ownerWords(host)}</p>
      )}
      {server.status.kind === "online" && server.notifications === false && (
        <p className="text-xs text-muted-foreground">
          The rowrow this machine runs is too old to send notifications to this Mac; update it to get them.
        </p>
      )}

      {host?.upgrade !== null && host?.upgrade !== undefined && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            {host.upgrade.state === "waiting"
              ? `rowrow ${host.upgrade.version} is ready for this machine. It restarts into it when ${host.upgrade.waitingFor.length === 1 ? "an agent finishes" : `${host.upgrade.waitingFor.length} agents finish`}: ${host.upgrade.waitingFor.join(", ")}.`
              : host.upgrade.state === "installing"
                ? `Updating this machine to rowrow ${host.upgrade.version}…`
                : `Updating this machine to rowrow ${host.upgrade.version} failed: ${host.upgrade.error ?? "unknown error"}`}
          </span>
          {host.upgrade.state !== "installing" && (
            <Button size="sm" variant="outline" onClick={() => act("upgrade-now", "Updating rowrow")}>
              {host.upgrade.state === "waiting" ? "Restart now" : "Try again"}
            </Button>
          )}
        </div>
      )}

      {(server.status.kind === "offline" || server.status.kind === "error") && (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void run("Retrying", () => api().retry(server.id))}
          >
            Retry
          </Button>
        </div>
      )}
      {server.status.kind === "signed-out" && server.kind === "url" && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              go(`/add/code?${new URLSearchParams({ url: server.where, name: server.name }).toString()}`)
            }
          >
            Sign in again with a code
          </Button>
          <Button size="sm" variant="ghost" onClick={() => go("/add/link")}>
            With a link
          </Button>
        </div>
      )}
    </article>
  );
}
