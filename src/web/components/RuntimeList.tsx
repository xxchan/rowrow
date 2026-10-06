// Settings → Agent runtimes: what's installed here, whether it is signed in, and whether a
// newer version is out (each runtime's own updater says, through oar). Update runs that
// updater, only when you press it; an agent running now keeps the old version until its next
// run. Sign in runs the runtime's own login (RuntimeLogin.tsx).
import { Button } from "@/components/ui/button";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { RuntimeInfo, RuntimeUpdate, UpdateCheck, UpgradeResult } from "../../shared/schemas.ts";
import { useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { AgentIcon } from "./AgentIcon.tsx";
import { authNote, LoginPanel, loginResultNote, useRuntimeLogins } from "./RuntimeLogin.tsx";
import { StatusDot } from "./StatusDot.tsx";

/** Why there's nothing to update, when that is worth saying. */
const UNAVAILABLE: Record<string, string> = {
  package_manager: "Installed by a package manager: update it there.",
  unmanaged_installation: "Installed by hand: rowrow can't tell what's newer.",
  updates_disabled: "Its updates are turned off.",
  version_unreadable: "Couldn't read its version.",
  unsupported_installation: "This installation can't update itself.",
};

export type RuntimeUpdates = ReturnType<typeof useRuntimeUpdates>;

/** Update checks (on mount, cached by the server for an hour; `recheck` asks again) and upgrades. */
export function useRuntimeUpdates() {
  const client = useClient();
  const [updates, setUpdates] = useState<Record<string, RuntimeUpdate>>({});
  // Checking from the start: the first check runs on mount.
  const [checking, setChecking] = useState(true);
  const [upgrading, setUpgrading] = useState<Record<string, true>>({});
  const [results, setResults] = useState<Record<string, UpgradeResult>>({});

  const check = useCallback(
    async (refresh: boolean) => {
      if (client === null) return;
      try {
        if (refresh) await client.runtimes.list({ refresh: true });
        const list = await client.runtimes.updates({ refresh });
        setUpdates(Object.fromEntries(list.map((update) => [update.runtime, update])));
      } catch (error) {
        toast.error(`Checking for updates: ${error instanceof Error ? error.message : String(error)}`);
        report("warn", "settings.runtime_updates_failed", error);
      } finally {
        setChecking(false);
      }
    },
    [client],
  );
  useEffect(() => {
    let cancelled = false;
    // Probe again, so who each runtime is signed in as is current (a terminal may have changed it).
    client?.runtimes.list({ refresh: true }).catch((error: unknown) => {
      report("warn", "settings.runtime_probe_failed", error);
    });
    void (async () => {
      try {
        const list = client === null ? null : await client.runtimes.updates({});
        if (cancelled || list === null) return;
        setUpdates(Object.fromEntries(list.map((update) => [update.runtime, update])));
        setChecking(false);
      } catch (error) {
        if (!cancelled) setChecking(false);
        report("warn", "settings.runtime_updates_failed", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const upgrade = async (runtime: RuntimeInfo): Promise<void> => {
    if (client === null) return;
    setUpgrading((now) => ({ ...now, [runtime.id]: true }));
    try {
      const result = await client.runtimes.upgrade({ runtime: runtime.id });
      setResults((now) => ({ ...now, [runtime.id]: result }));
      if (result.kind === "upgraded") toast.success(`${runtime.name} updated to ${result.to}`);
      if (result.kind === "failed") toast.error(`${runtime.name} didn't update`);
      await check(false);
    } catch (error) {
      toast.error(`Updating ${runtime.name}: ${error instanceof Error ? error.message : String(error)}`);
      report("warn", "settings.runtime_upgrade_failed", error, { runtime: runtime.id });
    } finally {
      setUpgrading(({ [runtime.id]: _done, ...rest }) => rest);
    }
  };

  const recheck = (): void => {
    setChecking(true);
    void check(true);
  };
  return { updates, checking, upgrading, results, upgrade, recheck };
}

export function RuntimeList({
  runtimes,
  updates: { updates, upgrading, results, upgrade },
}: {
  runtimes: readonly RuntimeInfo[];
  updates: RuntimeUpdates;
}) {
  const logins = useRuntimeLogins();
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-card">
      {runtimes.map((runtime) => {
        const update = updates[runtime.id];
        const result = results[runtime.id];
        const busy = upgrading[runtime.id] === true;
        const newer = update?.check.kind === "ok" && update.check.updateAvailable ? update.check : null;
        const note =
          result !== undefined ? resultNote(result) : update === undefined ? null : checkNote(update.check);
        const signedIn = runtime.auth?.kind === "logged_in";
        const loginResult = logins.results[runtime.id];
        const loginNote =
          loginResult === undefined || runtime.login !== null ? null : loginResultNote(loginResult);
        const auth = authNote(runtime.auth);
        return (
          <li key={runtime.id} className="px-3 py-2.5">
            <div className="flex items-center gap-3">
              <StatusDot
                tone={runtime.installed ? "success" : "neutral"}
                label={runtime.installed ? "Installed" : "Not installed"}
              />
              <AgentIcon runtime={runtime.id} label={runtime.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-3">
                  <span className="text-sm font-medium">{runtime.name}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                    {runtime.installed
                      ? (runtime.version ?? "installed")
                      : (runtime.reason ?? "not installed")}
                  </span>
                </div>
                {auth !== null && (
                  <p className="flex gap-2 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate">{auth}</span>
                    {signedIn && runtime.canLogin && runtime.login === null && (
                      <button
                        type="button"
                        className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
                        onClick={() => void logins.start(runtime)}
                      >
                        Sign in again
                      </button>
                    )}
                  </p>
                )}
                {loginNote !== null && <p className="text-xs text-muted-foreground">{loginNote}</p>}
                {newer !== null && !busy && result === undefined && (
                  <p className="text-xs text-muted-foreground">{`${newer.latest} is out`}</p>
                )}
                {busy && (
                  <p className="text-xs text-muted-foreground">Updating… this can take a few minutes.</p>
                )}
                {note !== null && !busy && <p className="text-xs text-muted-foreground">{note}</p>}
                {result?.kind === "failed" && result.output !== "" && (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">What it printed</summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
                      {result.output}
                    </pre>
                  </details>
                )}
              </div>
              {(newer !== null || busy) && update?.canUpgrade === true && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void upgrade(runtime)}>
                  {busy && <LoaderCircle className="animate-spin" />}
                  Update
                </Button>
              )}
              {runtime.canLogin && runtime.login === null && !signedIn && (
                <Button size="sm" variant="outline" onClick={() => void logins.start(runtime)}>
                  Sign in
                </Button>
              )}
            </div>
            {runtime.login !== null && <LoginPanel runtime={runtime} login={runtime.login} logins={logins} />}
          </li>
        );
      })}
    </ul>
  );
}

function checkNote(check: UpdateCheck): string | null {
  if (check.kind === "ok") return null;
  if (check.reason === "no_updater") return check.detail ?? null;
  if (check.reason === "lookup_failed")
    return `Couldn't check for updates${check.detail === undefined ? "" : `: ${check.detail}`}`;
  return UNAVAILABLE[check.reason] ?? null;
}

function resultNote(result: UpgradeResult): string {
  switch (result.kind) {
    case "upgraded":
      return `Updated from ${result.from}. Agents running now keep the old version until their next run.`;
    case "current":
      return "Already the latest version.";
    case "unchanged":
      return `The updater finished, but it's still ${result.version}.`;
    case "failed":
      return `The update failed${result.exitCode === null ? " (it took too long)" : ` (exit code ${result.exitCode})`}.`;
    case "unsupported":
      return result.reason === "requires_terminal"
        ? "Its updater needs a terminal: update it there."
        : (result.detail ?? "This installation can't update itself.");
  }
}
