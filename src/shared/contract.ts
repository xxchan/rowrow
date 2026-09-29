// The API contract (docs/decisions.md, D-003): every procedure rowrow has, declared once.
// The web app calls it over a WebSocket; the CLI, agents and curl call it over HTTP
// (POST /api/<group>/<name>, OpenAPI at /api/openapi.json). Every summary is written for
// an agent that has never seen the code: `rowrow help` lists them.
import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import type { Entry } from "./entries.ts";
import {
  AgentState,
  BulkAction,
  Changes,
  ClientEvent,
  CommitChanges,
  CommitPage,
  Device,
  DiffScope,
  EntryPage,
  FileAction,
  FileText,
  HostInfo,
  InputMode,
  LogEntry,
  LogFilter,
  LoginLink,
  ModelInfo,
  PullRequestStatus,
  RuntimeInfo,
  SearchKind,
  SearchResult,
  SeenFile,
  SendResult,
  Workspace,
  type AppState,
  type StateMessage,
} from "./schemas.ts";

const ok = z.object({ ok: z.literal(true) });
const agentId = z.string().describe("Agent id (ag_…).");
const workspaceId = z.string().describe("Workspace id (ws_…).");

const app = {
  info: oc.route({ summary: "Server version, profile, data directory, address, pid." }).output(HostInfo),
  status: oc
    .route({
      summary:
        "A health report for debugging: live runs (pid, runtime, since), connected clients (device, route, focus), counts, and the most recent warnings and errors.",
    })
    .output(
      z.object({
        host: HostInfo,
        runs: z.array(
          z.object({
            agentId: z.string(),
            runId: z.string(),
            runtime: z.string(),
            since: z.number(),
            status: z.string(),
          }),
        ),
        clients: z.array(
          z.object({
            id: z.string(),
            device: z.string(),
            route: z.string().nullable(),
            visible: z.boolean(),
            focused: z.boolean(),
            since: z.number(),
          }),
        ),
        counts: z.object({ workspaces: z.number(), agents: z.number(), entries: z.number() }),
        problems: z.array(LogEntry),
      }),
    ),
};

const state = {
  get: oc
    .route({
      summary:
        "The whole app state every client renders: host, workspaces (with git summaries), agents (summary, attention, seen marker), runtimes.",
    })
    .output(z.object({ version: z.number(), state: z.custom<AppState>() })),
  watch: oc
    .route({ summary: "The app state as a stream: a snapshot, then immer patches as it changes." })
    .output(eventIterator(z.custom<StateMessage>())),
};

const workspaces = {
  add: oc
    .route({
      summary:
        "Register a directory (usually a git checkout) as a workspace. Returns the existing one if the path is already registered.",
    })
    .input(z.object({ path: z.string().min(1), label: z.string().optional() }))
    .output(Workspace),
  update: oc
    .route({ summary: "Rename (label; null restores the derived name) or archive a workspace." })
    .input(
      z.object({
        id: workspaceId,
        label: z.string().nullable().optional(),
        archived: z.boolean().optional(),
      }),
    )
    .output(Workspace),
  refresh: oc
    .route({ summary: "Re-read a workspace's git facts (branch, upstream, changed files) now." })
    .input(z.object({ id: workspaceId }))
    .output(Workspace),
  browse: oc
    .route({
      summary:
        "List a directory on the server, to pick a workspace from a phone. Defaults to the home directory. Marks git repositories.",
    })
    .input(z.object({ path: z.string().optional() }))
    .output(
      z.object({
        path: z.string(),
        parent: z.string().nullable(),
        entries: z.array(z.object({ name: z.string(), path: z.string(), repo: z.boolean() })),
      }),
    ),
  createWorktree: oc
    .route({
      summary:
        "Create a linked git worktree of a workspace's repository on a new branch (from the freshly fetched default branch of origin unless `base` is given), register it as a workspace grouped under the repository, and run the repository's setup hook.",
    })
    .input(
      z.object({
        id: workspaceId,
        branch: z.string().optional().describe("Branch to create; a memorable random name when omitted."),
        base: z.string().optional().describe("Commit-ish to branch from."),
      }),
    )
    .output(
      z.object({
        workspace: Workspace,
        hook: z.object({ ran: z.boolean(), ok: z.boolean(), output: z.string() }).nullable(),
      }),
    ),
  removeWorktree: oc
    .route({
      summary:
        "Remove a linked worktree workspace: runs the teardown hook (a failure stops removal), removes the checkout (refused when dirty unless force), keeps the branch.",
    })
    .input(z.object({ id: workspaceId, force: z.boolean().optional() }))
    .output(ok),
};

const agents = {
  create: oc
    .route({
      summary:
        "Create an agent: a conversation with one runtime in a workspace. With `input`, sends it as the first message (the run starts then).",
    })
    .input(
      z.object({
        workspaceId,
        runtime: z.string().describe("Runtime id: claude, codex, grok, kimi, pi (see runtimes.list)."),
        model: z.string().optional().describe("Runtime-native model id; the runtime's default when omitted."),
        effort: z
          .string()
          .optional()
          .describe(
            "Reasoning effort, one of the model's effortLevels (runtimes.models); the runtime's default when omitted.",
          ),
        title: z.string().max(200).optional(),
        input: z.object({ inputId: z.string().uuid(), text: z.string().min(1).max(200_000) }).optional(),
      }),
    )
    .output(z.object({ agent: AgentState, sent: SendResult.nullable() })),
  send: oc
    .route({
      summary:
        "Send input to an agent. Starts (resumes) its run when none is live. mode auto: prompt when idle, steer or queue when busy; queue: hold for the next turn; interrupt: abort the running turn, then prompt. Idempotent on inputId: a retry returns the first result.",
    })
    .input(
      z.object({
        agentId,
        inputId: z.string().uuid().describe("A UUID you generate; the idempotency key."),
        text: z.string().min(1).max(200_000),
        mode: InputMode.default("auto"),
      }),
    )
    .output(SendResult),
  abort: oc
    .route({
      summary:
        "Interrupt the agent's running turn. The turn's outcome arrives in the log as the runtime reports it.",
    })
    .input(z.object({ agentId }))
    .output(z.object({ accepted: z.boolean(), reason: z.string().optional() })),
  stop: oc
    .route({
      summary: "Stop the agent's live run (its process). The conversation stays; the next input resumes it.",
    })
    .input(z.object({ agentId }))
    .output(ok),
  update: oc
    .route({
      summary:
        "Rename an agent, change its model or reasoning effort (the live run restarts with them, resuming the conversation), or archive it (stops its run).",
    })
    .input(
      z.object({
        agentId,
        title: z.string().max(200).nullable().optional(),
        model: z.string().nullable().optional(),
        effort: z.string().nullable().optional(),
        archived: z.boolean().optional(),
      }),
    )
    .output(AgentState),
  markSeen: oc
    .route({ summary: "Record that you have seen the agent's log up to seq (clears its `done` attention)." })
    .input(z.object({ agentId, seq: z.number().int() }))
    .output(ok),
  entries: oc
    .route({
      summary:
        "Read an agent's log. Default: the window starting at the 3rd most recent input. `after` reads forward from a cursor; `before` reads the window before a seq (to load older history); `turns` sets the window size; `full` includes native payloads.",
    })
    .input(
      z.object({
        agentId,
        after: z.number().int().optional(),
        before: z.number().int().optional(),
        turns: z.number().int().positive().max(1000).optional(),
        limit: z.number().int().positive().max(50_000).optional(),
        full: z.boolean().optional(),
      }),
    )
    .output(EntryPage),
  watch: oc
    .route({
      summary:
        "Stream an agent's log entries after a cursor (-1 for all), as batches; resumes exactly where you left off. Slim entries (no native payloads).",
    })
    .input(z.object({ agentId, after: z.number().int() }))
    .output(eventIterator(z.object({ entries: z.custom<Entry[]>() }))),
  wait: oc
    .route({
      summary:
        "Wait until an agent's attention becomes one of `until` (default: blocked, done or idle, i.e. not working), or the timeout passes. Returns at once if it already is.",
    })
    .input(
      z.object({
        agentId,
        until: z.array(z.enum(["blocked", "done", "working", "idle"])).optional(),
        afterSeq: z.number().int().optional().describe("Only count a state reached after this log position."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(24 * 3600_000)
          .optional(),
      }),
    )
    .output(z.object({ agent: AgentState, timedOut: z.boolean() })),
  view: oc
    .route({ summary: "The agent's transcript as plain text: the same fold the UI renders." })
    .input(
      z.object({
        agentId,
        turns: z.number().int().positive().optional(),
        toolChars: z.number().int().min(0).optional(),
      }),
    )
    .output(z.object({ text: z.string(), headSeq: z.number() })),
};

const runtimes = {
  list: oc
    .route({ summary: "Agent runtimes and whether each is installed here. `refresh` probes again." })
    .input(z.object({ refresh: z.boolean().optional() }))
    .output(z.array(RuntimeInfo)),
  models: oc
    .route({ summary: "Models a runtime offers (may ask the runtime's provider; cached)." })
    .input(z.object({ runtime: z.string(), refresh: z.boolean().optional() }))
    .output(z.object({ models: z.array(ModelInfo), error: z.string().nullable() })),
};

const git = {
  changes: oc
    .route({
      summary:
        "Changed files of a workspace. scope working: uncommitted changes against HEAD; branch: everything since the merge base with the default branch; turn: what an agent's latest turn changed (snapshots at its start and end; `agentId` picks the agent).",
    })
    .input(
      z.object({
        workspaceId,
        scope: DiffScope,
        agentId: z
          .string()
          .optional()
          .describe("Turn scope: whose latest turn (default: the workspace's latest, by any agent)."),
      }),
    )
    .output(Changes),
  diff: oc
    .route({ summary: "The unified diff of one file in a scope (see git.changes)." })
    .input(z.object({ workspaceId, scope: DiffScope, path: z.string(), agentId: z.string().optional() }))
    .output(z.object({ patch: z.string(), truncated: z.boolean() })),
  fileAction: oc
    .route({
      summary:
        "Change one file's git state in a workspace's working tree (a file git.changes lists in scope working): stage (git add), unstage (the edits stay in the file), discardUnstaged (drop edits that aren't staged; the staged version stays), deleteUntracked (remove an untracked file), markResolved (stage a conflicted file once its conflict markers are gone). Pass the file's path, oldPath for a rename, and the stamp git.changes gave it: if the file changed since, nothing happens and the call fails with CONFLICT (list again, then retry). Returns the paths git ran on and the new working-scope list.",
    })
    .input(
      z.object({
        workspaceId,
        action: FileAction,
        path: SeenFile.shape.path,
        oldPath: SeenFile.shape.oldPath,
        stamp: SeenFile.shape.stamp,
      }),
    )
    .output(z.object({ paths: z.array(z.string()), changes: Changes })),
  bulkAction: oc
    .route({
      summary:
        "A file action for every file at once: stageAll (every unstaged and untracked file), unstageAll, discardAllUnstaged (staged versions stay), deleteAllUntracked. Conflicted files are left alone. `files` are the rows of the working-scope list you acted on (path, oldPath, stamp): if the action would touch a file that isn't among them or that changed since, nothing happens and the call fails with CONFLICT.",
    })
    .input(z.object({ workspaceId, action: BulkAction, files: z.array(SeenFile).max(5000) }))
    .output(z.object({ paths: z.array(z.string()), changes: Changes })),
  log: oc
    .route({
      summary:
        "A workspace's commit history: commits reachable from HEAD (the current branch), newest first, `limit` (default 50) at a time. Pass nextCursor back as `cursor` for the next page; a cursor keeps to the history it started from even if the branch moves.",
    })
    .input(
      z.object({
        workspaceId,
        cursor: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .output(CommitPage),
  commit: oc
    .route({
      summary:
        "One commit of a workspace's repository: full message, author and committer, dates, parents, and the files it changed with line counts. A normal commit is compared with its parent, a root commit with the empty tree, a merge commit with its first parent (baseLabel says which).",
    })
    .input(z.object({ workspaceId, sha: z.string().describe("A commit id (full or abbreviated hex).") }))
    .output(CommitChanges),
  commitDiff: oc
    .route({
      summary: "The unified diff of one file in a commit (compared as git.commit does), cut at 512 KB.",
    })
    .input(z.object({ workspaceId, sha: z.string(), path: z.string() }))
    .output(z.object({ patch: z.string(), truncated: z.boolean() })),
  pullRequest: oc
    .route({
      summary:
        "The GitHub pull request of a workspace's current branch, read with the GitHub CLI where the server runs (gh pr view): number, title, state (open, draft, merged, closed), source and target branch, checks, review decision. Read-only. `state` says when there is none and why (detached HEAD, no remote, not GitHub, gh missing or signed out, an error). Answers are cached for a minute; `refresh` asks gh again.",
    })
    .input(z.object({ workspaceId, refresh: z.boolean().optional() }))
    .output(PullRequestStatus),
};

const files = {
  upload: oc
    .route({
      summary:
        "Upload a file (a screenshot, a log) to the server. Returns its absolute path on the server, to mention in a message so the agent can read it. Kept for 7 days.",
    })
    .input(z.object({ file: z.file().max(25 * 1024 * 1024) }))
    .output(z.object({ path: z.string(), name: z.string(), size: z.number(), type: z.string() })),
  search: oc
    .route({
      summary:
        "Search a workspace's checkout: file paths containing every word of the query, and lines containing the query as a fixed string (case-insensitive unless it has an uppercase letter). Tracked and untracked files, .gitignore honored, binary files skipped. At most 200 of each; namesTruncated and linesTruncated say when there were more.",
    })
    .input(
      z.object({
        workspaceId,
        query: z.string().min(1).max(200),
        kind: SearchKind.default("all").describe("names, content, or all (both)."),
      }),
    )
    .output(SearchResult),
  read: oc
    .route({
      summary:
        "A text file of a workspace's checkout, by its path relative to the checkout's top (as git.changes and files.search give it). Refuses binary files, directories, and anything outside the checkout or inside .git; stops at 1 MiB (truncated).",
    })
    .input(z.object({ workspaceId, path: z.string().min(1).max(4096) }))
    .output(FileText),
};

const devices = {
  whoami: oc.route({ summary: "The device (credential) making this request." }).output(Device),
  list: oc.route({ summary: "Signed-in devices." }).output(z.array(Device)),
  pair: oc
    .route({
      summary:
        "A one-time sign-in link for another browser (show it as a QR code on your phone). Expires in 10 minutes.",
    })
    .input(z.object({ name: z.string().max(100).optional() }))
    .output(LoginLink),
  rename: oc
    .route({ summary: "Rename a device." })
    .input(z.object({ id: z.string(), name: z.string().min(1).max(100) }))
    .output(ok),
  revoke: oc
    .route({ summary: "Sign a device out everywhere (its credential stops working at once)." })
    .input(z.object({ id: z.string() }))
    .output(ok),
};

const notify = {
  subscribe: oc
    .route({ summary: "Subscribe this device to Web Push (a PushSubscription as JSON)." })
    .input(
      z.object({
        endpoint: z.string().url(),
        keys: z.object({ p256dh: z.string(), auth: z.string() }),
      }),
    )
    .output(ok),
  unsubscribe: oc.route({ summary: "Stop Web Push for this device." }).output(ok),
  test: oc
    .route({ summary: "Send a test notification to this device." })
    .output(z.object({ sent: z.number() })),
};

const presence = {
  update: oc
    .route({
      summary:
        "What this connection is showing (route, agent) and whether the page is visible and focused. Suppresses notifications for what you're looking at.",
    })
    .input(
      z.object({
        route: z.string().max(500),
        agentId: z.string().nullable(),
        visible: z.boolean(),
        focused: z.boolean(),
      }),
    )
    .output(ok),
};

const telemetry = {
  report: oc
    .route({ summary: "Browser-side log events and errors, written to the server log as client.*." })
    .input(z.object({ events: z.array(ClientEvent).max(200) }))
    .output(ok),
};

const logs = {
  query: oc
    .route({ summary: "Recent server log entries matching a filter (newest last)." })
    .input(LogFilter)
    .output(z.array(LogEntry)),
  watch: oc
    .route({ summary: "Follow the server log live, filtered." })
    .input(LogFilter)
    .output(eventIterator(LogEntry)),
};

export const contract = {
  app,
  state,
  workspaces,
  agents,
  runtimes,
  git,
  files,
  devices,
  notify,
  presence,
  telemetry,
  logs,
};
export type Contract = typeof contract;
