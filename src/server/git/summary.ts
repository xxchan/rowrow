// A checkout's git facts for the sidebar: repository identity (for grouping worktrees),
// branch, upstream ahead/behind, and how many files changed. Two git calls.
import path from "node:path";
import type { GitSummary } from "../../shared/schemas.ts";
import { git } from "./exec.ts";

/** The summary, or null when `dir` is not inside a git repository. */
export async function readGitSummary(dir: string): Promise<GitSummary | null> {
  const where = await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"], {
    cwd: dir,
    timeoutMs: 10_000,
  });
  if (where.code !== 0) return null;
  const [repoRoot = dir, commonDir = "", gitDir = ""] = where.stdout.trim().split("\n");
  const base: GitSummary = {
    repoRoot,
    repoKey: path.normalize(commonDir),
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changed: 0,
    linked: path.normalize(commonDir) !== path.normalize(gitDir),
    updatedAt: Date.now(),
  };
  const status = await git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], { cwd: dir, timeoutMs: 20_000 });
  if (status.code !== 0) return { ...base, error: status.timedOut ? "git status timed out" : status.stderr };
  return { ...base, ...parseStatus(status.stdout) };
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): Pick<GitSummary, "branch" | "head" | "upstream" | "ahead" | "behind" | "changed"> {
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changed = 0;
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length);
      head = oid === "(initial)" ? null : oid.slice(0, 9);
    } else if (record.startsWith("# branch.head ")) {
      const name = record.slice("# branch.head ".length);
      branch = name === "(detached)" ? null : name;
    } else if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
    } else if (record.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(record);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
    } else if (record.startsWith("1 ") || record.startsWith("u ") || record.startsWith("? ")) {
      changed += 1;
    } else if (record.startsWith("2 ")) {
      changed += 1;
      i += 1; // a rename or copy is followed by its original path
    }
  }
  return { branch, head, upstream, ahead, behind, changed };
}
