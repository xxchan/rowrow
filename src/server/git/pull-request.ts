// The pull request for a checkout's branch (roamgate #228, docs/git.md "Pull requests"),
// read with the host's own GitHub CLI: `gh pr view --json …` in the checkout, so gh's
// sign-in (github.com or an enterprise host) and its rules for which PR belongs to the
// current branch apply, and rowrow never holds a token. Read-only.
//
// Every outcome is explicit: no branch, no remote, a remote that isn't GitHub, gh not
// installed or not signed in, no PR, or an error. Missing or unrecognized check and review
// data is never reported as passing or approved.
import type { ChecksSummary, PullRequest, PullRequestStatus } from "../../shared/schemas.ts";
import { git, run } from "./exec.ts";

export const GH_TIMEOUT_MS = 15_000;
const FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "author",
  "headRefName",
  "baseRefName",
  "reviewDecision",
  "statusCheckRollup",
  "updatedAt",
].join(",");

export interface PullRequestInput {
  readonly dir: string;
  /** The gh executable (a name on PATH, or a path). */
  readonly gh?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export async function pullRequestStatus(input: PullRequestInput): Promise<PullRequestStatus> {
  const now = input.now ?? Date.now;
  const cwd = input.dir;
  const status = (
    state: PullRequestStatus["state"],
    message: string | null,
    branch: string | null,
    pr: PullRequest | null = null,
  ): PullRequestStatus => ({ state, message, branch, pr, checkedAt: now() });

  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
  if (head.code !== 0) return status("detached", "HEAD is detached: there is no branch to look up.", null);
  const branch = head.stdout.trim();

  const remotes = await remoteHosts(cwd);
  if (remotes.length === 0)
    return status("no-remote", "This repository has no remote, so it can't have a pull request.", branch);
  // gh knows github.com and the enterprise hosts it's signed in to. Local paths and
  // well-known other forges are answered here, without starting it.
  if (remotes.every((r) => r.host === null || OTHER_FORGES.test(r.host))) {
    const hosts = [...new Set(remotes.map((r) => r.host ?? "a local path"))].join(", ");
    return status(
      "unsupported",
      `Pull request status is GitHub only for now (this repository's remote is ${hosts}).`,
      branch,
    );
  }

  const result = await run(input.gh ?? "gh", ["pr", "view", "--json", FIELDS], {
    cwd,
    timeoutMs: input.timeoutMs ?? GH_TIMEOUT_MS,
    maxBytes: 4 * 1024 * 1024,
    env: {
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_SPINNER_DISABLED: "1",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.spawnError === "ENOENT")
    return status(
      "no-gh",
      "The GitHub CLI (gh) isn't installed where rowrow runs: install it from https://cli.github.com, then run gh auth login.",
      branch,
    );
  if (result.timedOut)
    return status("error", `gh didn't answer within ${(input.timeoutMs ?? GH_TIMEOUT_MS) / 1000} s.`, branch);
  if (result.code !== 0)
    return failure(result.code, result.stderr || result.spawnError || "", branch, status);
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    return status("error", "gh answered with something that isn't JSON.", branch);
  }
  const pr = toPullRequest(raw);
  if (pr === null) return status("error", "gh's answer doesn't look like a pull request.", branch);
  return status("found", null, branch, pr);
}

const OTHER_FORGES = /(^|\.)(gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht|gitea\.com)$|gitlab|bitbucket/i;

function failure(
  code: number | null,
  stderr: string,
  branch: string,
  status: (
    state: PullRequestStatus["state"],
    message: string | null,
    branch: string | null,
  ) => PullRequestStatus,
): PullRequestStatus {
  const first = firstLine(stderr);
  // Checked in this order: gh's "unknown host" message also mentions `gh auth login`.
  if (/none of the git remotes .* point to a known GitHub host/i.test(stderr))
    return status(
      "unsupported",
      "Pull request status is GitHub only for now: no remote here is a GitHub host gh knows.",
      branch,
    );
  if (/no pull requests found/i.test(stderr)) return status("none", `No pull request for ${branch}.`, branch);
  if (code === 4 || /gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(stderr))
    return status(
      "signed-out",
      "gh isn't signed in to GitHub where rowrow runs: run gh auth login there.",
      branch,
    );
  return status("error", first === "" ? `gh failed (exit code ${code ?? "none"}).` : `gh: ${first}`, branch);
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim().slice(0, 300);
}

/** Remotes of the checkout with the host each points to (null for a local path). */
async function remoteHosts(cwd: string): Promise<{ name: string; host: string | null }[]> {
  const listed = await git(["remote"], { cwd });
  if (listed.code !== 0) return [];
  const names = listed.stdout.split("\n").filter((name) => name.trim() !== "");
  const remotes: { name: string; host: string | null }[] = [];
  for (const name of names) {
    const url = await git(["remote", "get-url", "--", name], { cwd });
    remotes.push({ name, host: url.code === 0 ? hostOf(url.stdout.trim()) : null });
  }
  return remotes;
}

/** The host of a git remote URL: https://host/…, ssh://[user@]host[:port]/…, or scp-like user@host:path. */
export function hostOf(url: string): string | null {
  if (/^file:/i.test(url)) return null;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)/i.exec(url);
  if (scheme !== null) return scheme[1]?.toLowerCase() ?? null;
  // scp-like `user@host:path`; a single letter before the colon is a Windows drive.
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)/.exec(url)?.[1];
  return scp === undefined || /^[a-z]$/i.test(scp) ? null : scp.toLowerCase();
}

// ─── gh's JSON → PullRequest ─────────────────────────────────────────────────

type Json = Record<string, unknown>;

export function toPullRequest(raw: unknown): PullRequest | null {
  if (!isObject(raw)) return null;
  const number = raw["number"];
  const title = raw["title"];
  const url = raw["url"];
  const state = raw["state"];
  if (typeof number !== "number" || typeof title !== "string" || typeof url !== "string") return null;
  const mapped =
    state === "MERGED"
      ? "merged"
      : state === "CLOSED"
        ? "closed"
        : state === "OPEN"
          ? raw["isDraft"] === true
            ? "draft"
            : "open"
          : null;
  if (mapped === null) return null;
  const author = raw["author"];
  const updatedAt = typeof raw["updatedAt"] === "string" ? Date.parse(raw["updatedAt"]) : Number.NaN;
  return {
    number,
    title,
    url,
    state: mapped,
    author: isObject(author) && typeof author["login"] === "string" ? author["login"] : null,
    head: typeof raw["headRefName"] === "string" ? raw["headRefName"] : "",
    base: typeof raw["baseRefName"] === "string" ? raw["baseRefName"] : "",
    checks: summarizeChecks(raw["statusCheckRollup"]),
    review: reviewOf(raw["reviewDecision"]),
    updatedAt: Number.isNaN(updatedAt) ? null : updatedAt,
  };
}

export function reviewOf(decision: unknown): PullRequest["review"] {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    case "":
    case null:
      return "none";
    default:
      return "unknown";
  }
}

/**
 * GitHub's check runs and commit statuses, folded. `passing` needs at least one check and
 * every check finished as success, neutral or skipped; anything unrecognized makes the
 * whole `unknown` (unless something already failed), never passing.
 */
export function summarizeChecks(rollup: unknown): ChecksSummary {
  const summary = { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, cancelled: 0 };
  if (rollup === null || rollup === undefined) return { state: "none", ...summary };
  if (!Array.isArray(rollup)) return { state: "unknown", ...summary };
  let unknown = 0;
  for (const item of rollup as unknown[]) {
    summary.total += 1;
    const bucket = isObject(item) ? bucketOf(item) : "unknown";
    if (bucket === "unknown") unknown += 1;
    else summary[bucket] += 1;
  }
  const state: ChecksSummary["state"] =
    summary.failed > 0
      ? "failing"
      : unknown > 0
        ? "unknown"
        : summary.pending > 0
          ? "pending"
          : summary.cancelled > 0
            ? "cancelled"
            : summary.total === 0
              ? "none"
              : "passing";
  return { state, ...summary };
}

type Bucket = "passed" | "failed" | "pending" | "skipped" | "cancelled" | "unknown";

function bucketOf(item: Json): Bucket {
  if (item["__typename"] === "StatusContext") {
    switch (item["state"]) {
      case "SUCCESS":
        return "passed";
      case "FAILURE":
      case "ERROR":
        return "failed";
      case "PENDING":
      case "EXPECTED":
        return "pending";
      default:
        return "unknown";
    }
  }
  // A CheckRun: a status until it completes, then a conclusion.
  const status = item["status"];
  if (status !== "COMPLETED") {
    return typeof status === "string" &&
      ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"].includes(status)
      ? "pending"
      : "unknown";
  }
  switch (item["conclusion"]) {
    case "SUCCESS":
      return "passed";
    case "NEUTRAL":
    case "SKIPPED":
      return "skipped";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "failed";
    case "CANCELLED":
    case "STALE":
      return "cancelled";
    default:
      return "unknown";
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
