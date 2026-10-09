// Before rowrow runs a repository's worktree hooks, which file they come from and what they
// will run (roamgate #296: its hook dialogs show the effective config path and whether it's
// native or legacy). Hooks run without asking (docs/git.md, "Hooks"), so the dialogs that
// create or remove a worktree are where you read them.
import { cn } from "@/lib/utils";
import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorktreeHooks } from "../../shared/schemas.ts";
import { useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";

const LABELS = { setup: "Setup", opened: "Opened", teardown: "Teardown", removed: "Removed" } as const;
type HookEvent = keyof typeof LABELS;

export function HookReview({
  workspaceId,
  action,
  quiet = false,
  className,
}: {
  workspaceId: string;
  /** A new worktree from this checkout (its setup hook), or removing this one (teardown, removed). */
  action: "create" | "remove";
  /** Nothing at all when the repository has no hook file (the new-agent form). */
  quiet?: boolean;
  className?: string;
}) {
  const client = useClient();
  const key = `${workspaceId}:${action}`;
  // What was read, for which workspace and action: another one's answer is no answer.
  const [loaded, setLoaded] = useState<{ key: string; hooks: WorktreeHooks } | null>(null);
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      let hooks: WorktreeHooks;
      try {
        hooks = await client.workspaces.hooks({ id: workspaceId, action });
      } catch (error) {
        report("warn", "worktree.hooks_read_failed", error, { workspaceId });
        hooks = { config: null, error: error instanceof Error ? error.message : String(error) };
      }
      if (!cancelled) setLoaded({ key: `${workspaceId}:${action}`, hooks });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, action]);
  const hooks = loaded?.key === key ? loaded.hooks : null;
  if (hooks === null || (quiet && hooks.config === null && hooks.error === null)) return null;

  const { config, error } = hooks;
  const events: HookEvent[] = action === "create" ? ["setup"] : ["teardown", "removed"];
  const runs = events.flatMap((event) => {
    const command = config?.hooks[event];
    return command === undefined ? [] : [{ event, command }];
  });
  const configured = config === null ? 0 : Object.values(config.hooks).filter(Boolean).length;
  return (
    <section
      aria-label="Repository hooks"
      className={cn("flex min-w-0 gap-2.5 rounded-md border bg-muted/40 px-3 py-2 text-xs", className)}
    >
      <Settings className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="font-medium">Repository hooks</strong>
        <span className="text-muted-foreground">
          {config === null
            ? "No worktree hook configuration found"
            : `${configured} configured · ${config.file} (${config.legacy ? "legacy compatibility" : "native"})`}
        </span>
        {config !== null && (
          <span className="font-mono text-[11px] break-all text-muted-foreground">{config.path}</span>
        )}
        {runs.map(({ event, command }) => (
          <span key={event} className="flex gap-1.5 pt-0.5">
            <span className="shrink-0 text-muted-foreground">{LABELS[event]}</span>
            <code className="min-w-0 font-mono break-all whitespace-pre-wrap">{command}</code>
          </span>
        ))}
        {config !== null && runs.length === 0 && (
          <span className="text-muted-foreground">
            {`No ${events.map((event) => LABELS[event].toLowerCase()).join(" or ")} hook: nothing runs.`}
          </span>
        )}
        {error !== null && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
