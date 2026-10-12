// Worktree hook runs (docs/git.md, "Hook runs"): what the database keeps of them, and how a toast
// and the CLI say how they ended.
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_OUTPUT_CHARS, HOOK_RUNS_KEPT, hookOutcome, hookRunsSentence } from "../src/shared/hook-runs.ts";
import type { WorktreeHookRun } from "../src/shared/schemas.ts";
import { Db } from "../src/server/store/db.ts";
import { forgetHookRuns, listHookRuns, recordHookRun } from "../src/server/workspaces/hook-runs.ts";

const run = (overrides: Partial<WorktreeHookRun> = {}): Omit<WorktreeHookRun, "id"> => ({
  event: "setup",
  repoKey: "/repo/.git",
  workspaceId: "ws_1",
  worktreePath: "/worktrees/x",
  worktreeLabel: "x",
  config: "/repo/rowrow.json",
  legacy: false,
  command: "pnpm install",
  ok: true,
  code: 0,
  timedOut: false,
  ms: 1200,
  output: "done\n",
  at: 1,
  ...overrides,
});

describe("the hook runs a repository keeps", () => {
  let db: Db | undefined;
  afterEach(() => db?.close());

  it("keeps the newest 20 per repository, newest first, with the end of their output", () => {
    db = new Db(":memory:");
    for (let at = 1; at <= HOOK_RUNS_KEPT + 5; at++) recordHookRun(db, run({ at, worktreeLabel: `wt${at}` }));
    recordHookRun(db, run({ repoKey: "/other/.git", at: 2 }));
    const kept = listHookRuns(db, "/repo/.git");
    expect(kept).toHaveLength(HOOK_RUNS_KEPT);
    expect(kept[0]?.worktreeLabel).toBe(`wt${HOOK_RUNS_KEPT + 5}`);
    expect(kept.at(-1)?.worktreeLabel).toBe("wt6");
    expect(listHookRuns(db, "/other/.git")).toHaveLength(1);

    const long = recordHookRun(
      db,
      run({ ok: false, code: 1, output: `${"x".repeat(100)}${"y".repeat(HOOK_OUTPUT_CHARS)}`, at: 99 }),
    );
    expect(long.output).toBe(`[100 earlier characters of output dropped]\n${"y".repeat(HOOK_OUTPUT_CHARS)}`);
    expect(listHookRuns(db, "/repo/.git")[0]).toEqual(long);

    expect(forgetHookRuns(db, "/repo/.git")).toBe(HOOK_RUNS_KEPT);
    expect(listHookRuns(db, "/repo/.git")).toEqual([]);
  });
});

describe("how a hook run ended, in words", () => {
  it("says the outcome in a few words", () => {
    expect(hookOutcome({ ok: true, code: 0, timedOut: false })).toBe("ok");
    expect(hookOutcome({ ok: false, code: 2, timedOut: false })).toBe("exit 2");
    expect(hookOutcome({ ok: false, code: null, timedOut: true })).toBe("timed out");
    expect(hookOutcome({ ok: false, code: null, timedOut: false })).toBe("no exit code");
  });

  it("names the hooks an action ran and how they ended, and nothing when none ran", () => {
    const ok = { ok: true, code: 0, timedOut: false };
    expect(hookRunsSentence([])).toBeNull();
    expect(hookRunsSentence([{ event: "setup", ...ok }])).toBe("Its setup hook ran.");
    expect(
      hookRunsSentence([
        { event: "teardown", ...ok },
        { event: "removed", ...ok },
      ]),
    ).toBe("Its teardown and removed hooks ran.");
    expect(
      hookRunsSentence([
        { event: "teardown", ...ok },
        { event: "removed", ok: false, code: 1, timedOut: false },
      ]),
    ).toBe("Its teardown hook ran, but its removed hook failed (exit 1).");
    expect(hookRunsSentence([{ event: "setup", ok: false, code: null, timedOut: true }])).toBe(
      "Its setup hook timed out.",
    );
  });
});
