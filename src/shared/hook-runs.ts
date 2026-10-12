// Worktree hook runs (docs/git.md, "Hook runs"): how much of each the server keeps, and how the
// web app and the CLI say how one ended. Pure, for the server, the web app and the CLI alike.
import type { WorktreeHookRun } from "./schemas.ts";

/** Runs kept per repository; older ones are dropped. */
export const HOOK_RUNS_KEPT = 20;
/** The end of a run's output kept with it: when a hook fails, the end says why. */
export const HOOK_OUTPUT_CHARS = 16 * 1024;

type Outcome = Pick<WorktreeHookRun, "ok" | "code" | "timedOut">;

/** How it ended, in a few words: "ok", "exit 1", "timed out", "no exit code" (killed, or it couldn't start). */
export function hookOutcome(run: Outcome): string {
  if (run.timedOut) return "timed out";
  if (run.ok) return "ok";
  return run.code === null ? "no exit code" : `exit ${run.code}`;
}

function failure(run: Outcome): string {
  return run.timedOut ? "timed out" : `failed (${hookOutcome(run)})`;
}

function and(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * What a toast says about the hooks an action ran: "Its teardown and removed hooks ran.", "Its
 * teardown hook ran, but its removed hook failed (exit 1).", "Its setup hook timed out."; null
 * when none ran, so an action without hooks says nothing about them.
 */
export function hookRunsSentence(
  runs: readonly Pick<WorktreeHookRun, "event" | keyof Outcome>[],
): string | null {
  if (runs.length === 0) return null;
  const ran = runs.filter((run) => run.ok).map((run) => run.event);
  const failed = runs.filter((run) => !run.ok).map((run) => `its ${run.event} hook ${failure(run)}`);
  if (failed.length === 0) return `Its ${and(ran)} hook${ran.length === 1 ? "" : "s"} ran.`;
  const why = failed.join(" and ");
  if (ran.length === 0) return `I${why.slice(1)}.`;
  return `Its ${and(ran)} hook${ran.length === 1 ? "" : "s"} ran, but ${why}.`;
}
