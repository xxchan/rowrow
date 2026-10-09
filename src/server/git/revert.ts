// Put one file back the way it was when a turn started (docs/git.md, "Reverting a file to
// the start of a turn"), from the turn's snapshots: a modified file gets its old content, a
// file the turn created is deleted, one it deleted comes back, a rename goes back to its old
// path. The file must still be exactly as the turn left it (its end snapshot); anything
// changed since, and nothing is written. Only the file's own paths are written: never the
// index, refs, commits or another file.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIST_MAX_BYTES } from "./changes.ts";
import { git, gitOk } from "./exec.ts";
import { ActionRefused, checkActionPath } from "./file-actions.ts";
import type { SnapshotStore } from "./snapshots.ts";

/** A file this big at the start of the turn is restored with git, not here. */
const RESTORE_MAX_BYTES = 64 * 1024 * 1024;
/** Hashing a big file runs its clean filters (LFS): give it time. */
const HASH_TIMEOUT_MS = 60_000;
/** The flags the snapshots hashed files with, so the same bytes give the same blob. */
const CONFIG = ["-c", "core.safecrlf=false"] as const;

export interface RevertInput {
  readonly dir: string;
  readonly store: SnapshotStore;
  /** The snapshots taken when the turn started and when it ended. */
  readonly start: string;
  readonly end: string;
  /** The file as the turn's list shows it (a rename: its new path). */
  readonly path: string;
}

/** What a path held in a snapshot: a file (mode 100644 or 100755), a symbolic link (120000), or nothing. */
type Entry = { readonly mode: string; readonly oid: string } | null;

/** One path of the file: what it was at the turn's start and at its end. */
interface Side {
  readonly path: string;
  readonly start: Entry;
  readonly end: Entry;
}

/** Returns the paths written or removed (a rename: both). */
export async function revertToTurnStart(input: RevertInput): Promise<{ paths: string[] }> {
  const file = checkActionPath(input.path);
  for (const tree of [input.start, input.end])
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`"${tree}" is not a snapshot id`);
  const top = (await gitOk(["rev-parse", "--show-toplevel"], { cwd: input.dir })).trim();
  const env = { ...(await input.store.env(input.dir)), GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const tree of [input.start, input.end]) {
    if ((await git(["cat-file", "-e", `${tree}^{tree}`], { cwd: top, env })).code !== 0)
      throw new ActionRefused(
        "This turn's snapshots are no longer stored, so there is nothing to revert to.",
      );
  }

  // The whole turn, as its list compares it: a rename is found only between all of its files.
  const diff = await git(
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
      "--raw",
      "--no-abbrev",
      "-z",
      input.start,
      input.end,
      "--",
    ],
    { cwd: top, env, maxBytes: LIST_MAX_BYTES },
  );
  if (diff.code !== 0)
    throw new Error(
      `git diff failed: ${diff.timedOut ? "timed out" : diff.stderr || `exit code ${diff.code}`}`,
    );
  const sides = parseRaw(diff.stdout).get(file);
  if (sides === undefined) throw new ActionRefused(`${file} didn't change in this turn.`);
  for (const side of sides) {
    for (const entry of [side.start, side.end]) {
      if (entry !== null && entry.mode === "160000")
        throw new ActionRefused(`${side.path} is a submodule: revert changes inside it with git.`);
    }
  }

  // Look before writing anything: every path must be as the turn left it.
  const states = await Promise.all(
    sides.map(async (side) => ({
      side,
      atEnd: await holds(top, env, side.path, side.end),
      atStart: await holds(top, env, side.path, side.start),
    })),
  );
  if (!states.every((s) => s.atEnd)) {
    if (states.every((s) => s.atStart))
      throw new ActionRefused(`${file} is already as it was before this turn.`);
    throw new ActionRefused(
      `${file} changed since the turn ended, so it wasn't reverted: that would lose the newer changes.`,
    );
  }
  for (const side of sides) if (side.start !== null) await checkParents(top, side.path);

  // The old path first: a rename half done leaves both files, never neither.
  const order = [...sides].sort((a, b) => Number(a.start === null) - Number(b.start === null));
  for (const side of order) await restore(top, env, side);
  return { paths: sides.map((side) => side.path) };
}

/**
 * `git diff --raw -z` records by the path a list row shows: `:<modes> <oids> <status>\0<path>\0`,
 * two paths for a rename (old, then new). A rename's row has both of its paths.
 */
export function parseRaw(out: string): Map<string, Side[]> {
  const rows = new Map<string, Side[]>();
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i] ?? "";
    if (!token.startsWith(":")) {
      i += 1;
      continue;
    }
    const [srcMode = "", dstMode = "", srcOid = "", dstOid = "", status = ""] = token.slice(1).split(" ");
    const entry = (mode: string, oid: string): Entry => (/^0+$/.test(mode) ? null : { mode, oid });
    const from = entry(srcMode, srcOid);
    const to = entry(dstMode, dstOid);
    if (status.startsWith("R") || status.startsWith("C")) {
      const old = tokens[i + 1] ?? "";
      const now = tokens[i + 2] ?? "";
      // A copy leaves its source as it was; only the new path is the turn's.
      rows.set(now, [
        ...(status.startsWith("R") ? [{ path: old, start: from, end: null }] : []),
        { path: now, start: null, end: to },
      ]);
      i += 3;
    } else {
      const file = tokens[i + 1] ?? "";
      rows.set(file, [{ path: file, start: from, end: to }]);
      i += 2;
    }
  }
  return rows;
}

/** Whether the worktree's `file` holds exactly `entry`: the same content and type (a file's mode bits aside). */
async function holds(top: string, env: Record<string, string>, file: string, entry: Entry): Promise<boolean> {
  const abs = path.join(top, file);
  if ((await insideLink(top, file)) !== null) return false;
  const stat = await lstatOrNull(abs);
  if (entry === null) return stat === null;
  if (stat === null) return false;
  if (entry.mode === "120000") {
    if (!stat.isSymbolicLink()) return false;
    const target = await fs.promises.readlink(abs, { encoding: "buffer" });
    return target.equals(await blob(top, env, entry.oid));
  }
  if (!stat.isFile()) return false;
  // Hashed as the snapshot did (`git add`): through the repository's clean filters for this path.
  const hashed = await git([...CONFIG, "hash-object", `--path=${file}`, "--", abs], {
    cwd: top,
    env,
    timeoutMs: HASH_TIMEOUT_MS,
  });
  if (hashed.code !== 0)
    throw new Error(
      `git hash-object failed: ${hashed.timedOut ? "timed out" : hashed.stderr || `exit code ${hashed.code}`}`,
    );
  return hashed.stdout.trim() === entry.oid;
}

/** Writes `side.start` at its path (or removes the path when the turn created it), atomically. */
async function restore(top: string, env: Record<string, string>, side: Side): Promise<void> {
  const abs = path.join(top, side.path);
  const start = side.start;
  if (start === null) {
    await fs.promises.rm(abs);
    await removeEmptyParents(top, side.path);
    return;
  }
  const dir = path.dirname(abs);
  await fs.promises.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.rowrow-revert-${randomBytes(6).toString("hex")}`);
  try {
    if (start.mode === "120000") {
      await fs.promises.symlink(await blob(top, env, start.oid), temp);
    } else {
      // The content as a checkout would write it: through smudge filters and line-ending conversion.
      const content = await gitBytes(top, env, ["cat-file", "--filters", `--path=${side.path}`, start.oid]);
      const executable = start.mode === "100755";
      await fs.promises.writeFile(temp, content, { flag: "wx", mode: executable ? 0o777 : 0o666 });
      // An existing file keeps its permissions; only the executable bit is the snapshot's.
      const current = await lstatOrNull(abs);
      if (current?.isFile() === true) {
        const kept = current.mode & 0o7777;
        await fs.promises.chmod(temp, executable ? kept | ((kept & 0o444) >> 2) : kept & ~0o111);
      }
    }
    await fs.promises.rename(temp, abs);
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
}

/** Refuses when a folder on the way to `file` is a file or a symbolic link now (writing there would leave the checkout). */
async function checkParents(top: string, file: string): Promise<void> {
  const parts = file.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    const stat = await lstatOrNull(path.join(top, dir));
    if (stat === null) return;
    if (stat.isSymbolicLink())
      throw new ActionRefused(`${dir} is a symbolic link now, so ${file} can't be restored.`);
    if (!stat.isDirectory()) throw new ActionRefused(`${dir} is a file now, so ${file} can't be restored.`);
  }
}

/** The first folder on the way to `file` that is a symbolic link, or null. */
async function insideLink(top: string, file: string): Promise<string | null> {
  const parts = file.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    const stat = await lstatOrNull(path.join(top, dir));
    if (stat === null) return null;
    if (stat.isSymbolicLink()) return dir;
  }
  return null;
}

/** Folders the removed file leaves empty go too, as git's checkout does; never one with anything in it. */
async function removeEmptyParents(top: string, file: string): Promise<void> {
  for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) {
    try {
      await fs.promises.rmdir(path.join(top, dir));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") return;
      throw error;
    }
  }
}

/** A blob's raw bytes (a symbolic link's target), from the snapshot store or the repository. */
async function blob(top: string, env: Record<string, string>, oid: string): Promise<Buffer> {
  return gitBytes(top, env, ["cat-file", "blob", oid]);
}

async function gitBytes(top: string, env: Record<string, string>, args: readonly string[]): Promise<Buffer> {
  const result = await git(args, {
    cwd: top,
    env,
    maxBytes: RESTORE_MAX_BYTES + 1,
    timeoutMs: HASH_TIMEOUT_MS,
  });
  if (result.code !== 0)
    throw new Error(
      `git ${args[0] ?? ""} failed: ${result.timedOut ? "timed out" : result.stderr || `exit code ${result.code}`}`,
    );
  const bytes = result.bytes ?? Buffer.from(result.stdout, "utf8");
  if (result.capped || bytes.length > RESTORE_MAX_BYTES)
    throw new ActionRefused("It was over 64 MiB when the turn started: restore it with git instead.");
  return bytes;
}

async function lstatOrNull(file: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
