// A checkout's commit history (roamgate #229, docs/git.md "History"): the current branch's
// commits a page at a time, and one commit's changes. Read-only. A normal commit is
// compared with its parent, a root commit with the empty tree, and a merge commit with its
// first parent (and says so). Commit ids are the only revisions accepted: no ranges, no
// ref expressions, nothing that could be read as an option.
import type { CommitChanges, CommitDetail, CommitPage, CommitSummary } from "../../shared/schemas.ts";
import {
  checkPath,
  clip,
  DIFF,
  emptyTree,
  LIST_MAX_BYTES,
  MAX_FILES,
  MAX_PATCH_BYTES,
  ok,
  parseDiff,
  short,
  type FileDiff,
} from "./changes.ts";
import { git } from "./exec.ts";

export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// Fields end in the unit separator; `--no-show-signature` keeps GPG output out of the log
// (log.showSignature), and the encoding is always UTF-8 whatever i18n.logOutputEncoding says.
const SEP = "\x1f";
const LOG_FORMAT = ["%H", "%P", "%aN", "%aE", "%at", "%s"].join("%x1f");
const SHOW_FORMAT = ["%H", "%P", "%aN", "%aE", "%at", "%cN", "%cE", "%ct", "%B"].join("%x1f");
const LOG_FLAGS = ["--no-show-signature", "--encoding=UTF-8", "--no-color"] as const;

const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export class HistoryError extends Error {}

/**
 * Commits reachable from HEAD, newest first, `limit` at a time. The cursor pins the commit
 * the first page started from, so later pages continue the same history even when the
 * branch moves meanwhile.
 */
export async function listCommits(input: {
  readonly dir: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<CommitPage> {
  const limit = Math.min(Math.max(1, input.limit ?? PAGE_SIZE), MAX_PAGE_SIZE);
  const cwd = input.dir;
  const branchResult = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  const shallow = (await git(["rev-parse", "--is-shallow-repository"], { cwd })).stdout.trim() === "true";
  let from: string;
  let skip = 0;
  if (input.cursor === undefined) {
    const head = await resolveCommit(cwd, "HEAD");
    if (head === null)
      return { branch, head: null, commits: [], nextCursor: null, shallow, note: "No commits yet." };
    from = head;
  } else {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?):(\d{1,9})$/.exec(input.cursor);
    if (match === null) throw new HistoryError(`"${input.cursor}" is not a cursor from git.log`);
    from = match[1] ?? "";
    skip = Number(match[2]);
    if ((await resolveCommit(cwd, from)) === null)
      throw new HistoryError("That history is gone (was the repository rewritten?): load it again");
  }
  const result = ok(
    await git(
      [
        "log",
        ...LOG_FLAGS,
        "-z",
        `--format=${LOG_FORMAT}`,
        `--skip=${skip}`,
        `--max-count=${limit + 1}`,
        from,
        "--",
      ],
      { cwd, maxBytes: LIST_MAX_BYTES },
    ),
    "log",
  );
  const commits = result.stdout
    .split("\0")
    .filter((record) => record !== "")
    .map(parseSummary);
  const more = commits.length > limit;
  return {
    branch,
    head: from,
    commits: commits.slice(0, limit),
    nextCursor: more ? `${from}:${skip + limit}` : null,
    shallow,
    note: !more && shallow ? "This is a shallow clone: older commits aren't here." : null,
  };
}

/** One commit: its metadata and changed files, against the base its kind calls for. */
export async function readCommit(input: {
  readonly dir: string;
  readonly sha: string;
}): Promise<CommitChanges> {
  const cwd = input.dir;
  const commit = await commitDetail(cwd, input.sha);
  const base = await baseOf(cwd, commit);
  if (base.kind === "boundary")
    return { commit, base: null, baseLabel: base.label, files: [], truncated: false, note: base.label };
  const diff = ok(
    await git([...DIFF, "--raw", "--numstat", "-z", base.rev, commit.sha, "--"], {
      cwd,
      maxBytes: LIST_MAX_BYTES,
    }),
    "diff",
  );
  let files = parseDiff(diff.stdout);
  let truncated = Buffer.byteLength(diff.stdout) >= LIST_MAX_BYTES;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.length > MAX_FILES) {
    files = files.slice(0, MAX_FILES);
    truncated = true;
  }
  return {
    commit,
    base: base.kind === "root" ? null : base.rev,
    baseLabel: base.label,
    files,
    truncated,
    note: files.length === 0 ? "This commit changes no files." : null,
  };
}

/** One file's unified diff in a commit (against the same base as readCommit), cut at 512 KB. */
export async function commitPatch(input: {
  readonly dir: string;
  readonly sha: string;
  readonly path: string;
}): Promise<FileDiff> {
  const cwd = input.dir;
  let file: string;
  try {
    file = checkPath(input.path);
  } catch (error) {
    throw new HistoryError((error as Error).message);
  }
  const commit = await commitDetail(cwd, input.sha);
  const base = await baseOf(cwd, commit);
  if (base.kind === "boundary") throw new HistoryError(base.label);
  // Rename detection needs both paths in the pathspec; find the old one first.
  const raw = ok(
    await git([...DIFF, "--raw", "-z", base.rev, commit.sha, "--"], { cwd, maxBytes: LIST_MAX_BYTES }),
    "diff",
  );
  const oldPath = parseDiff(raw.stdout).find((entry) => entry.path === file)?.oldPath ?? null;
  const patch = ok(
    await git([...DIFF, base.rev, commit.sha, "--", ...(oldPath === null ? [file] : [oldPath, file])], {
      cwd,
      env: { GIT_LITERAL_PATHSPECS: "1" },
      maxBytes: MAX_PATCH_BYTES + 1,
    }),
    "diff",
  );
  return clip(patch.stdout);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Base =
  | { kind: "parent" | "merge" | "root"; rev: string; label: string }
  /** A shallow clone's oldest commit: its parent isn't here, so its changes can't be computed. */
  | { kind: "boundary"; label: string };

async function baseOf(cwd: string, commit: CommitDetail): Promise<Base> {
  const [first, ...rest] = commit.parents;
  if (first !== undefined) {
    return rest.length === 0
      ? { kind: "parent", rev: first, label: `Compared with its parent ${short(first)}` }
      : {
          kind: "merge",
          rev: first,
          label: `Merge commit: compared with its first parent ${short(first)}`,
        };
  }
  // No parents as git sees them. A shallow clone's boundary commit has parents in its object
  // that simply aren't here: comparing it with the empty tree would show every file as added.
  const raw = ok(await git(["cat-file", "commit", commit.sha], { cwd }), "cat-file");
  const header = raw.stdout.slice(0, raw.stdout.indexOf("\n\n"));
  if (/^parent /m.test(header))
    return {
      kind: "boundary",
      label: "This commit's parent isn't in this shallow clone, so its changes can't be shown.",
    };
  return { kind: "root", rev: await emptyTree(cwd), label: "Root commit: compared with the empty tree" };
}

async function commitDetail(cwd: string, sha: string): Promise<CommitDetail> {
  if (!/^[0-9a-f]{4,64}$/.test(sha)) throw new HistoryError(`"${sha}" is not a commit id`);
  const full = await resolveCommit(cwd, sha);
  if (full === null) throw new HistoryError(`There is no commit ${sha} in this repository.`);
  const result = ok(
    await git(["show", ...LOG_FLAGS, "-s", `--format=${SHOW_FORMAT}`, full, "--"], {
      cwd,
      maxBytes: 4 * 1024 * 1024,
    }),
    "show",
  );
  const fields = result.stdout.split(SEP);
  const [id = "", parents = "", authorName = "", authorEmail = "", authorAt = "0"] = fields;
  const [committerName = "", committerEmail = "", committerAt = "0", ...body] = fields.slice(5);
  const message = body.join(SEP).replace(/\n+$/, "");
  return {
    sha: id,
    parents: parents === "" ? [] : parents.split(" "),
    subject: message.split("\n")[0] ?? "",
    authorName,
    authorEmail,
    authorDate: Number(authorAt) * 1000,
    message,
    committerName,
    committerEmail,
    committerDate: Number(committerAt) * 1000,
  };
}

function parseSummary(record: string): CommitSummary {
  const [sha = "", parents = "", authorName = "", authorEmail = "", at = "0", ...subject] = record
    .replace(/^\n/, "")
    .split(SEP);
  return {
    sha,
    parents: parents === "" ? [] : parents.split(" "),
    subject: subject.join(SEP),
    authorName,
    authorEmail,
    authorDate: Number(at) * 1000,
  };
}

/** A commit's full id, or null. `rev` is HEAD or a hex id (abbreviated or full), never user syntax. */
async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  if (rev !== "HEAD" && !/^[0-9a-f]{4,64}$/.test(rev)) return null;
  const result = await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd });
  const id = result.stdout.trim();
  return result.code === 0 && COMMIT_ID.test(id) ? id : null;
}
