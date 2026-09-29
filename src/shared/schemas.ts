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
  code: z.string().optional().describe("Why it was rejected or failed, as one word (oar's rejection code or a rowrow code)."),
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
});
export type ModelInfo = z.infer<typeof ModelInfo>;

// ─── App state ───────────────────────────────────────────────────────────────

/** Everything every client renders, replicated as a snapshot plus patches (state.watch). */
export interface AppState {
  readonly host: HostInfo;
  readonly workspaces: Readonly<Record<string, Workspace>>;
  readonly agents: Readonly<Record<string, AgentState>>;
  readonly runtimes: Readonly<Record<string, RuntimeInfo>>;
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
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "untracked", "conflicted", "typechange"]),
  additions: z.number().nullable().describe("null for binary files."),
  deletions: z.number().nullable(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

export const Changes = z.object({
  scope: DiffScope,
  base: z.string().nullable().describe("What the changes are compared against: a commit, a snapshot, or null."),
  baseLabel: z.string().nullable(),
  files: z.array(ChangedFile),
  truncated: z.boolean(),
  note: z.string().nullable().describe("Why the scope has nothing to show, when it can't."),
});
export type Changes = z.infer<typeof Changes>;

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
