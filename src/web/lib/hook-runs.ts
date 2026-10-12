// Saying which worktree hooks an action ran, right when it ran (docs/git.md, "Hook runs"): one
// toast that names them and how they ended, with their output a click away (HookOutputDialog).
import { toast } from "sonner";
import { create } from "zustand";
import { hookRunsSentence } from "../../shared/hook-runs.ts";
import type { WorktreeHookRun } from "../../shared/schemas.ts";

/**
 * The runs whose output is open, and a count that moves when this browser made a hook run without
 * a worktree coming or going (a teardown that failed): the Hook runs section reads them again.
 */
export const useHookRuns = create<{ open: readonly WorktreeHookRun[] | null; made: number }>(() => ({
  open: null,
  made: 0,
}));

export function showHookOutput(runs: readonly WorktreeHookRun[]): void {
  useHookRuns.setState({ open: runs });
}

export function hookRunsChanged(): void {
  useHookRuns.setState((s) => ({ made: s.made + 1 }));
}

/**
 * One toast for an action that ran hooks: what was done ("Removed the worktree; branch x is
 * kept."), then "Its teardown and removed hooks ran.", a warning when one failed, and Show output.
 * Nothing when it ran none: the caller says what it says without hooks.
 */
export function announceHookRuns(done: string, runs: readonly WorktreeHookRun[], failedAction = false): void {
  const sentence = hookRunsSentence(runs);
  if (sentence === null) return;
  const failed = runs.some((run) => !run.ok);
  const options = {
    description: sentence,
    action: { label: "Show output", onClick: () => showHookOutput(runs) },
    // Long enough to reach Show output when something went wrong.
    ...(failed ? { duration: 15_000 } : {}),
  };
  if (failedAction) toast.error(done, options);
  else if (failed) toast.warning(done, options);
  else toast.success(done, options);
}
