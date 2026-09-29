// Narrow git mutations of a working tree (roamgate #71, docs/git.md "File actions"): stage,
// unstage, discard unstaged edits, delete an untracked file, mark a conflict resolved, and
// the same for every file at once. Never an arbitrary git command: each action is one fixed
// git invocation, with literal pathspecs after `--`, on paths git itself reports as changed.
//
// Every action first re-reads the files' state and compares it with the stamps the client
// saw (./status.ts). Anything different, including a file the client never saw, refuses the
// whole action with a StaleError: newer work is never staged, discarded or deleted unseen.
import fs from "node:fs";
import path from "node:path";
import type { BulkAction, FileAction, SeenFile } from "../../shared/schemas.ts";
import { LIST_MAX_BYTES, rowPaths } from "./changes.ts";
import { git, type GitResult } from "./exec.ts";
import type { SnapshotStore } from "./snapshots.ts";
import {
  parseStatusRecords,
  sameStamp,
  stampBudget,
  stampOf,
  STATUS_ARGS,
  type StatusRecord,
} from "./status.ts";

/** The files changed since the client listed them. */
export class StaleError extends Error {}
/** The action doesn't apply to the files as they are (nothing staged, not untracked, ...). */
export class ActionRefused extends Error {}

/** Staging a big file hashes all of it. */
const ACTION_TIMEOUT_MS = 60_000;
/** `git clean` takes no pathspec file; paths go on its command line in batches. */
const CLEAN_BATCH = 100;
/** Pathspecs are literal: `*.txt` or `:(top)x` name those files and nothing else. */
const LITERAL = { GIT_LITERAL_PATHSPECS: "1" } as const;

/**
 * A path as git.changes lists it: relative to the top of the worktree, normalized, and not
 * inside `.git`. Leading dashes, spaces, quotes and any Unicode are fine (argv after `--`).
 */
export function checkActionPath(file: string): string {
  const parts = file.split("/");
  if (
    file === "" ||
    file.includes("\0") ||
    path.isAbsolute(file) ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    file.split(/[\\/]/).includes("..")
  ) {
    throw new ActionRefused(
      `invalid path "${file}": use the path as git.changes lists it (relative to the worktree, without "." or "..")`,
    );
  }
  if (parts.some((part) => part.toLowerCase() === ".git"))
    throw new ActionRefused(`"${file}" is inside .git: file actions only change the working tree`);
  return file;
}

export interface FileActionInput {
  readonly dir: string;
  readonly store: SnapshotStore;
  readonly action: FileAction;
  readonly file: SeenFile;
}

/** One file (a rename: both of its paths). Returns the paths git was run on. */
export async function applyFileAction(input: FileActionInput): Promise<{ paths: string[] }> {
  const { file, action } = input;
  const paths = rowPaths({
    path: checkActionPath(file.path),
    oldPath: file.oldPath === undefined || file.oldPath === null ? null : checkActionPath(file.oldPath),
  });
  const { top, records } = await readState(input.store, input.dir);
  const now = await stampOf(top, records, paths, stampBudget());
  if (!sameStamp(file.stamp, now)) throw stale(file.path);
  const own = paths.flatMap((p) => {
    const record = records.get(p);
    return record === undefined ? [] : [record];
  });
  const targets = await targetsOf(action, file.path, own, top);
  await execute(action, top, targets);
  return { paths: targets };
}

export interface BulkActionInput {
  readonly dir: string;
  readonly store: SnapshotStore;
  readonly action: BulkAction;
  /** The rows of the working-scope list the client saw (all of them, or those the action touches). */
  readonly seen: readonly SeenFile[];
}

/** Every file the action applies to; each must be a row the client saw, unchanged. */
export async function applyBulkAction(input: BulkActionInput): Promise<{ paths: string[] }> {
  const rows = input.seen.map((file) => ({
    file,
    paths: rowPaths({
      path: checkActionPath(file.path),
      oldPath: file.oldPath === undefined || file.oldPath === null ? null : checkActionPath(file.oldPath),
    }),
  }));
  const rowOf = new Map<string, (typeof rows)[number]>();
  for (const row of rows) for (const p of row.paths) rowOf.set(p, row);

  const { top, records } = await readState(input.store, input.dir);
  const affected = [...records.values()]
    .filter((record) => affects(input.action, record))
    .map((record) => record.path)
    .sort();
  if (affected.length === 0) throw new ActionRefused(NOTHING[input.action]);
  const unseen = affected.filter((p) => !rowOf.has(p));
  if (unseen.length > 0) {
    throw new StaleError(
      `${unseen.length === 1 ? `${unseen[0]} wasn't` : `${unseen.length} files (${unseen[0]}, …) weren't`} in the list you acted on: refresh and try again`,
    );
  }
  const budget = stampBudget();
  for (const row of new Set(affected.map((p) => rowOf.get(p)))) {
    if (row === undefined) continue;
    if (!sameStamp(row.file.stamp, await stampOf(top, records, row.paths, budget)))
      throw stale(row.file.path);
  }
  await executeBulk(input.action, top, affected);
  return { paths: affected };
}

// ─── What an action touches ──────────────────────────────────────────────────

const NOTHING: Record<BulkAction, string> = {
  stageAll: "Nothing to stage.",
  unstageAll: "Nothing is staged.",
  discardAllUnstaged: "There are no unstaged changes to discard.",
  deleteAllUntracked: "There are no untracked files.",
};

/** Which records a bulk action applies to. Conflicts are never touched by one. */
function affects(action: BulkAction, record: StatusRecord): boolean {
  switch (action) {
    case "stageAll":
      return (
        (record.kind === "untracked" && !record.path.endsWith("/")) ||
        (record.kind === "changed" && record.y !== ".")
      );
    case "unstageAll":
      return record.kind === "changed" && record.x !== ".";
    case "discardAllUnstaged":
      return discardable(record);
    case "deleteAllUntracked":
      return record.kind === "untracked" && !record.path.endsWith("/");
  }
}

/**
 * Unstaged edits `git restore --worktree` can drop, restoring the staged version. Not a
 * submodule (its files are another repository's), and not an intent-to-add entry, which
 * restore would empty.
 */
function discardable(record: StatusRecord): boolean {
  return record.kind === "changed" && record.y !== "." && record.y !== "A" && !record.submodule;
}

async function targetsOf(
  action: FileAction,
  file: string,
  own: readonly StatusRecord[],
  top: string,
): Promise<string[]> {
  const conflicted = own.some((r) => r.kind === "unmerged");
  if (conflicted && action !== "markResolved")
    throw new ActionRefused(`${file} has a merge conflict: resolve it, then mark it resolved`);
  switch (action) {
    case "stage": {
      if (own.some((r) => r.kind === "untracked" && r.path.endsWith("/")))
        throw new ActionRefused(`${file} is another git repository: add it as a submodule yourself`);
      const targets = own.filter((r) => r.kind === "untracked" || r.y !== ".").map((r) => r.path);
      if (targets.length === 0) throw new ActionRefused(`${file} has no unstaged changes to stage`);
      return targets;
    }
    case "unstage": {
      const targets = own.filter((r) => r.kind === "changed" && r.x !== ".").map((r) => r.path);
      if (targets.length === 0) throw new ActionRefused(`${file} has nothing staged`);
      return targets;
    }
    case "discardUnstaged": {
      const edited = own.filter((r) => r.kind === "changed" && r.y !== ".");
      if (edited.some((r) => r.submodule))
        throw new ActionRefused(`${file} is a submodule: discard changes inside it with git`);
      if (edited.some((r) => r.y === "A"))
        throw new ActionRefused(`${file} was added with --intent-to-add: unstage it instead`);
      if (edited.length === 0)
        throw new ActionRefused(
          own.some((r) => r.kind === "untracked")
            ? `${file} is untracked: delete it instead`
            : `${file} has no unstaged changes`,
        );
      return edited.map((r) => r.path);
    }
    case "deleteUntracked": {
      const [record, ...more] = own;
      if (record?.kind !== "untracked" || more.length > 0)
        throw new ActionRefused(`${file} isn't an untracked file`);
      if (record.path.endsWith("/"))
        throw new ActionRefused(`${file} is another git repository: delete it yourself if you mean to`);
      const stat = await fs.promises.lstat(path.join(top, record.path));
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new ActionRefused(`${file} isn't a file`);
      return [record.path];
    }
    case "markResolved": {
      const [record, ...more] = own;
      if (record?.kind !== "unmerged" || more.length > 0)
        throw new ActionRefused(`${file} has no merge conflict to resolve`);
      const marker = await conflictMarker(path.join(top, record.path));
      if (marker !== null)
        throw new ActionRefused(
          `${file} still has a conflict marker on line ${marker}: resolve it first (or run git add yourself if it belongs there)`,
        );
      return [record.path];
    }
  }
}

/** The first line that starts with a conflict marker git writes (`<<<<<<<` or `>>>>>>>`), or null. */
async function conflictMarker(file: string): Promise<number | null> {
  let data: Buffer;
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    data = await fs.promises.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; // resolved by deleting it
    throw error;
  }
  const lines = data.toString("utf8").split("\n");
  const index = lines.findIndex((line) => /^(<{7}|>{7})( |\r?$)/.test(line));
  return index === -1 ? null : index + 1;
}

// ─── Running them ────────────────────────────────────────────────────────────

async function readState(
  store: SnapshotStore,
  dir: string,
): Promise<{ top: string; records: Map<string, StatusRecord> }> {
  // Read through an index copy, as the listing does: looking never takes the index lock.
  return store.withIndexCopy(dir, async (env, top) => {
    const status = await git(STATUS_ARGS, { cwd: top, env, maxBytes: LIST_MAX_BYTES });
    if (status.code !== 0) throw failed("status", status);
    if (status.capped)
      throw new ActionRefused("Too many changed files to act on them safely here: use git directly.");
    return { top, records: parseStatusRecords(status.stdout) };
  });
}

async function execute(action: FileAction, top: string, targets: readonly string[]): Promise<void> {
  switch (action) {
    case "stage":
    case "markResolved":
      await mutate(top, ["add", "--", ...targets]);
      return;
    case "unstage":
      // `reset` also works before the first commit, where `restore --staged` can't find HEAD.
      await mutate(top, ["reset", "-q", "--", ...targets]);
      return;
    case "discardUnstaged":
      await mutate(top, ["restore", "--worktree", "--", ...targets]);
      return;
    case "deleteUntracked":
      await clean(top, targets);
      return;
  }
}

async function executeBulk(action: BulkAction, top: string, paths: readonly string[]): Promise<void> {
  const fromStdin = ["--pathspec-from-file=-", "--pathspec-file-nul"];
  const input = `${paths.join("\0")}\0`;
  switch (action) {
    case "stageAll":
      await mutate(top, ["add", ...fromStdin], input);
      return;
    case "unstageAll":
      await mutate(top, ["reset", "-q", ...fromStdin], input);
      return;
    case "discardAllUnstaged":
      await mutate(top, ["restore", "--worktree", ...fromStdin], input);
      return;
    case "deleteAllUntracked":
      await clean(top, paths);
      return;
  }
}

/** `git clean` removes only untracked, unignored files: whatever else a path became, it stays. */
async function clean(top: string, paths: readonly string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += CLEAN_BATCH)
    await mutate(top, ["clean", "-f", "-q", "--", ...paths.slice(i, i + CLEAN_BATCH)]);
  const left: string[] = [];
  for (const file of paths) {
    try {
      await fs.promises.lstat(path.join(top, file));
      left.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (left.length > 0) throw new Error(`git clean left ${left.length} file(s) in place, e.g. ${left[0]}`);
}

async function mutate(top: string, args: readonly string[], input?: string): Promise<void> {
  const result = await git(args, {
    cwd: top,
    env: LITERAL,
    timeoutMs: ACTION_TIMEOUT_MS,
    ...(input === undefined ? {} : { input }),
  });
  if (result.code === 0) return;
  if (/index\.lock/.test(result.stderr))
    throw new ActionRefused(
      "Another git command is using this repository (index.lock): try again in a moment.",
    );
  throw failed(args[0] ?? "", result);
}

function stale(file: string): StaleError {
  return new StaleError(`${file} changed since this list was loaded: refresh and try again`);
}

function failed(command: string, result: GitResult): Error {
  return new Error(
    `git ${command} failed: ${result.timedOut ? "timed out" : result.stderr || `exit code ${result.code}`}`,
  );
}
