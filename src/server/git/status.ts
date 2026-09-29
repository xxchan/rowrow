// A working tree's per-file git state, and the "stamp" that says what a changed file looked
// like when it was listed (docs/git.md, "File actions"). A file action carries the stamp
// back, and the server refuses it when the file has changed since: a click made on an old
// list never stages, discards or deletes work the person hasn't seen.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** One path of `git status --porcelain=v2 -z --untracked-files=all --no-renames`. */
export interface StatusRecord {
  readonly path: string;
  /** `changed`: a `1` record; `unmerged`: a conflict (`u`); `untracked`: `?`. */
  readonly kind: "changed" | "unmerged" | "untracked";
  /** Index against HEAD (`.` when the same), git's letter. `?` for untracked. */
  readonly x: string;
  /** Worktree against the index (`.` when the same). `?` for untracked. */
  readonly y: string;
  readonly submodule: boolean;
  /** The record without its path: status letters, modes and object ids of HEAD and the index. */
  readonly fields: string;
}

/** The arguments that produce what `parseStatusRecords` reads (run it on an index copy). */
export const STATUS_ARGS = [
  "status",
  "--porcelain=v2",
  "-z",
  "--untracked-files=all",
  "--no-renames",
] as const;

export function parseStatusRecords(out: string): Map<string, StatusRecord> {
  const records = new Map<string, StatusRecord>();
  const items = out.split("\0");
  for (let i = 0; i < items.length; i++) {
    const item = items[i] ?? "";
    if (item.startsWith("1 ")) {
      const record = changed(item, 8, "changed");
      records.set(record.path, record);
    } else if (item.startsWith("2 ")) {
      // Only without --no-renames: a rename, followed by its original path.
      const record = changed(item, 9, "changed");
      records.set(record.path, record);
      i += 1;
    } else if (item.startsWith("u ")) {
      const record = changed(item, 10, "unmerged");
      records.set(record.path, record);
    } else if (item.startsWith("? ")) {
      const file = item.slice(2);
      records.set(file, { path: file, kind: "untracked", x: "?", y: "?", submodule: false, fields: "?" });
    }
  }
  return records;
}

function changed(record: string, fieldCount: number, kind: "changed" | "unmerged"): StatusRecord {
  let at = 0;
  for (let i = 0; i < fieldCount; i++) at = record.indexOf(" ", at) + 1;
  const fields = record.slice(0, at - 1);
  const [, xy = "..", sub = "N..."] = fields.split(" ");
  return {
    path: record.slice(at),
    kind,
    x: xy.charAt(0),
    y: xy.charAt(1),
    submodule: sub.startsWith("S"),
    fields,
  };
}

// ─── Stamps ──────────────────────────────────────────────────────────────────

/** Files are hashed up to this size (bigger ones are stamped by their metadata alone)... */
export const STAMP_FILE_BYTES = 8 * 1024 * 1024;
/** ...and up to this much per listing. */
export const STAMP_BUDGET_BYTES = 64 * 1024 * 1024;

export interface StampBudget {
  bytes: number;
}

export function stampBudget(): StampBudget {
  return { bytes: STAMP_BUDGET_BYTES };
}

/**
 * A changed file's state, as `<state>.<content>`: `state` hashes git's record of each path
 * (status letters, modes, HEAD and index object ids) and its metadata on disk (type, size,
 * inode, modification and change times in nanoseconds); `content` hashes its bytes, or is
 * `-` when the file is too big or the listing's budget ran out. `paths` are a row's paths:
 * the original path first for a rename. Deterministic: the same files give the same stamp.
 */
export async function stampOf(
  top: string,
  records: ReadonlyMap<string, StatusRecord>,
  paths: readonly string[],
  budget: StampBudget,
): Promise<string> {
  const state = createHash("sha256");
  const content = createHash("sha256");
  let hashed = true;
  for (const file of paths) {
    state.update(`${file}\0${records.get(file)?.fields ?? "clean"}\0`);
    const disk = await readForStamp(path.join(top, file), budget);
    state.update(`${disk.meta}\0`);
    if (disk.digest === null) hashed = false;
    else content.update(`${disk.digest}\0`);
  }
  return `${state.digest("hex").slice(0, 24)}.${hashed ? content.digest("hex").slice(0, 24) : "-"}`;
}

/**
 * Whether a stamp from a listing still describes the file. The state parts must match; the
 * content parts are compared when both sides could hash the file.
 */
export function sameStamp(seen: string, now: string): boolean {
  const [seenState, seenContent = "-"] = seen.split(".");
  const [nowState, nowContent = "-"] = now.split(".");
  if (seenState === undefined || seenState === "" || seenState !== nowState) return false;
  return seenContent === "-" || nowContent === "-" || seenContent === nowContent;
}

async function readForStamp(
  file: string,
  budget: StampBudget,
): Promise<{ meta: string; digest: string | null }> {
  let stat: fs.BigIntStats;
  try {
    stat = await fs.promises.lstat(file, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { meta: "missing", digest: "missing" };
    throw error;
  }
  const type = stat.isFile() ? "f" : stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : "o";
  const meta = `${type}:${stat.size}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
  if (type === "l") return { meta, digest: hash(await fs.promises.readlink(file)) };
  if (type !== "f" || stat.size > BigInt(STAMP_FILE_BYTES) || stat.size > BigInt(budget.bytes))
    return { meta, digest: null };
  const data = await readFileIfExists(file);
  if (data === null) return { meta: "missing", digest: "missing" };
  budget.bytes -= data.length;
  return { meta, digest: hash(data) };
}

async function readFileIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
