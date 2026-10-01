// Settings → Server: whether rowrow is up to date, checked by hand when you like. Inside rowrow
// for Mac it's the app's own updater (window.rowrowApp): the app updates itself, then the
// servers it runs to match. A server installed with npm says when it last asked the registry
// and the command that updates it (D-025); a checkout updates with git.
import { Button } from "@/components/ui/button";
import { Copy, LoaderCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { AppBridge, AppUpdateView } from "../../shared/app-bridge.ts";
import type { HostInfo } from "../../shared/schemas.ts";
import { ago } from "../lib/format.ts";
import { useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { copyText } from "./MenuActions.tsx";

/** "just now", "5m ago". */
function since(at: number): string {
  const elapsed = ago(at);
  return elapsed === "now" ? "just now" : `${elapsed} ago`;
}

function appBridge(): AppBridge | null {
  return (globalThis as { rowrowApp?: AppBridge }).rowrowApp ?? null;
}

export function UpdateStatus({ host }: { host: HostInfo }) {
  const bridge = appBridge();
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {bridge !== null && <AppUpdate bridge={bridge} />}
      {host.updateCheck.via === "npm" ? (
        <NpmUpdate host={host} />
      ) : bridge === null ? (
        <p className="text-muted-foreground">
          {host.updateCheck.via === "mac"
            ? "rowrow for Mac keeps this server up to date."
            : "Runs from a checkout: update it with git pull."}
        </p>
      ) : null}
    </div>
  );
}

function Line({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-0 text-muted-foreground">{children}</span>
      {action}
    </div>
  );
}

/** rowrow for Mac's updater: check, watch it download, restart to install. */
function AppUpdate({ bridge }: { bridge: AppBridge }) {
  const [view, setView] = useState<AppUpdateView | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.update().then((first) => live && setView(first));
    const off = bridge.onUpdate(setView);
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  if (view === null) return null;
  const act = (label: string, run: () => Promise<void>) => (
    <Button
      size="sm"
      variant="outline"
      className="h-7"
      onClick={() =>
        void run().catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error));
          report("warn", "settings.app_update_failed", error);
        })
      }
    >
      {label}
    </Button>
  );
  const app = `rowrow for Mac ${view.current}`;
  switch (view.state) {
    case "idle":
      return (
        <Line action={act("Check for updates", () => bridge.checkForUpdates())}>
          {`${app} · up to date${view.checkedAt === null ? "" : `, checked ${since(view.checkedAt)}`}`}
        </Line>
      );
    case "checking":
      return (
        <Line>
          <LoaderCircle className="mr-1 inline size-3.5 animate-spin" />
          {`${app} · checking for updates…`}
        </Line>
      );
    case "downloading":
      return (
        <Line>
          <LoaderCircle className="mr-1 inline size-3.5 animate-spin" />
          {`Downloading rowrow ${view.version ?? ""}${view.progress === null ? "" : ` (${Math.round(view.progress * 100)}%)`}…`}
        </Line>
      );
    case "ready":
      return (
        <Line action={act(`Restart to update`, () => bridge.installUpdate())}>
          {`rowrow ${view.version ?? ""} is ready: the app restarts, then updates this Mac's server.`}
        </Line>
      );
    case "error":
      return (
        <Line action={act("Try again", () => bridge.checkForUpdates())}>
          {`${app} couldn't update: ${view.error ?? "the check failed"}`}
        </Line>
      );
    case "disabled":
      return <Line>{`${app} · this build doesn't update itself.`}</Line>;
  }
}

/** A server installed with npm: when it last asked the registry, Check now, and the command. */
function NpmUpdate({ host }: { host: HostInfo }) {
  const client = useClient();
  const [checking, setChecking] = useState(false);
  const { update, updateCheck } = host;
  const check = async (): Promise<void> => {
    if (client === null) return;
    setChecking(true);
    try {
      const result = await client.app.checkForUpdates();
      if (result.update === null && result.check.error === null) toast.success("rowrow is up to date");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      report("warn", "settings.update_check_failed", error);
    } finally {
      setChecking(false);
    }
  };
  const button = (
    <Button size="sm" variant="outline" className="h-7" disabled={checking} onClick={() => void check()}>
      {checking && <LoaderCircle className="animate-spin" />}
      Check now
    </Button>
  );
  if (update !== null)
    return (
      <div className="flex flex-col gap-1">
        <Line action={button}>{`rowrow ${update.version} is out. To update, run on this machine:`}</Line>
        <div className="flex items-center gap-2">
          <code className="min-w-0 rounded bg-muted px-2 py-1 font-mono text-xs break-all text-foreground">
            {update.command}
          </code>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label="Copy the update command"
            onClick={() => void copyText(update.command, "Command")}
          >
            <Copy />
          </Button>
        </div>
        {update.after !== null && <p className="text-muted-foreground">{update.after}</p>}
      </div>
    );
  return (
    <Line action={button}>
      {updateCheck.error !== null
        ? `Couldn't check for updates: ${updateCheck.error}`
        : updateCheck.checkedAt === null
          ? "Not checked for updates yet."
          : `Up to date, checked ${since(updateCheck.checkedAt)}.`}
    </Line>
  );
}
