// Linked worktrees for agents (docs/git.md). A new worktree gets a new branch based on the
// commit origin's default branch points at right now: asked of origin itself, because a
// local `origin/HEAD` can be stale or missing and the default is not always `main`.
// Removing a worktree never deletes its branch, and never discards changes unless forced.
import fs from "node:fs";
import path from "node:path";
import { log } from "../telemetry/log.ts";
import { git, gitOk } from "./exec.ts";
import { randomBranchName, slugify } from "./names.ts";

/** Anything that talks to origin: a hung network or credential helper must not hang rowrow. */
const NETWORK_TIMEOUT_MS = 30_000;
/** Checking out (or deleting) a large tree is local but can be slow. */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;

export interface DefaultBranch {
  readonly name: string;
  readonly commit: string;
}

/**
 * origin's default branch and its current commit, which is fetched (by object id, so no
 * remote-tracking ref or FETCH_HEAD is rewritten). null when there is no `origin` remote,
 * or origin has no commits yet; callers then fall back to local HEAD. Throws when origin
 * can't be reached, rather than silently basing work on something older.
 */
export async function defaultBranch(repoDir: string): Promise<DefaultBranch | null> {
  const remotes = (await gitOk(["remote"], { cwd: repoDir })).split("\n");
  if (!remotes.includes("origin")) return null;
  const listed = await git(["ls-remote", "--symref", "origin", "HEAD"], {
    cwd: repoDir,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (listed.code !== 0) {
    throw new Error(
      `cannot ask origin for its default branch (${listed.timedOut ? "timed out" : listed.stderr}); pass an explicit base to work offline`,
    );
  }
  const { name, commit } = parseLsRemote(listed.stdout);
  if (commit === null) {
    log.info("git.default_branch.empty", { repo: repoDir });
    return null;
  }
  if (name === null)
    throw new Error("origin did not say which branch its HEAD points to; pass an explicit base");
  const fetched = await git(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "origin",
      commit,
    ],
    { cwd: repoDir, timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (fetched.code !== 0) {
    throw new Error(`cannot fetch origin/${name} (${fetched.timedOut ? "timed out" : fetched.stderr})`);
  }
  log.info("git.default_branch", { repo: repoDir, name, commit });
  return { name, commit };
}

/** `git ls-remote --symref origin HEAD`: `ref: refs/heads/<name>\tHEAD` and `<oid>\tHEAD`. */
export function parseLsRemote(out: string): { name: string | null; commit: string | null } {
  let name: string | null = null;
  let commit: string | null = null;
  for (const line of out.split("\n")) {
    const [left = "", right = ""] = line.split("\t");
    if (right !== "HEAD") continue;
    if (left.startsWith("ref: refs/heads/")) name = left.slice("ref: refs/heads/".length);
    else if (/^[0-9a-f]{40,64}$/.test(left)) commit = left;
  }
  return { name, commit };
}

export interface CreateWorktreeInput {
  /** Any checkout of the repository. */
  readonly repoDir: string;
  /** Worktrees live at `<root>/<repository name>/<branch slug>`. */
  readonly root: string;
  /** Defaults to a random `rowrow/<adjective>-<noun>-<hex>`. An existing branch is checked out as is. */
  readonly branch?: string;
  /** A commit-ish for a new branch. Defaults to origin's default branch, else local HEAD. */
  readonly base?: string;
  /** Refuse a branch that already exists instead of checking it out. */
  readonly newBranch?: boolean;
}

export interface CreatedWorktree {
  /** The real path (symlinks resolved, as git reports it). */
  readonly path: string;
  readonly branch: string;
  /** The commit the worktree starts at. */
  readonly base: string;
  /** For people: `origin/main @ 1a2b3c4`. */
  readonly baseLabel: string;
}

export async function createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree> {
  const started = Date.now();
  const repoDir = input.repoDir;
  const main = await mainCheckout(repoDir);
  const branch = input.branch ?? randomBranchName();
  await checkBranchName(repoDir, branch);
  const slug = slugify(branch);
  if (slug === "") throw new Error(`branch "${branch}" has nothing usable as a directory name`);
  const target = path.join(path.resolve(input.root), main.name, slug);
  if (fs.existsSync(target))
    throw new Error(`${target} already exists; choose another branch name or remove it first`);

  const existing = await revParse(repoDir, `refs/heads/${branch}`);
  let base: string;
  let baseLabel: string;
  if (existing !== null && input.newBranch === true)
    throw new Error(`branch ${branch} already exists; choose another name`);
  if (existing !== null) {
    // Mirrors `git worktree add -b`: an existing branch is never moved to another base.
    if (input.base !== undefined)
      throw new Error(`branch ${branch} already exists; omit the base to check it out as it is`);
    base = existing;
    baseLabel = `${branch} @ ${short(existing)} (existing branch)`;
  } else {
    ({ base, baseLabel } = await resolveBase(repoDir, input.base));
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  // A new branch starts at the resolved commit id, not a ref name, so it never tracks
  // (and never pushes to) the default branch by accident.
  const args =
    existing === null
      ? ["worktree", "add", "-b", branch, "--", target, base]
      : ["worktree", "add", "--", target, branch];
  const added = await git(args, { cwd: repoDir, timeoutMs: CHECKOUT_TIMEOUT_MS });
  if (added.code !== 0) {
    if (added.timedOut) await discardPartial(repoDir, target);
    throw new Error(`git worktree add failed: ${added.timedOut ? "timed out" : added.stderr}`);
  }
  const real = fs.realpathSync(target);
  log.info("git.worktree.created", {
    repo: main.path,
    path: real,
    branch,
    base,
    baseLabel,
    ms: Date.now() - started,
  });
  return { path: real, branch, base, baseLabel };
}

async function resolveBase(
  repoDir: string,
  explicit: string | undefined,
): Promise<{ base: string; baseLabel: string }> {
  if (explicit !== undefined) {
    if (explicit === "" || explicit.startsWith("-")) throw new Error(`"${explicit}" is not a valid base`);
    const commit = await revParse(repoDir, `${explicit}^{commit}`);
    if (commit === null) throw new Error(`base ${explicit} is not a commit in this repository`);
    return { base: commit, baseLabel: `${explicit} @ ${short(commit)}` };
  }
  const remote = await defaultBranch(repoDir);
  if (remote !== null)
    return { base: remote.commit, baseLabel: `origin/${remote.name} @ ${short(remote.commit)}` };
  const head = await revParse(repoDir, "HEAD^{commit}");
  if (head === null) throw new Error("the repository has no commits yet; commit something or pass a base");
  const current = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repoDir });
  const name = current.code === 0 ? current.stdout.trim() : "HEAD";
  return { base: head, baseLabel: `${name} @ ${short(head)} (local)` };
}

/** A killed `worktree add` leaves a half-checked-out, locked worktree behind; it is ours to delete. */
async function discardPartial(repoDir: string, target: string): Promise<void> {
  const removed = await git(["worktree", "remove", "--force", "--force", "--", target], {
    cwd: repoDir,
    timeoutMs: CHECKOUT_TIMEOUT_MS,
  });
  if (removed.code === 0) log.warn("git.worktree.partial_removed", { path: target });
  else log.error("git.worktree.partial_left", { path: target, stderr: removed.stderr });
}

export class DirtyWorktreeError extends Error {
  readonly path: string;

  constructor(worktreePath: string) {
    super(
      `${worktreePath} has uncommitted changes (modified or untracked files); remove it with force to discard them`,
    );
    this.name = "DirtyWorktreeError";
    this.path = worktreePath;
  }
}

export interface RemoveWorktreeInput {
  readonly path: string;
  /** Discard uncommitted changes and untracked files. */
  readonly force?: boolean;
}

/** Remove a linked worktree (never the main checkout). Its branch is kept. */
export async function removeWorktree(input: RemoveWorktreeInput): Promise<void> {
  const force = input.force === true;
  const resolved = path.resolve(input.path);
  if (!fs.existsSync(resolved)) throw new Error(`no worktree at ${resolved}`);
  const target = fs.realpathSync(resolved);
  const where = await gitOk(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"],
    {
      cwd: target,
    },
  );
  const [top = "", commonDir = "", gitDir = ""] = where.trim().split("\n");
  if (fs.realpathSync(top) !== target) throw new Error(`${target} is not the top of a worktree`);
  if (path.normalize(commonDir) === path.normalize(gitDir)) {
    throw new Error(`${target} is the repository's main checkout; only linked worktrees can be removed`);
  }
  // Run from the main checkout: git refuses to remove the worktree it is running in.
  const main = await mainCheckout(target);
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), "--", target];
  const removed = await git(args, { cwd: main.path, timeoutMs: CHECKOUT_TIMEOUT_MS });
  if (removed.code !== 0) {
    if (!force && removed.stderr.includes("contains modified or untracked files"))
      throw new DirtyWorktreeError(target);
    throw new Error(`git worktree remove failed: ${removed.timedOut ? "timed out" : removed.stderr}`);
  }
  log.info("git.worktree.removed", { repo: main.path, path: target, force });
}

export interface WorktreeInfo {
  readonly path: string;
  /** Short branch name; null when detached. */
  readonly branch: string | null;
  /** null for a branch with no commits yet. */
  readonly head: string | null;
}

/** Every checkout of the repository, main first; bare and prunable (deleted) entries skipped. */
export async function listWorktrees(repoDir: string): Promise<WorktreeInfo[]> {
  return (await readWorktreeList(repoDir))
    .filter((entry) => !entry.bare && !entry.prunable)
    .map(({ path: worktreePath, branch, head }) => ({ path: worktreePath, branch, head }));
}

interface ListedWorktree extends WorktreeInfo {
  bare: boolean;
  prunable: boolean;
}

async function readWorktreeList(repoDir: string): Promise<ListedWorktree[]> {
  const out = await gitOk(["worktree", "list", "--porcelain", "-z"], { cwd: repoDir });
  const entries: ListedWorktree[] = [];
  let current: { -readonly [K in keyof ListedWorktree]: ListedWorktree[K] } | null = null;
  for (const field of out.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = {
        path: field.slice("worktree ".length),
        branch: null,
        head: null,
        bare: false,
        prunable: false,
      };
      entries.push(current);
    } else if (current === null) {
      continue;
    } else if (field.startsWith("HEAD ")) {
      const head = field.slice("HEAD ".length);
      current.head = /^0+$/.test(head) ? null : head;
    } else if (field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (field === "bare") {
      current.bare = true;
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  return entries;
}

/** The repository's main checkout (or bare directory) and the name worktree paths use for it. */
async function mainCheckout(repoDir: string): Promise<{ path: string; name: string }> {
  const [first] = await readWorktreeList(repoDir);
  if (first === undefined) throw new Error(`${repoDir}: git listed no worktrees`);
  const base = path.basename(first.path);
  return { path: first.path, name: first.bare ? base.replace(/\.git$/, "") : base };
}

async function checkBranchName(repoDir: string, branch: string): Promise<void> {
  // check-ref-format also expands `@{-1}`-style names; only a name that is literally itself is accepted.
  const checked = branch.startsWith("-")
    ? null
    : await git(["check-ref-format", "--branch", branch], { cwd: repoDir });
  if (checked?.code !== 0 || checked.stdout.trim() !== branch)
    throw new Error(`"${branch}" is not a valid branch name`);
}

async function revParse(repoDir: string, rev: string): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "--quiet", rev], { cwd: repoDir });
  return result.code === 0 ? result.stdout.trim() : null;
}

function short(commit: string): string {
  return commit.slice(0, 7);
}
