// The shapes that cross the wire, as zod schemas (runtime-validated where they arrive from
// a client) and the TypeScript types inferred from them. Large server-produced structures
// (agent summaries, log entries) are typed but not validated: `z.custom` keeps the type
// and costs nothing per message.
import type { Patch } from "immer";
import { z } from "zod";
import type { Entry } from "./entries.ts";
import type { AgentSummary, Attention } from "./summary.ts";

// ─── Host ────────────────────────────────────────────────────────────────────

export const HostInfo = z.object({
  name: z.string().describe("The machine's hostname."),
  version: z.string(),
  profile: z.string(),
  pid: z.number(),
  startedAt: z.number(),
  platform: z.string(),
  node: z.string(),
  oar: z.string().describe("The oar commit rowrow runs on."),
  dataDir: z.string(),
  url: z.string().describe("Where the server listens."),
  exposed: z.boolean().describe("Listening on a non-loopback address."),
  pushKey: z.string().nullable().describe("The VAPID public key for Web Push subscriptions."),
});
export type HostInfo = z.infer<typeof HostInfo>;

// ─── Workspaces ──────────────────────────────────────────────────────────────

export const GitSummary = z.object({
  repoRoot: z.string(),
  /** The git common dir: every worktree of one repository shares it. */
  repoKey: z.string(),
  branch: z.string().nullable().describe("null when HEAD is detached."),
  head: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
  changed: z.number().describe("Files with staged, unstaged or untracked changes."),
  linked: z.boolean().describe("A linked worktree (not the repository's main checkout)."),
  updatedAt: z.number(),
  error: z.string().optional(),
});
export type GitSummary = z.infer<typeof GitSummary>;

export const Workspace = z.object({
  id: z.string(),
  path: z.string(),
  label: z.string().describe("The custom label, else the repository or directory name."),
  customLabel: z.string().nullable(),
  parentId: z.string().nullable().describe("For a worktree: the workspace of the repository it belongs to."),
  createdAt: z.number(),
  archived: z.boolean(),
  missing: z.boolean().describe("The directory no longer exists."),
  git: GitSummary.nullable(),
});
export type Workspace = z.infer<typeof Workspace>;

// ─── Agents ──────────────────────────────────────────────────────────────────

export interface AgentState {
  readonly id: string;
  readonly summary: AgentSummary;
  /** The log position you have seen (docs/decisions.md, D-008). */
  readonly seenSeq: number;
  readonly attention: Attention;
}
export const AgentState = z.custom<AgentState>();

export const InputMode = z.enum(["auto", "queue", "interrupt"]);

export const SendResult = z.object({
  inputId: z.string(),
  landed: z.enum(["prompted", "steered", "queued", "rejected", "failed"]),
  code: z
    .string()
    .optional()
    .describe("Why it was rejected or failed, as one word (oar's rejection code or a rowrow code)."),
  reason: z.string().optional(),
  seq: z.number().describe("The log entry recording the input."),
});
export type SendResult = z.infer<typeof SendResult>;

export const EntryPage = z.object({
  entries: z.custom<Entry[]>(),
  /** The first seq in the page, or -1 when empty. */
  firstSeq: z.number(),
  /** The agent's latest seq when the page was read. */
  headSeq: z.number(),
  /** Older entries exist before `firstSeq`. */
  hasMore: z.boolean(),
});
export type EntryPage = z.infer<typeof EntryPage>;

// ─── Runtimes ────────────────────────────────────────────────────────────────

export const RuntimeInfo = z.object({
  id: z.string(),
  name: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  reason: z.string().nullable().describe("Why it is unavailable."),
  test: z.boolean().describe("A scripted runtime for tests and demos: no model, no tokens."),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;

export const ModelInfo = z.object({
  id: z.string().describe("What to pass as `model`."),
  name: z.string(),
  effortLevels: z
    .array(z.string())
    .describe("What `effort` accepts with this model; empty when the runtime has no effort setting."),
  defaultEffort: z.string().nullable(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** A skill or custom command a runtime accepts as `/name` in a message (roamgate #226). */
export const SkillInfo = z.object({
  name: z.string().describe("Typed as /name."),
  description: z.string().nullable(),
  source: z
    .string()
    .nullable()
    .describe("Where the runtime found it (project, user, plugin…), in its own words."),
});
export type SkillInfo = z.infer<typeof SkillInfo>;

// ─── Settings ────────────────────────────────────────────────────────────────

/** Preferences that follow you to every device (kept on the server, part of the app state). */
export const Settings = z.object({
  quickReplies: z
    .array(z.string().trim().min(1).max(500))
    .max(24)
    .describe("Replies you send often: one tap puts one in the composer (it is never sent by itself)."),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  quickReplies: [
    "Continue.",
    "Run the tests and fix what fails.",
    "Commit this with a clear message.",
    "Summarize what you changed, briefly.",
  ],
};

// ─── App state ───────────────────────────────────────────────────────────────

/** Everything every client renders, replicated as a snapshot plus patches (state.watch). */
export interface AppState {
  readonly host: HostInfo;
  readonly workspaces: Readonly<Record<string, Workspace>>;
  readonly agents: Readonly<Record<string, AgentState>>;
  readonly runtimes: Readonly<Record<string, RuntimeInfo>>;
  readonly settings: Settings;
}

export type StateMessage =
  | { readonly kind: "snapshot"; readonly version: number; readonly state: AppState }
  | { readonly kind: "patches"; readonly version: number; readonly patches: readonly Patch[] };

// ─── Devices ─────────────────────────────────────────────────────────────────

export const Device = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["browser", "cli"]),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  current: z.boolean().describe("The device making this request."),
  push: z.boolean().describe("Subscribed to Web Push."),
});
export type Device = z.infer<typeof Device>;

export const LoginLink = z.object({
  url: z.string().describe("Open once, before it expires, to sign a browser in."),
  expiresAt: z.number(),
});
export type LoginLink = z.infer<typeof LoginLink>;

// ─── Git ─────────────────────────────────────────────────────────────────────

export const DiffScope = z.enum(["working", "branch", "turn"]);
export type DiffScope = z.infer<typeof DiffScope>;

export const ChangedFile = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "untracked",
    "conflicted",
    "typechange",
  ]),
  additions: z.number().nullable().describe("null for binary files."),
  deletions: z.number().nullable(),
  staged: z
    .boolean()
    .optional()
    .describe("Working scope only: the index has changes to this file (it was git add'ed)."),
  unstaged: z
    .boolean()
    .optional()
    .describe("Working scope only: the worktree has changes the index doesn't (always for untracked files)."),
  stamp: z
    .string()
    .optional()
    .describe(
      "Working scope only: the file's state when listed. git.fileAction and git.bulkAction take it back and refuse when the file changed since.",
    ),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

export const Changes = z.object({
  scope: DiffScope,
  base: z
    .string()
    .nullable()
    .describe("What the changes are compared against: a commit, a snapshot, or null."),
  baseLabel: z.string().nullable(),
  files: z.array(ChangedFile),
  truncated: z.boolean(),
  note: z.string().nullable().describe("Why the scope has nothing to show, when it can't."),
});
export type Changes = z.infer<typeof Changes>;

// ─── File actions (working tree) ─────────────────────────────────────────────

export const FileAction = z.enum(["stage", "unstage", "discardUnstaged", "deleteUntracked", "markResolved"]);
export type FileAction = z.infer<typeof FileAction>;

export const BulkAction = z.enum(["stageAll", "unstageAll", "discardAllUnstaged", "deleteAllUntracked"]);
export type BulkAction = z.infer<typeof BulkAction>;

/** A row of the working-scope list as the client saw it. */
export const SeenFile = z.object({
  path: z.string().min(1).max(4096),
  oldPath: z.string().min(1).max(4096).nullable().optional().describe("A rename's original path."),
  stamp: z.string().min(1).max(200).describe("The file's stamp from git.changes (scope working)."),
});
export type SeenFile = z.infer<typeof SeenFile>;

// ─── History ─────────────────────────────────────────────────────────────────

export const CommitSummary = z.object({
  sha: z.string(),
  parents: z
    .array(z.string())
    .describe("Parent commit ids; two or more for a merge, none for a root commit."),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authorDate: z.number().describe("Unix ms."),
});
export type CommitSummary = z.infer<typeof CommitSummary>;

export const CommitPage = z.object({
  branch: z.string().nullable().describe("null when HEAD is detached."),
  head: z.string().nullable().describe("The commit the history starts from; null before the first commit."),
  commits: z.array(CommitSummary),
  nextCursor: z.string().nullable().describe("Pass as `cursor` for the next page; null at the end."),
  shallow: z.boolean().describe("A shallow clone: the oldest commits aren't in it."),
  note: z.string().nullable(),
});
export type CommitPage = z.infer<typeof CommitPage>;

export const CommitDetail = CommitSummary.extend({
  message: z.string().describe("The full message: subject, then body."),
  committerName: z.string(),
  committerEmail: z.string(),
  committerDate: z.number().describe("Unix ms."),
});
export type CommitDetail = z.infer<typeof CommitDetail>;

export const CommitChanges = z.object({
  commit: CommitDetail,
  base: z
    .string()
    .nullable()
    .describe("What the commit is compared with: its first parent, the empty tree for a root commit."),
  baseLabel: z.string(),
  files: z.array(ChangedFile),
  truncated: z.boolean(),
  note: z.string().nullable().describe("Why there are no files to show, when there can't be."),
});
export type CommitChanges = z.infer<typeof CommitChanges>;

// ─── Pull requests ───────────────────────────────────────────────────────────

export const ChecksSummary = z.object({
  state: z
    .enum(["passing", "failing", "pending", "cancelled", "none", "unknown"])
    .describe(
      "passing only when every check finished successfully (or skipped); none: the PR has no checks; unknown: GitHub didn't say.",
    ),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  pending: z.number(),
  skipped: z.number(),
  cancelled: z.number(),
});
export type ChecksSummary = z.infer<typeof ChecksSummary>;

export const PullRequest = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  author: z.string().nullable(),
  head: z.string().describe("The source branch."),
  base: z.string().describe("The target branch."),
  checks: ChecksSummary,
  review: z
    .enum(["approved", "changes_requested", "review_required", "none", "unknown"])
    .describe("GitHub's review decision; none: no decision (not approved)."),
  updatedAt: z.number().nullable(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const PullRequestStatus = z.object({
  state: z
    .enum(["found", "none", "detached", "no-remote", "unsupported", "no-gh", "signed-out", "error"])
    .describe(
      "found: `pr` is the branch's pull request; none: the branch has none; detached: no branch; no-remote: the repository has no remote; unsupported: the remote isn't on GitHub; no-gh: the GitHub CLI isn't installed on the server; signed-out: gh isn't signed in; error: see `message`.",
    ),
  message: z.string().nullable().describe("What happened, for every state but found."),
  branch: z.string().nullable(),
  pr: PullRequest.nullable(),
  checkedAt: z.number().describe("When gh was asked (Unix ms); answers are cached for a minute."),
});
export type PullRequestStatus = z.infer<typeof PullRequestStatus>;

// ─── Search ──────────────────────────────────────────────────────────────────

export const SearchKind = z.enum(["all", "names", "content"]);
export type SearchKind = z.infer<typeof SearchKind>;

export const SearchResult = z.object({
  query: z.string(),
  names: z
    .array(z.object({ path: z.string() }))
    .describe("Files whose path contains every word of the query."),
  namesTruncated: z.boolean(),
  lines: z
    .array(
      z.object({
        path: z.string(),
        line: z.number().describe("1-based."),
        text: z
          .string()
          .describe("The line, cut to a few hundred characters around the match (… marks a cut)."),
      }),
    )
    .describe("Lines containing the query."),
  linesTruncated: z.boolean(),
  note: z.string().nullable(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const FileText = z.object({
  path: z.string(),
  text: z.string(),
  size: z.number().describe("The file's size in bytes."),
  truncated: z
    .boolean()
    .describe("The text stops before the end of the file (it is cut at 1 MiB, on a line)."),
});
export type FileText = z.infer<typeof FileText>;

// ─── Telemetry ───────────────────────────────────────────────────────────────

export const Level = z.enum(["debug", "info", "warn", "error"]);
export type Level = z.infer<typeof Level>;

export const LogEntry = z
  .object({
    time: z.number(),
    level: Level,
    evt: z.string(),
    msg: z.string().optional(),
    trace: z.string().optional(),
  })
  .catchall(z.unknown());
export type LogEntry = z.infer<typeof LogEntry>;

export const LogFilter = z.object({
  since: z.number().optional().describe("Unix ms; entries at or after it."),
  level: Level.optional().describe("Minimum level."),
  evt: z.string().optional().describe("Event name prefix, e.g. `agent.` or `api.call`."),
  trace: z.string().optional(),
  agent: z.string().optional(),
  text: z.string().optional().describe("Substring anywhere in the entry."),
  limit: z.number().int().positive().max(5000).optional(),
});
export type LogFilter = z.infer<typeof LogFilter>;

export const ClientEvent = z.object({
  level: Level,
  evt: z.string().max(100),
  msg: z.string().max(4000).optional(),
  at: z.number(),
  trace: z.string().max(64).optional(),
  route: z.string().max(500).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ClientEvent = z.infer<typeof ClientEvent>;
