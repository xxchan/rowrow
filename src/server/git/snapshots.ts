// Turn snapshots (docs/git.md, "Turn snapshots"): the whole state of a worktree (tracked
// and untracked files, honoring .gitignore) as a git tree, so "what changed since this turn
// started" survives the agent committing, stashing or switching branches meanwhile.
//
// A snapshot never writes into the user's repository: not its objects, index, refs or
// files. (Another tool's scratch-index snapshots still wrote blobs into .git/objects and
// leaked ~80 GiB of tmp_pack_* files on huge and unreadable untracked files.) So git runs with
// - GIT_OBJECT_DIRECTORY: a private object directory per repository, under rowrow's
//   profile. New blobs and trees land only there.
// - GIT_ALTERNATE_OBJECT_DIRECTORIES: the repository's own objects, read in place, so
//   what the repository already has is never copied.
// - GIT_INDEX_FILE: a throwaway copy of the worktree's index. A copy rather than
//   `read-tree HEAD` keeps git's stat cache (only files that changed get hashed, which
//   matters in big repositories) and sparse-checkout bits (files outside the sparse cone
//   aren't mistaken for deletions).
// Size limits are checked before anything is hashed, and a deadline kills the process group.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "../telemetry/log.ts";
import { git, gitOk } from "./exec.ts";

export const SNAPSHOT_LIMITS = {
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  files: 10_000,
  timeoutMs: 15_000,
} as const;

export type Capture = { kind: "ok"; tree: string; at: number } | { kind: "refused"; reason: string };

/** Where a checkout's git data lives. */
interface Located {
  readonly top: string;
  readonly commonDir: string;
  /** This worktree's own index. */
  readonly index: string;
  readonly objects: string;
}

/** Scratch files are deleted when done; ones older than this were left by a crash. */
const SCRATCH_MAX_AGE_MS = 60 * 60_000;
/** More status output than this is far past the file-count limit. */
const STATUS_MAX_BYTES = 16 * 1024 * 1024;

// Settings that would make git write outside our scratch space (the fsmonitor daemon keeps
// state in .git, a split index writes shared index files into .git) or refuse to hash a
// file with mixed line endings.
const CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.safecrlf=false",
] as const;
// No optional locks: git skips opportunistic index refreshes.
const QUIET_ENV = { GIT_OPTIONAL_LOCKS: "0" } as const;

export class SnapshotStore {
  /** Holds `<first 16 hex of sha256(repository's common dir)>/objects`, one per repository. */
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Snapshot `dir`'s worktree, or say why not. Nothing partial is kept on refusal. */
  async capture(dir: string): Promise<Capture> {
    const started = Date.now();
    const deadline = started + SNAPSHOT_LIMITS.timeoutMs;
    let repo: Located;
    try {
      repo = await locate(dir);
    } catch (error) {
      return refused(dir, (error as Error).message, started);
    }
    const storeEnv = await this.storeEnv(repo);
    return this.scratchIndex(repo, async (indexEnv) => {
      // A capture reads local files only: no lazy fetches of missing objects in a partial clone.
      const env = { ...indexEnv, ...storeEnv, GIT_NO_LAZY_FETCH: "1" };
      const run = (args: readonly string[], maxBytes?: number) =>
        git([...CONFIG, ...args], {
          cwd: repo.top,
          env,
          timeoutMs: Math.max(1, deadline - Date.now()),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        });

      const status = await run(
        [
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all",
          "--no-renames",
        ],
        STATUS_MAX_BYTES,
      );
      if (status.code !== 0) return refused(repo.top, failure("status", status), started);
      if (Buffer.byteLength(status.stdout) >= STATUS_MAX_BYTES) {
        return refused(
          repo.top,
          `too many changed or untracked files (the limit is ${SNAPSHOT_LIMITS.files})`,
          started,
        );
      }
      const paths = changedPaths(status.stdout);
      const size = await measure(repo.top, paths);
      if (size.kind === "over") return refused(repo.top, size.reason, started);

      const added = await run(["add", "--all"]);
      if (added.code !== 0) return refused(repo.top, failure("add", added), started);
      const written = await run(["write-tree"]);
      const tree = written.stdout.trim();
      if (written.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
        return refused(repo.top, failure("write-tree", written), started);
      }
      log.info("git.snapshot.captured", {
        dir: repo.top,
        tree,
        files: paths.length,
        bytes: size.bytes,
        ms: Date.now() - started,
      });
      return { kind: "ok", tree, at: started };
    });
  }

  /** The environment for reading `dir`'s snapshot trees with git (objects: private store, then the repository's). */
  async env(dir: string): Promise<Record<string, string>> {
    return this.storeEnv(await locate(dir));
  }

  /**
   * Run `fn` in `dir`'s top level with a throwaway copy of its index as GIT_INDEX_FILE.
   * Commands that refresh the index (`git diff` does, even with GIT_OPTIONAL_LOCKS=0) then
   * write the copy: never the user's index, and never its lock, which a concurrent
   * `git commit` by an agent would trip over.
   */
  async withIndexCopy<T>(
    dir: string,
    fn: (env: Record<string, string>, top: string) => Promise<T>,
  ): Promise<T> {
    const repo = await locate(dir);
    return this.scratchIndex(repo, (env) => fn(env, repo.top));
  }

  /** Delete loose snapshot objects not written or reused for `maxAgeMs`, and crash leftovers. */
  async prune(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const scratchCutoff = Math.min(cutoff, Date.now() - SCRATCH_MAX_AGE_MS);
    const tally = { removed: 0, bytes: 0 };
    for (const store of await readDirIfExists(this.root)) {
      const objects = path.join(this.root, store, "objects");
      for (const name of await readDirIfExists(objects)) {
        const sub = path.join(objects, name);
        if (/^[0-9a-f]{2}$/.test(name)) {
          for (const file of await readDirIfExists(sub))
            await removeIfOlder(path.join(sub, file), cutoff, tally);
          await removeIfEmpty(sub);
        } else if (name === "pack") {
          for (const file of await readDirIfExists(sub)) {
            if (file.startsWith("tmp_")) await removeIfOlder(path.join(sub, file), scratchCutoff, tally);
          }
        }
      }
      const scratch = path.join(this.root, store, "tmp");
      for (const entry of await readDirIfExists(scratch))
        await removeIfOlder(path.join(scratch, entry), scratchCutoff, tally);
    }
    log.info("git.snapshot.pruned", { root: this.root, maxAgeMs, ...tally });
  }

  /** Delete a repository's snapshots (`commonDir` is its GitSummary.repoKey): rowrow no longer knows it. */
  async drop(commonDir: string): Promise<void> {
    await fs.promises.rm(this.storeDir({ commonDir }), { recursive: true, force: true });
    log.info("git.snapshot.dropped", { repo: commonDir });
  }

  private storeDir(repo: Pick<Located, "commonDir">): string {
    return path.join(this.root, createHash("sha256").update(repo.commonDir).digest("hex").slice(0, 16));
  }

  private async storeEnv(repo: Located): Promise<Record<string, string>> {
    const dir = this.storeDir(repo);
    const objects = path.join(dir, "objects");
    await fs.promises.mkdir(path.join(objects, "pack"), { recursive: true });
    await fs.promises.mkdir(path.join(objects, "info"), { recursive: true });
    // Which repository a store belongs to, for whoever looks inside the profile.
    await writeOnce(path.join(dir, "repository"), `${repo.commonDir}\n`);
    return { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate(repo.objects) };
  }

  private async scratchIndex<T>(repo: Located, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const scratchRoot = path.join(this.storeDir(repo), "tmp");
    await fs.promises.mkdir(scratchRoot, { recursive: true });
    const scratch = await fs.promises.mkdtemp(path.join(scratchRoot, "index-"));
    try {
      const index = path.join(scratch, "index");
      await copyIndex(repo.index, index);
      return await fn({ ...QUIET_ENV, GIT_INDEX_FILE: index });
    } finally {
      await fs.promises.rm(scratch, { recursive: true, force: true });
    }
  }
}

async function locate(dir: string): Promise<Located> {
  const out = await gitOk(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-path", "index"],
    {
      cwd: dir,
      timeoutMs: 10_000,
    },
  );
  const [top = "", commonDir = "", index = ""] = out.trim().split("\n");
  if (top === "" || commonDir === "" || index === "")
    throw new Error(`${dir}: cannot locate the git repository`);
  const normalized = path.normalize(commonDir);
  return { top, commonDir: normalized, index, objects: path.join(normalized, "objects") };
}

async function copyIndex(from: string, to: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // nothing staged yet: start empty
    throw error;
  }
  await fs.promises.copyFile(from, to);
  // Keep the index's own mtime, a hair earlier: git compares it with each file's mtime to
  // find "racily clean" entries (changed in the instant the index was written) and
  // re-hashes those. A later mtime would make git trust stale stat data.
  await fs.promises.utimes(to, stat.atimeMs / 1000, (stat.mtimeMs - 1) / 1000);
}

/**
 * Paths `git add --all` has to hash, from `git status --porcelain=v2 -z` against the index
 * copy: worktree changes, conflicts and untracked files. Changes that are only staged are
 * already in the repository's objects.
 */
export function changedPaths(out: string): string[] {
  const paths: string[] = [];
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    const kind = record[0];
    if (kind === "?") paths.push(record.slice(2));
    else if (kind === "1" && record[3] !== ".") paths.push(statusPath(record, 8));
    else if (kind === "2") {
      if (record[3] !== ".") paths.push(statusPath(record, 9));
      i += 1; // followed by the original path
    } else if (kind === "u") paths.push(statusPath(record, 10));
  }
  return paths;
}

/** The path ending a porcelain v2 status record: what follows its first `n` fields (a path may contain spaces). */
export function statusPath(record: string, n: number): string {
  let at = 0;
  for (let i = 0; i < n; i++) at = record.indexOf(" ", at) + 1;
  return record.slice(at);
}

type Measured = { kind: "within"; bytes: number } | { kind: "over"; reason: string };

async function measure(top: string, paths: readonly string[]): Promise<Measured> {
  if (paths.length > SNAPSHOT_LIMITS.files) {
    return {
      kind: "over",
      reason: `${paths.length} changed or untracked files (the limit is ${SNAPSHOT_LIMITS.files})`,
    };
  }
  let bytes = 0;
  for (let i = 0; i < paths.length; i += 256) {
    const batch = paths.slice(i, i + 256);
    const sizes = await Promise.all(batch.map((p) => sizeOf(path.join(top, p))));
    for (const [j, size] of sizes.entries()) {
      if (size > SNAPSHOT_LIMITS.fileBytes) {
        return {
          kind: "over",
          reason: `${batch[j] ?? "a file"} is ${mib(size)} (the limit is ${mib(SNAPSHOT_LIMITS.fileBytes)} per file)`,
        };
      }
      bytes += size;
    }
    if (bytes > SNAPSHOT_LIMITS.totalBytes) {
      return {
        kind: "over",
        reason: `changed and untracked files add up to more than ${mib(SNAPSHOT_LIMITS.totalBytes)}`,
      };
    }
  }
  return { kind: "within", bytes };
}

/** Bytes git would hash for a path: a file's size, a symlink's target, nothing for deletions. */
async function sizeOf(file: string): Promise<number> {
  try {
    const stat = await fs.promises.lstat(file);
    return stat.isDirectory() ? 0 : stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function refused(dir: string, reason: string, started: number): Capture {
  log.warn("git.snapshot.refused", { dir, reason, ms: Date.now() - started });
  return { kind: "refused", reason };
}

function failure(
  command: string,
  result: { code: number | null; stderr: string; timedOut: boolean },
): string {
  if (result.timedOut) return `timed out after ${SNAPSHOT_LIMITS.timeoutMs / 1000} s`;
  return `git ${command} failed: ${result.stderr || `exit code ${result.code}`}`;
}

/** One entry of GIT_ALTERNATE_OBJECT_DIRECTORIES: colon-separated unless C-quoted. */
function alternate(dir: string): string {
  if (!/[:"\\\n]/.test(dir)) return dir;
  return `"${dir.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, "\\n")}"`;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function writeOnce(file: string, content: string): Promise<void> {
  try {
    await fs.promises.writeFile(file, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function readDirIfExists(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

async function removeIfOlder(
  file: string,
  cutoff: number,
  tally: { removed: number; bytes: number },
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // removed concurrently
    throw error;
  }
  if (stat.mtimeMs >= cutoff) return;
  await fs.promises.rm(file, { recursive: true, force: true });
  tally.removed += 1;
  tally.bytes += stat.size;
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await fs.promises.rmdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A capture may have just written into it.
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
  }
}
