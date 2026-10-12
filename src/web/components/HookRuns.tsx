// The worktree hooks a repository ran (docs/git.md, "Hook runs"): the workspace page's Hook runs
// list, and the dialog a hook toast's Show output opens. Both show a run's output as the server
// kept it (its last 16 K characters), without terminal escapes.
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronRight, CircleCheck, CircleX } from "lucide-react";
import { useEffect, useState } from "react";
import { runDuration, terminalText } from "../../shared/commands.ts";
import { hookOutcome } from "../../shared/hook-runs.ts";
import type { AppState, Workspace, WorktreeHookRun } from "../../shared/schemas.ts";
import { ago } from "../lib/format.ts";
import { useHookRuns } from "../lib/hook-runs.ts";
import { useApp, useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { useNow } from "../lib/use-now.ts";
import { useWorktreeHooks } from "./HookReview.tsx";

/** The ids of a repository's workspaces, as one string that changes when one comes or goes. */
function membersOf(state: AppState | null, repoKey: string): string {
  return Object.values(state?.workspaces ?? {})
    .filter((w) => w.git?.repoKey === repoKey)
    .map((w) => w.id)
    .sort()
    .join(" ");
}

/**
 * A git workspace's repository's recent runs, and whether it has a hook file at all; null while
 * loading, and for a folder that isn't a git repository.
 */
export function useRepoHookRuns(ws: Workspace): { runs: WorktreeHookRun[]; configured: boolean } | null {
  const client = useClient();
  const id = ws.id;
  const repoKey = ws.git?.repoKey ?? null;
  const hooks = useWorktreeHooks(repoKey === null || ws.missing ? null : id, "create");
  const [loaded, setLoaded] = useState<{ id: string; runs: WorktreeHookRun[] } | null>(null);
  useEffect(() => {
    if (client === null || repoKey === null) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      // Gone itself (this worktree was just removed): so is the page that asked.
      if (useApp.getState().state?.workspaces[id] === undefined) return;
      try {
        const runs = await client.workspaces.hookRuns({ id });
        if (!cancelled) setLoaded({ id, runs });
      } catch (error) {
        // An answer nobody waits for (the page moved on, as it does when this worktree is removed).
        if (!cancelled) report("warn", "worktree.hook_runs_read_failed", error, { workspaceId: id });
      }
    };
    void load();
    // Hooks run when a worktree is made or removed, here or on another device: read them again
    // when one of the repository's workspaces comes or goes, and when this browser just ran some.
    let members = membersOf(useApp.getState().state, repoKey);
    const stopApp = useApp.subscribe((app) => {
      const next = membersOf(app.state, repoKey);
      if (next === members) return;
      members = next;
      void load();
    });
    const stopMade = useHookRuns.subscribe((now, before) => {
      if (now.made !== before.made) void load();
    });
    return () => {
      cancelled = true;
      stopApp();
      stopMade();
    };
  }, [client, id, repoKey]);
  if (repoKey === null || loaded?.id !== id) return null;
  return { runs: loaded.runs, configured: hooks?.config != null };
}

/** The Hook runs list: one line per run, newest first; a line opens to the run's output. */
export function HookRunList({ runs }: { runs: readonly WorktreeHookRun[] }) {
  const now = useNow(30_000);
  if (runs.length === 0)
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        No hook has run yet. A new worktree runs setup; removing one runs teardown and removed; archiving runs
        none.
      </p>
    );
  return (
    <ul aria-label="Hook runs" className="divide-y overflow-hidden rounded-lg border bg-card">
      {runs.map((run) => (
        <li key={run.id}>
          <Collapsible className="group/run">
            <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent/60">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/run:rotate-90" />
              <RunMark run={run} />
              <span className="shrink-0 font-medium">{run.event}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{run.worktreeLabel}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {[run.ok ? null : hookOutcome(run), runDuration(run.ms), when(run.at, now)]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t bg-muted/30 px-3 py-2">
              <RunOutput run={run} />
            </CollapsibleContent>
          </Collapsible>
        </li>
      ))}
    </ul>
  );
}

/** Mounted once, in the Shell: what Show output on a hook toast opens. */
export function HookOutputDialog() {
  const runs = useHookRuns((s) => s.open);
  const now = useNow(30_000);
  const first = runs?.[0];
  return (
    <Dialog
      open={runs !== null}
      onOpenChange={(next) => (next ? undefined : useHookRuns.setState({ open: null }))}
    >
      <DialogContent className="max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Hook output</DialogTitle>
          <DialogDescription className="break-all">
            {first === undefined
              ? ""
              : `${first.worktreeLabel} · ${first.config.split("/").at(-1) ?? first.config}${first.legacy ? " (legacy compatibility)" : ""}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
          {(runs ?? []).map((run) => (
            <section key={run.id} aria-label={`${run.event} hook`} className="flex min-w-0 flex-col gap-1.5">
              <h3 className="flex items-center gap-2 text-sm">
                <RunMark run={run} />
                <span className="font-medium">{run.event}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {[hookOutcome(run), runDuration(run.ms), when(run.at, now)].join(" · ")}
                </span>
              </h3>
              <RunOutput run={run} />
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function when(at: number, now: number): string {
  const since = ago(at, now);
  return since === "now" ? "just now" : `${since} ago`;
}

function RunMark({ run }: { run: WorktreeHookRun }) {
  return run.ok ? (
    <CircleCheck aria-label="Succeeded" className="size-4 shrink-0 text-success" />
  ) : (
    <CircleX aria-label="Failed" className="size-4 shrink-0 text-destructive" />
  );
}

function RunOutput({ run }: { run: WorktreeHookRun }) {
  const text = terminalText(run.output).replace(/\s+$/, "");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <code className="font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">{`$ ${run.command}`}</code>
      {text === "" ? (
        <p className="text-xs text-muted-foreground">It printed nothing.</p>
      ) : (
        <pre
          aria-label="Output"
          tabIndex={0}
          className="max-h-72 overflow-auto rounded-md border bg-background px-2.5 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap"
        >
          {text}
        </pre>
      )}
    </div>
  );
}
