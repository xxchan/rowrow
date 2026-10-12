// The worktree hooks rowrow ran (docs/git.md, "Hook runs"). Each run is a fact in the database:
// the newest HOOK_RUNS_KEPT per repository, with the end of their output, so "did my hook run,
// and what did it say?" still has an answer once the toast is gone. A repository is its git
// common dir, which every worktree of it shares and which outlives the worktrees.
import { HOOK_OUTPUT_CHARS, HOOK_RUNS_KEPT } from "../../shared/hook-runs.ts";
import { newId } from "../../shared/ids.ts";
import type { WorktreeHookRun } from "../../shared/schemas.ts";
import type { Db } from "../store/db.ts";

interface Row {
  id: string;
  repo_key: string;
  workspace_id: string;
  event: WorktreeHookRun["event"];
  worktree_path: string;
  worktree_label: string;
  config: string;
  legacy: number;
  command: string;
  ok: number;
  code: number | null;
  timed_out: number;
  ms: number;
  output: string;
  at: number;
}

/** Keep a run (only the end of its output), and drop the repository's runs beyond the newest 20. */
export function recordHookRun(db: Db, run: Omit<WorktreeHookRun, "id">): WorktreeHookRun {
  const dropped = run.output.length - HOOK_OUTPUT_CHARS;
  const record: WorktreeHookRun = {
    ...run,
    id: newId("hk"),
    output:
      dropped > 0
        ? `[${dropped.toLocaleString("en-US")} earlier characters of output dropped]\n${run.output.slice(dropped)}`
        : run.output,
  };
  db.transaction(() => {
    db.run(
      `insert into hook_runs (id, repo_key, workspace_id, event, worktree_path, worktree_label, config, legacy,
         command, ok, code, timed_out, ms, output, at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.repoKey,
      record.workspaceId,
      record.event,
      record.worktreePath,
      record.worktreeLabel,
      record.config,
      record.legacy ? 1 : 0,
      record.command,
      record.ok ? 1 : 0,
      record.code,
      record.timedOut ? 1 : 0,
      record.ms,
      record.output,
      record.at,
    );
    db.run(
      `delete from hook_runs where repo_key = ? and id not in
         (select id from hook_runs where repo_key = ? order by at desc, rowid desc limit ?)`,
      record.repoKey,
      record.repoKey,
      HOOK_RUNS_KEPT,
    );
  });
  return record;
}

/** A repository's runs, newest first. */
export function listHookRuns(db: Db, repoKey: string): WorktreeHookRun[] {
  return db
    .all<Row>("select * from hook_runs where repo_key = ? order by at desc, rowid desc", repoKey)
    .map((row) => ({
      id: row.id,
      event: row.event,
      repoKey: row.repo_key,
      workspaceId: row.workspace_id,
      worktreePath: row.worktree_path,
      worktreeLabel: row.worktree_label,
      config: row.config,
      legacy: row.legacy === 1,
      command: row.command,
      ok: row.ok === 1,
      code: row.code,
      timedOut: row.timed_out === 1,
      ms: row.ms,
      output: row.output,
      at: row.at,
    }));
}

/** With the last workspace of a repository rowrow knows (D-047): returns how many went. */
export function forgetHookRuns(db: Db, repoKey: string): number {
  return db.run("delete from hook_runs where repo_key = ?", repoKey).changes;
}
