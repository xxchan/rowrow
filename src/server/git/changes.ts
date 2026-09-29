// Changed files and diffs of a workspace in three scopes (docs/git.md, "Changes"):
// - working: uncommitted changes against HEAD, untracked files included;
// - branch: everything since the merge base with the default branch, uncommitted included;
// - turn: everything since the snapshot taken when the last turn started.
// Looking never writes the repository or takes its index lock: worktree comparisons run
// on a throwaway copy of the index, turn comparisons on snapshot trees. In the working
// scope each file also says whether it is staged and/or has unstaged edits, with a stamp
// for the file actions (./file-actions.ts).
import fs from "node:fs";
import path from "node:path";
import type { ChangedFile, Changes, DiffScope } from "../../shared/schemas.ts";
import { log } from "../telemetry/log.ts";
import { git, gitOk, type GitResult } from "./exec.ts";
import type { SnapshotStore } from "./snapshots.ts";
import { parseStatusRecords, stampBudget, stampOf, STATUS_ARGS, type StatusRecord } from "./status.ts";

export const MAX_FILES = 2000;
export const MAX_PATCH_BYTES = 512 * 1024;
export const LIST_MAX_BYTES = 16 * 1024 * 1024;
/** Untracked files are counted (and diffed) by reading them: not past this size... */
const UNTRACKED_MAX_BYTES = 8 * 1024 * 1024;
/** ...or past this much for one listing. */
const COUNT_BUDGET_BYTES = 64 * 1024 * 1024;

// Plain, predictable output whatever the user's config says: no external diff tools or
// textconv filters, standard a/ and b/ prefixes, renames detected.
export const DIFF = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "-M",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

export interface ChangesInput {
  readonly dir: string;
  readonly scope: DiffScope;
  /** The tree `SnapshotStore.capture` returned when the last turn started (turn scope). */
  readonly turnBaseline?: string | null;
  /** The tree captured when that turn ended; without it the turn is compared with the worktree now. */
  readonly turnEnd?: string | null;
  /**
   * Branch scope: a commit known to be on the default branch that may be newer than this
   * checkout's refs, i.e. the `base` a worktree was created from. `defaultBranch` fetches
   * origin's commit without moving `origin/<default>`, so without this hint the merge base
   * can be older than the worktree's base and upstream commits would count as the branch's.
   */
  readonly defaultBase?: string | null;
  readonly store: SnapshotStore;
}

export interface FileDiffInput extends ChangesInput {
  /** Relative to the top of the worktree, as `listChanges` reports it. */
  readonly path: string;
}

export interface FileDiff {
  readonly patch: string;
  readonly truncated: boolean;
}

type Env = Record<string, string>;

/** What a scope compares, once resolved. */
type Comparison =
  /** A commit (or the empty tree) against the worktree, read through `env`'s index copy. */
  | { kind: "worktree"; top: string; env: Env; rev: string; base: string | null; baseLabel: string }
  /** Two snapshot trees, read through the snapshot store's objects. */
  | { kind: "trees"; top: string; env: Env; from: string; to: string; base: string; baseLabel: string }
  | { kind: "none"; base: string | null; baseLabel: string | null; note: string };

export async function listChanges(input: ChangesInput): Promise<Changes> {
  return compare(input, async (c) => {
    if (c.kind === "none") {
      return {
        scope: input.scope,
        base: c.base,
        baseLabel: c.baseLabel,
        files: [],
        truncated: false,
        note: c.note,
      };
    }
    const revs = c.kind === "trees" ? [c.from, c.to] : [c.rev];
    const diff = ok(
      await git([...DIFF, "--raw", "--numstat", "-z", ...revs, "--"], {
        cwd: c.top,
        env: c.env,
        maxBytes: LIST_MAX_BYTES,
      }),
      "diff",
    );
    let files = parseDiff(diff.stdout);
    let truncated = full(diff.stdout);
    let records: Map<string, StatusRecord> | null = null;
    if (c.kind === "worktree") {
      const status = ok(
        await git(STATUS_ARGS, { cwd: c.top, env: c.env, maxBytes: LIST_MAX_BYTES }),
        "status",
      );
      truncated ||= full(status.stdout);
      records = parseStatusRecords(status.stdout);
      const listed = new Set(files.map((file) => file.path));
      files = files.map((file) =>
        records?.get(file.path)?.kind === "unmerged" ? { ...file, status: "conflicted" } : file,
      );
      for (const record of records.values()) {
        if (record.kind === "untracked" && !listed.has(record.path))
          files.push({
            path: record.path,
            oldPath: null,
            status: "untracked",
            additions: null,
            deletions: null,
          });
      }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    if (files.length > MAX_FILES) {
      files = files.slice(0, MAX_FILES);
      truncated = true;
    }
    if (c.kind === "worktree") files = await countUntracked(c.top, files);
    if (input.scope === "working" && c.kind === "worktree" && records !== null)
      files = await describeWorking(c.top, files, records);
    return { scope: input.scope, base: c.base, baseLabel: c.baseLabel, files, truncated, note: null };
  });
}

/** A working-scope row's paths: the original path first for a rename or copy. */
export function rowPaths(file: Pick<ChangedFile, "path" | "oldPath">): string[] {
  return file.oldPath === null ? [file.path] : [file.oldPath, file.path];
}

/** Whether each file is staged, has unstaged edits, and its stamp for file actions. */
async function describeWorking(
  top: string,
  files: readonly ChangedFile[],
  records: ReadonlyMap<string, StatusRecord>,
): Promise<ChangedFile[]> {
  const budget = stampBudget();
  const described: ChangedFile[] = [];
  for (const file of files) {
    const paths = rowPaths(file);
    const own = paths.flatMap((p) => {
      const record = records.get(p);
      return record === undefined ? [] : [record];
    });
    described.push({
      ...file,
      staged: own.some((r) => r.kind === "changed" && r.x !== "."),
      unstaged: own.some((r) => r.kind === "untracked" || r.kind === "unmerged" || r.y !== "."),
      stamp: await stampOf(top, records, paths, budget),
    });
  }
  return described;
}

/** The unified diff of one file in a scope, cut at 512 KB. */
export async function fileDiff(input: FileDiffInput): Promise<FileDiff> {
  const file = checkPath(input.path);
  return compare(input, async (c) => {
    if (c.kind === "none") throw new Error(c.note);
    if (c.kind === "worktree" && (await isUntracked(c.top, c.env, file))) return untrackedPatch(c.top, file);
    const revs = c.kind === "trees" ? [c.from, c.to] : [c.rev];
    // Rename detection needs both paths in the pathspec; find the old one first.
    const raw = ok(
      await git([...DIFF, "--raw", "-z", ...revs, "--"], {
        cwd: c.top,
        env: c.env,
        maxBytes: LIST_MAX_BYTES,
      }),
      "diff",
    );
    const oldPath = parseDiff(raw.stdout).find((entry) => entry.path === file)?.oldPath ?? null;
    const patch = ok(
      await git([...DIFF, ...revs, "--", ...(oldPath === null ? [file] : [oldPath, file])], {
        cwd: c.top,
        env: { ...c.env, GIT_LITERAL_PATHSPECS: "1" },
        maxBytes: MAX_PATCH_BYTES + 1,
      }),
      "diff",
    );
    return clip(patch.stdout);
  });
}

async function compare<T>(input: ChangesInput, fn: (comparison: Comparison) => Promise<T>): Promise<T> {
  switch (input.scope) {
    case "working":
      return input.store.withIndexCopy(input.dir, async (env, top) => fn(await workingComparison(top, env)));
    case "branch":
      return input.store.withIndexCopy(input.dir, async (env, top) =>
        fn(await branchComparison(top, env, input.defaultBase ?? null)),
      );
    case "turn":
      return fn(await turnComparison(input));
  }
}

async function workingComparison(top: string, env: Env): Promise<Comparison> {
  const head = await revParse(top, env, "HEAD^{commit}");
  if (head === null) {
    // A repository with no commits: everything is new, compared with the empty tree.
    return {
      kind: "worktree",
      top,
      env,
      rev: await emptyTree(top, env),
      base: null,
      baseLabel: "no commits yet",
    };
  }
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: top, env });
  const baseLabel =
    branch.code === 0 ? `${branch.stdout.trim()} @ ${short(head)}` : `HEAD @ ${short(head)} (detached)`;
  return { kind: "worktree", top, env, rev: head, base: head, baseLabel };
}

async function branchComparison(top: string, env: Env, hint: string | null): Promise<Comparison> {
  const none = (note: string): Comparison => ({ kind: "none", base: null, baseLabel: null, note });
  if (hint !== null && !/^[0-9a-f]{40,64}$/.test(hint)) throw new Error(`"${hint}" is not a commit id`);
  const head = await revParse(top, env, "HEAD^{commit}");
  if (head === null) return none("No commits yet, so there is no branch to compare.");
  const target = await defaultBranchRef(top, env);
  if (target === null && hint === null) {
    return none(
      "No default branch to compare with: there is no origin/HEAD, init.defaultBranch, main or master here.",
    );
  }
  const label = target?.label ?? "the default branch";
  const bases: string[] = [];
  for (const tip of [target?.ref, hint]) {
    if (tip === undefined || tip === null) continue;
    const found = await git(["merge-base", head, tip], { cwd: top, env });
    if (found.code === 0) bases.push(found.stdout.trim());
    else if (found.code !== 1 && tip === hint)
      log.warn("git.changes.bad_default_base", { dir: top, hint, stderr: found.stderr });
    else if (found.code !== 1) ok(found, "merge-base");
  }
  const [first, ...rest] = bases;
  if (first === undefined) return none(`HEAD has no history in common with ${label}.`);
  // Both are ancestors of HEAD; the one closer to HEAD is where the branch really forked.
  let base = first;
  for (const other of rest) {
    if (
      other !== base &&
      (await git(["merge-base", "--is-ancestor", base, other], { cwd: top, env })).code === 0
    ) {
      base = other;
    }
  }
  return { kind: "worktree", top, env, rev: base, base, baseLabel: `${label} @ ${short(base)} (merge base)` };
}

/**
 * The default branch as this checkout knows it, without the network: origin's copy when
 * there is one, else the local branch. The name comes from origin/HEAD, init.defaultBranch,
 * then main or master.
 */
async function defaultBranchRef(top: string, env: Env): Promise<{ ref: string; label: string } | null> {
  const names: string[] = [];
  const originHead = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: top, env });
  if (originHead.code === 0) names.push(originHead.stdout.trim().replace(/^refs\/remotes\/origin\//, ""));
  const configured = await git(["config", "--get", "init.defaultBranch"], { cwd: top, env });
  if (configured.code === 0) names.push(configured.stdout.trim());
  names.push("main", "master");
  const candidates = [...new Set(names.filter((name) => name !== ""))].flatMap((name) => [
    { ref: `refs/remotes/origin/${name}`, label: `origin/${name}` },
    { ref: `refs/heads/${name}`, label: name },
  ]);
  const listed = ok(
    await git(["for-each-ref", "--format=%(refname)", ...candidates.map((c) => c.ref)], { cwd: top, env }),
    "for-each-ref",
  );
  const existing = new Set(listed.stdout.split("\n"));
  return candidates.find((candidate) => existing.has(candidate.ref)) ?? null;
}

async function turnComparison(input: ChangesInput): Promise<Comparison> {
  const baseline = input.turnBaseline ?? null;
  if (baseline === null || baseline === "") {
    return {
      kind: "none",
      base: null,
      baseLabel: null,
      note: "No snapshot yet: rowrow takes one when a turn starts.",
    };
  }
  if (!/^[0-9a-f]{40,64}$/.test(baseline)) throw new Error(`"${baseline}" is not a snapshot id`);
  const baseLabel = `start of the turn (snapshot ${short(baseline)})`;
  const end = input.turnEnd ?? null;
  if (end !== null && end !== "") {
    // A finished turn: exactly what changed between its start and its end, whatever happened since.
    if (!/^[0-9a-f]{40,64}$/.test(end)) throw new Error(`"${end}" is not a snapshot id`);
    const env: Env = { ...(await input.store.env(input.dir)), GIT_OPTIONAL_LOCKS: "0" };
    const top = (await gitOk(["rev-parse", "--show-toplevel"], { cwd: input.dir })).trim();
    for (const tree of [baseline, end]) {
      const stored = await git(["cat-file", "-e", `${tree}^{tree}`], { cwd: top, env });
      if (stored.code !== 0) {
        return {
          kind: "none",
          base: baseline,
          baseLabel,
          note: "A snapshot of this turn is no longer stored.",
        };
      }
    }
    return { kind: "trees", top, env, from: baseline, to: end, base: baseline, baseLabel };
  }
  const current = await input.store.capture(input.dir);
  if (current.kind === "refused") {
    return {
      kind: "none",
      base: baseline,
      baseLabel,
      note: `Can't snapshot the worktree to compare: ${current.reason}`,
    };
  }
  const env: Env = { ...(await input.store.env(input.dir)), GIT_OPTIONAL_LOCKS: "0" };
  const top = (await gitOk(["rev-parse", "--show-toplevel"], { cwd: input.dir })).trim();
  const stored = await git(["cat-file", "-e", `${baseline}^{tree}`], { cwd: top, env });
  if (stored.code !== 0) {
    return {
      kind: "none",
      base: baseline,
      baseLabel,
      note: "The snapshot from the start of the turn is no longer stored.",
    };
  }
  return { kind: "trees", top, env, from: baseline, to: current.tree, base: baseline, baseLabel };
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const STATUS: Readonly<Record<string, ChangedFile["status"] | undefined>> = {
  A: "added",
  C: "copied",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "typechange",
  U: "conflicted",
};

/**
 * `git diff --raw -z` records (`:<modes> <oids> <status>\0<path>\0`, two paths for renames
 * and copies), optionally followed by `--numstat -z` records (`<added>\t<deleted>\t<path>\0`,
 * or `<added>\t<deleted>\t\0<old>\0<new>\0`; `-` for binary).
 */
export function parseDiff(out: string): ChangedFile[] {
  const tokens = out.split("\0");
  const files: ChangedFile[] = [];
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i] ?? "";
    if (token === "") {
      i += 1;
    } else if (token.startsWith(":")) {
      const letter = token.slice(token.lastIndexOf(" ") + 1).charAt(0);
      const paired = letter === "R" || letter === "C";
      const from = tokens[i + 1] ?? "";
      const to = paired ? (tokens[i + 2] ?? "") : from;
      if (to !== "") {
        files.push({
          path: to,
          oldPath: paired ? from : null,
          status: STATUS[letter] ?? "modified",
          additions: null,
          deletions: null,
        });
      }
      i += paired ? 3 : 2;
    } else {
      const first = token.indexOf("\t");
      const second = token.indexOf("\t", first + 1);
      if (first === -1 || second === -1) {
        i += 1; // cut off by the output cap
        continue;
      }
      let file = token.slice(second + 1);
      if (file === "") {
        file = tokens[i + 2] ?? "";
        i += 3;
      } else {
        i += 1;
      }
      const number = (text: string): number | null => (text === "-" ? null : Number(text));
      counts.set(file, {
        additions: number(token.slice(0, first)),
        deletions: number(token.slice(first + 1, second)),
      });
    }
  }
  return files.map((file) => ({ ...file, ...counts.get(file.path) }));
}

// ─── Untracked files ─────────────────────────────────────────────────────────

/** git counts a new file's lines as additions; untracked files are counted the same way here. */
async function countUntracked(top: string, files: readonly ChangedFile[]): Promise<ChangedFile[]> {
  let budget = COUNT_BUDGET_BYTES;
  const counted: ChangedFile[] = [];
  for (const file of files) {
    if (file.status !== "untracked") {
      counted.push(file);
      continue;
    }
    const { lines, bytes } = await countLines(path.join(top, file.path), budget);
    budget -= bytes;
    counted.push({ ...file, additions: lines, deletions: lines === null ? null : 0 });
  }
  return counted;
}

/** Lines in a file, or null when binary (a NUL in the first 8000 bytes, as git decides), too big, or gone. */
async function countLines(file: string, budget: number): Promise<{ lines: number | null; bytes: number }> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: null, bytes: 0 };
    throw error;
  }
  if (stat.isSymbolicLink()) return { lines: 1, bytes: 0 }; // git diffs a link as one line: its target
  if (!stat.isFile() || stat.size > UNTRACKED_MAX_BYTES || stat.size > budget)
    return { lines: null, bytes: 0 };
  const data = await fs.promises.readFile(file);
  if (data.subarray(0, 8000).includes(0)) return { lines: null, bytes: data.length };
  let lines = 0;
  for (let at = data.indexOf(10); at !== -1; at = data.indexOf(10, at + 1)) lines += 1;
  if (data.length > 0 && data[data.length - 1] !== 10) lines += 1;
  return { lines, bytes: data.length };
}

async function isUntracked(top: string, env: Env, file: string): Promise<boolean> {
  const status = ok(
    await git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", file], {
      cwd: top,
      env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
    }),
    "status",
  );
  return status.stdout.split("\0").includes(`? ${file}`);
}

async function untrackedPatch(top: string, file: string): Promise<FileDiff> {
  // Diffing a huge file reads all of it; say it's too big instead.
  if ((await fs.promises.lstat(path.join(top, file))).size > UNTRACKED_MAX_BYTES)
    return { patch: "", truncated: true };
  const result = await git(
    [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      "/dev/null",
      file,
    ],
    { cwd: top, maxBytes: MAX_PATCH_BYTES + 1 },
  );
  // --no-index exits 1 when the files differ, which a new file always does.
  if (result.code !== 0 && result.code !== 1) ok(result, "diff --no-index");
  return clip(result.stdout);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A path relative to the worktree that can't point outside it. */
export function checkPath(file: string): string {
  const parts = file.split(/[\\/]/);
  if (file === "" || file.includes("\0") || path.isAbsolute(file) || parts.includes("..")) {
    throw new Error(`invalid path "${file}": it must be relative to the worktree, without ".."`);
  }
  return file;
}

/** Cut a patch at the last whole line within the cap. */
export function clip(patch: string): FileDiff {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.length <= MAX_PATCH_BYTES) return { patch, truncated: false };
  const head = bytes.subarray(0, MAX_PATCH_BYTES);
  const end = head.lastIndexOf(10);
  return { patch: head.subarray(0, end === -1 ? head.length : end + 1).toString("utf8"), truncated: true };
}

/** The result, or a readable error unless git exited 0. */
export function ok(result: GitResult, command: string): GitResult {
  if (result.code !== 0)
    throw new Error(
      `git ${command} failed: ${result.timedOut ? "timed out" : result.stderr || `exit code ${result.code}`}`,
    );
  return result;
}

/** git's output hit the cap, so the list is incomplete. */
function full(stdout: string): boolean {
  return Buffer.byteLength(stdout) >= LIST_MAX_BYTES;
}

async function revParse(top: string, env: Env, rev: string): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "--quiet", rev], { cwd: top, env });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The empty tree's id in this repository's object format (sha1 or sha256); nothing is written. */
export async function emptyTree(top: string, env: Env = {}): Promise<string> {
  return (await gitOk(["hash-object", "-t", "tree", "--stdin"], { cwd: top, env, input: "" })).trim();
}

export function short(id: string): string {
  return id.slice(0, 7);
}
