// The API contract (docs/decisions.md, D-003): every procedure rowrow has, declared once.
// The web app calls it over a WebSocket; the CLI, agents and curl call it over HTTP
// (POST /api/<group>/<name>, OpenAPI at /api/openapi.json). Every summary is written for
// an agent that has never seen the code: `rowrow help` lists them.
import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import {
  CoachToolArgs,
  TaskNotifyArgs,
  TaskScheduleArgs,
  type AgentBackgroundResult,
  type AgentChangesResult,
  type AgentHistoryResult,
  type AgentsStatusResult,
  type CoachChat,
} from "./coach.ts";
import { MAX_PROMPT_CHARS, type CoachActionView } from "./coach-actions.ts";
import { MAX_COMMAND_CHARS, type CommandOutput, type CommandRun } from "./commands.ts";
import { MAX_MENTION_LABEL, MAX_MENTIONS } from "./coach-mentions.ts";
import { MAX_TITLE_CHARS, type CoachTask, type CoachTaskRun } from "./coach-tasks.ts";
import type { Entry } from "./entries.ts";
import {
  AgentState,
  type AppState,
  Attachment,
  Attachments,
  BulkAction,
  Changes,
  ClientEvent,
  CommitChanges,
  CommitPage,
  Device,
  DiffScope,
  EntryPage,
  FileAction,
  FileList,
  FileText,
  hasContent,
  HostInfo,
  InputMode,
  LogEntry,
  LogFilter,
  LoginLink,
  LoginResult,
  LogoutResult,
  ModelInfo,
  Notice,
  PullRequestStatus,
  RuntimeInfo,
  RuntimeUpdate,
  RuntimeUsage,
  SearchKind,
  SearchResult,
  SearchWho,
  SeenFile,
  SendResult,
  Settings,
  SkillInfo,
  TranscriptSearch,
  UpdateCheckStatus,
  UpdateInfo,
  UpgradeResult,
  type StateMessage,
  Workspace,
  WorktreeHooks,
} from "./schemas.ts";

const ok = z.object({ ok: z.literal(true) });
/** A name an HTTP client gives its state.watch stream, so presence.update can describe it. */
const connection = z
  .string()
  .regex(/^[\w-]{8,64}$/)
  .describe("A name you choose (8 to 64 letters, digits, - or _), new for every state.watch stream.");
const agentId = z.string().describe("Agent id (ag_…).");
const workspaceId = z.string().describe("Workspace id (ws_…).");

const app = {
  info: oc.route({ summary: "Server version, profile, data directory, address, pid." }).output(HostInfo),
  checkForUpdates: oc
    .route({
      summary:
        "Ask the registry for a newer rowrow now (even with settings.checkForUpdates off). PRECONDITION_FAILED when this install updates another way: through the Mac app that runs it, or git.",
    })
    .output(z.object({ update: UpdateInfo.nullable(), check: UpdateCheckStatus })),
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
    .route({
      summary:
        "The app state as a stream: a snapshot, then immer patches as it changes. A client without a WebSocket (the iOS app, over HTTP) passes `connection`: while this stream is open, presence.update with the same name says what it shows.",
    })
    .input(z.object({ connection: connection.optional() }).optional())
    .output(eventIterator(z.custom<StateMessage>())),
};

const workspaces = {
  add: oc
    .route({
      summary:
        "Register a directory (usually a git checkout) as a workspace. Returns the existing one if the path is already registered (unarchived, and renamed when a label is given).",
    })
    .input(z.object({ path: z.string().min(1), label: z.string().optional() }))
    .output(Workspace),
  update: oc
    .route({
      summary:
        "Rename (label; null restores the derived name) or archive a workspace. Archiving hides it, the linked worktrees under it and their agents, and stops their runs; nobody can start or message an agent there until it is unarchived. The agents' own archived flags are untouched, so unarchiving brings back exactly what was there.",
    })
    .input(
      z.object({
        id: workspaceId,
        label: z.string().nullable().optional(),
        archived: z.boolean().optional(),
      }),
    )
    .output(Workspace),
  remove: oc
    .route({
      summary:
        "Remove a workspace from rowrow, with the linked worktrees registered under it. Its folder, files, checkouts and branches are untouched. Refused while one of its agents is working. Its agents are archived (their logs are kept); adding the path again makes a new workspace.",
    })
    .input(z.object({ id: workspaceId }))
    .output(
      z.object({
        removed: z.array(z.string()).describe("The workspaces rowrow forgot: this one, then its worktrees."),
        archived: z.array(z.string()).describe("The agents archived with them."),
      }),
    ),
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
  hooks: oc
    .route({
      summary:
        "The repository's worktree hooks, before rowrow runs them: the one file they come from (rowrow.json, else roamgate.json or paseo.json, read as legacy) and its commands. `create`: what a new worktree made from this checkout runs (from this checkout's file; the new worktree's own copy wins if it has one). `remove`: what removing this linked worktree runs.",
    })
    .input(z.object({ id: workspaceId, action: z.enum(["create", "remove"]) }))
    .output(WorktreeHooks),
  removeWorktree: oc
    .route({
      summary:
        "Remove a linked worktree workspace: runs the teardown hook (a failure stops removal), removes the checkout (refused when dirty unless force), keeps the branch. rowrow then forgets the workspace and archives its agents.",
    })
    .input(z.object({ id: workspaceId, force: z.boolean().optional() }))
    .output(ok),
};

const SERVICE_TIER =
  "Service tier, one of the model's serviceTiers (runtimes.models), or `default` for none (D-049). Fast mode is codex's `priority` and claude's `fast`; other runtimes have none. The runtime's own setting decides when omitted.";

const agents = {
  create: oc
    .route({
      summary:
        "Create an agent: a conversation with one runtime in a workspace. With `input`, sends it as the first message (the run starts then).",
    })
    .input(
      z.object({
        workspaceId,
        runtime: z
          .string()
          .describe(
            "Runtime id: claude, codex, cursor, antigravity, grok, kimi, opencode, pi (see runtimes.list).",
          ),
        model: z.string().optional().describe("Runtime-native model id; the runtime's default when omitted."),
        effort: z
          .string()
          .optional()
          .describe(
            "Reasoning effort, one of the model's effortLevels (runtimes.models); the runtime's default when omitted.",
          ),
        serviceTier: z.string().optional().describe(SERVICE_TIER),
        title: z.string().max(200).optional(),
        input: z
          .object({ inputId: z.string().uuid(), text: z.string().max(200_000), attachments: Attachments })
          .refine(hasContent, "send some text or an attachment")
          .optional(),
      }),
    )
    .output(z.object({ agent: AgentState, sent: SendResult.nullable() })),
  send: oc
    .route({
      summary:
        "Send input to an agent. Starts (resumes) its run when none is live; idle, every mode starts a turn. Busy: auto and queue hold it (landed queued) and send it, one per turn, when the turn ends, and until then agents.withdraw takes it back; steer puts it into the running turn (a runtime that can't steer holds it, with a code saying so); interrupt aborts the running turn, then prompts. Idempotent on inputId: a retry returns the first result.",
    })
    .input(
      z
        .object({
          agentId,
          inputId: z.string().uuid().describe("A UUID you generate; the idempotency key."),
          text: z.string().max(200_000),
          attachments: Attachments,
          mode: InputMode.default("auto"),
        })
        .refine(hasContent, "send some text or an attachment"),
    )
    .output(SendResult),
  withdraw: oc
    .route({
      summary:
        "Take back an input the agent holds for a later turn (or a steer the runtime never read), to edit or drop it. CONFLICT once it went to the agent.",
    })
    .input(z.object({ agentId, inputId: z.string() }))
    .output(z.object({ text: z.string(), attachments: z.array(Attachment) })),
  sendNow: oc
    .route({
      summary:
        "Send a held input now instead of after the queue: steered into the running turn, or as the next turn when idle. A runtime that can't steer keeps it for after the turn (landed queued, code steer_unsupported). Doesn't resume a paused queue.",
    })
    .input(z.object({ agentId, inputId: z.string() }))
    .output(SendResult),
  resume: oc
    .route({
      summary:
        "Send held inputs again after the queue paused (the turn was stopped or failed, or the run ended): the next one now when idle.",
    })
    .input(z.object({ agentId }))
    .output(ok),
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
        "Rename an agent, change its model, reasoning effort or service tier (Fast mode; the live run restarts with them, resuming the conversation), archive it (stops its run), or pin it.",
    })
    .input(
      z.object({
        agentId,
        title: z.string().max(200).nullable().optional(),
        model: z.string().nullable().optional(),
        effort: z.string().nullable().optional(),
        serviceTier: z
          .string()
          .nullable()
          .optional()
          .describe(`${SERVICE_TIER} null: back to the runtime's own setting.`),
        archived: z.boolean().optional(),
        pinned: z
          .boolean()
          .optional()
          .describe(
            "Pinned agents lead every agent list, in the order they were pinned, on every device. A pinned agent can't be archived until it's unpinned.",
          ),
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
  search: oc
    .route({
      summary:
        "Find text in an agent's transcript as it shows it (D-055): your messages, the agent's replies, and its tool calls' input and output, all of its history. Case-insensitive plain text. The newest 200 matches (`limit`), oldest first; each names its transcript item and `turnSeq`, where to load the log from to show it.",
    })
    .input(
      z.object({
        agentId,
        text: z.string().max(1000),
        who: z.array(SearchWho).optional().describe("Only these kinds (default: all)."),
        limit: z.number().int().positive().max(1000).optional(),
      }),
    )
    .output(TranscriptSearch),
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
  skills: oc
    .route({
      summary:
        "What a runtime accepts as /name in a message, in a workspace: its skills and custom commands, read natively (cached for a minute). `error` says why there are none when the runtime can't list them.",
    })
    .input(z.object({ runtime: z.string(), workspaceId }))
    .output(z.object({ skills: z.array(SkillInfo), error: z.string().nullable() })),
  updates: oc
    .route({
      summary:
        "Whether a newer version of each runtime is out, as its own updater would install it (asks the runtime or its release feed; cached for an hour, `refresh` asks again).",
    })
    .input(z.object({ refresh: z.boolean().optional() }))
    .output(z.array(RuntimeUpdate)),
  usage: oc
    .route({
      summary:
        "How much of each signed-in runtime's subscription windows (5-hour, weekly…) is left, with 8 days of readings. rowrow reads it every 5 minutes; `refresh` reads it now.",
    })
    .input(z.object({ refresh: z.boolean().optional() }))
    .output(z.array(RuntimeUsage)),
  upgrade: oc
    .route({
      summary:
        "Run a runtime's own updater (no terminal, up to 10 minutes), then probe it again. Only when asked; agents running now keep the old version until their next run.",
    })
    .input(z.object({ runtime: z.string() }))
    .output(UpgradeResult),
  login: oc
    .route({
      summary:
        "Sign a runtime in through its own login, without a terminal; returns when it ends (up to the runtime's own deadline). While it runs, the runtime's `login` in state says what to open or type and the question it waits on (runtimes.loginAnswer). One at a time per runtime: asking again waits for the same one. A failed or cancelled sign-in leaves the previous one as it was.",
    })
    .input(z.object({ runtime: z.string() }))
    .output(LoginResult),
  loginAnswer: oc
    .route({
      summary: "Answer the question a running sign-in waits on, such as the code its sign-in page shows.",
    })
    .input(z.object({ runtime: z.string(), promptId: z.string(), answer: z.string() }))
    .output(ok),
  loginCancel: oc
    .route({ summary: "Stop a running sign-in; the previous login stays as it was." })
    .input(z.object({ runtime: z.string() }))
    .output(ok),
  logout: oc
    .route({
      summary:
        "Sign a runtime out through its own logout, on the server's machine (its own CLI there is signed out too), then probe it again. An API key in its environment is not touched: when its status still reads signed in, that's `failed` / `still_logged_in`. Not while a sign-in runs.",
    })
    .input(z.object({ runtime: z.string() }))
    .output(LogoutResult),
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
  revertFile: oc
    .route({
      summary:
        "Put one file back the way it was when an agent's latest turn started (a file git.changes lists in scope turn), from the turn's snapshots: a modified file gets its old content, a file the turn created is deleted, one it deleted comes back, a rename goes back to its old path; the executable bit is the one it had then. Pass the `base` git.changes gave (the turn's start snapshot): if another turn ran since, the call fails with CONFLICT. Refused, with nothing written, while that turn runs, when its snapshots are gone or its end wasn't captured, and when the file changed since the turn ended. Never touches another file, the index or commits. Returns the paths written or removed.",
    })
    .input(
      z.object({
        workspaceId,
        agentId: z
          .string()
          .optional()
          .describe("Whose latest turn (default: the workspace's latest, by any agent), as in git.changes."),
        path: z
          .string()
          .min(1)
          .max(4096)
          .describe("The file's path as git.changes lists it (a rename: its new path)."),
        base: z
          .string()
          .min(1)
          .max(100)
          .describe("git.changes' `base` for scope turn: the turn's start snapshot."),
      }),
    )
    .output(z.object({ paths: z.array(z.string()) })),
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
        "Upload a file (a screenshot, a log) to the server. Returns it as an attachment for agents.send (its absolute path on the server, which the agent reads). Kept for 7 days.",
    })
    .input(z.object({ file: z.file().max(25 * 1024 * 1024) }))
    .output(Attachment),
  get: oc
    .route({
      summary: "Download a file uploaded with files.upload (to show an attachment), by the path it returned.",
    })
    .input(z.object({ path: z.string() }))
    .output(z.file()),
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
  list: oc
    .route({
      summary:
        "Every file of a workspace's checkout, for browsing it as a tree: paths relative to the checkout's top, sorted, tracked and untracked, .gitignore honored, without tracked files deleted from the worktree. At most 50,000; truncated says when there were more. Open one with files.read.",
    })
    .input(z.object({ workspaceId }))
    .output(FileList),
  read: oc
    .route({
      summary:
        "A text file of a workspace's checkout, by its path relative to the checkout's top (as git.changes and files.search give it). Refuses binary files, directories, and anything outside the checkout or inside .git; stops at 1 MiB (truncated). With `rev`, the file as it was in that commit (git show <rev>:<path>) instead of the working tree.",
    })
    .input(
      z.object({
        workspaceId,
        path: z.string().min(1).max(4096),
        rev: z
          .string()
          .max(64)
          .optional()
          .describe(
            "A commit id (full or abbreviated hex, as git.log gives it): read the file as of that commit.",
          ),
      }),
    )
    .output(FileText),
  download: oc
    .route({
      method: "GET",
      summary:
        "Download a file of a workspace's checkout as it is on disk (binary too), or a folder as <name>.tar.gz of the files the tree lists in it (tracked and untracked, .gitignore honored, no .git). The same path rules as files.read. At most 256 MiB (a folder's files added up); bigger is refused with a message. Over HTTP: GET /api/files/download?workspaceId=…&path=….",
    })
    .input(z.object({ workspaceId, path: z.string().min(1).max(4096) }))
    .output(z.file()),
};

const commandRunId = z
  .string()
  .describe("A command run's id (cmd_…), as commands.run or commands.list gives it.");

const commands = {
  run: oc
    .route({
      summary:
        "Run a shell command in a workspace's directory, the way you would in a terminal there but without one: the user's shell (sh when $SHELL isn't usable) runs `-c <command>` with no input, in its own process group, with the server's environment (without rowrow's own credentials). Returns at once with the run (status running); follow its output with commands.output, stop it with commands.stop. When the shell exits, whatever it left running in its process group is stopped. Refused in an archived workspace. The server keeps each workspace's newest 20 runs, with the first 16 K and last 240 K characters of their output, until it stops (which stops them).",
    })
    .input(
      z.object({
        workspaceId,
        command: z.string().min(1).max(MAX_COMMAND_CHARS).describe("A command line, e.g. `pnpm test`."),
      }),
    )
    .output(z.custom<CommandRun>()),
  list: oc
    .route({
      summary:
        "The command runs the server keeps, newest first: a workspace's, or every workspace's. Each has its command, status (running, exited, stopped, failed), exit code or signal, and when it started and ended. Output: commands.output.",
    })
    .input(z.object({ workspaceId: workspaceId.optional() }))
    .output(z.array(z.custom<CommandRun>())),
  watch: oc
    .route({
      summary:
        "A workspace's command runs as a stream: the list now (as commands.list gives it), then again whenever one starts, is asked to stop, ends, or is forgotten.",
    })
    .input(z.object({ workspaceId }))
    .output(eventIterator(z.object({ runs: z.array(z.custom<CommandRun>()) }))),
  output: oc
    .route({
      summary:
        "A run's output after a cursor (characters since it began; 0 for all of it), then its output as it prints, then `end` with how it ended; the stream closes after `end`. Each `output` piece says where it starts (`at`): one that starts past your cursor means the middle of the output was dropped there (stdout and stderr come interleaved, as printed). Resume after a disconnect with the cursor you reached. `follow: false`: only what is kept now (and `end` if it has ended), then the stream closes.",
    })
    .input(
      z.object({
        runId: commandRunId,
        after: z.number().int().min(0).optional(),
        follow: z.boolean().optional(),
      }),
    )
    .output(eventIterator(z.custom<CommandOutput>())),
  stop: oc
    .route({
      summary:
        "Stop a running command: SIGTERM to its process group, SIGKILL 5 s later to whatever is left. Returns the run with stopping true (or as it ended, when it already had); it ends as `stopped`.",
    })
    .input(z.object({ runId: commandRunId }))
    .output(z.custom<CommandRun>()),
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
  subscribeApns: oc
    .route({
      summary:
        "Send this device (the iOS app) push notifications through Apple's push service: the token iOS gave the app, its bundle id (the APNs topic), Apple's environment (sandbox for builds from Xcode), and the app's own key, which what notifications say is encrypted with. Works once the server has an APNs key (notify.configureApns; app.info says `apns`).",
    })
    .input(
      z.object({
        token: z
          .string()
          .regex(/^[0-9a-fA-F]{32,400}$/)
          .describe("The device token, hex."),
        topic: z
          .string()
          .regex(/^[\w.-]{1,200}$/)
          .describe("The app's bundle id."),
        environment: z.enum(["sandbox", "production"]),
        key: z
          .string()
          .regex(/^[A-Za-z0-9+/]{43}=$/)
          .describe(
            "A 256-bit key the app keeps (base64). What a notification says is encrypted with it (AES-256-GCM): Apple's push service carries nothing it can read.",
          ),
      }),
    )
    .output(ok),
  unsubscribe: oc
    .route({ summary: "Stop push notifications for this device (Web Push and the iOS app's)." })
    .output(ok),
  watch: oc
    .route({
      summary:
        "Notifications for this device as a stream, for an app that stays connected instead of taking pushes (the Mac app): `badge` first (how many agents need you), then an `alert` when an agent finishes or needs you and no window of this device is focused (the rule Web Push follows; a focused device gets `badge` instead), and `seen` when agents stop needing you, so their notifications can go.",
    })
    .output(eventIterator(Notice)),
  test: oc
    .route({ summary: "Send a test notification to this device." })
    .output(z.object({ sent: z.number() })),
  send: oc
    .route({
      summary:
        'Notify the user about an agent, in your own words: a title and an optional line, to every device that takes notifications (Web Push, the iOS app, the Mac app) and as a toast in open browsers, even while someone is looking at that agent. Opening it opens the agent. The agent\'s transcript shows it ("Notified you: <title>"). From inside an agent, agentId defaults to that agent (`rowrow notify "<title>" ["<body>"]`). Use it for something worth interrupting someone for (a condition you were asked to watch for, a result they are waiting on), not for every finished turn: rowrow already says when an agent finishes or needs you. Give a dedupKey naming the event ("deploy-failed-<sha>") when you may see it again: the same key within 24 h is not sent again (sent: false). At most one per 10 s and 30 per hour per agent; more is refused (TOO_MANY_REQUESTS) with when to try again.',
    })
    .input(
      z.object({
        agentId: agentId
          .optional()
          .describe("The agent it's about (ag_…); from inside an agent, that agent."),
        title: z.string().trim().min(1).max(200).describe("What happened, in a few words."),
        body: z.string().trim().max(400).optional().describe("A line or two more."),
        dedupKey: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Names the event: the same key for this agent within 24 h is not sent again."),
      }),
    )
    .output(
      z.object({
        sent: z
          .boolean()
          .describe("false: the same dedupKey already notified you within 24 h, so nothing was sent."),
        seq: z
          .number()
          .describe("The notification's entry in the agent's log; when not sent, the earlier one's."),
        at: z.number().describe("When that was sent (epoch ms)."),
      }),
    ),
  configureApns: oc
    .route({
      summary:
        "Give the server your APNs key, so it can push to the iOS app you built (Apple takes pushes for an app only from its developer): the .p8 file's contents, its key id and your team id, from developer.apple.com → Certificates, IDs & Profiles → Keys. Stored in the profile (apns.json, mode 0600). Pushes then go through Apple's push service, which sees only that an agent finished or needs you: what they say is encrypted for each phone (notify.subscribeApns). `rowrow push apns <file.p8> --key-id … --team-id …` does this.",
    })
    .input(
      z.object({
        key: z.string().min(1).max(10_000).describe("The .p8 file's contents (PEM)."),
        keyId: z.string().describe("The key's id, 10 characters."),
        teamId: z.string().describe("Your team id, 10 characters."),
      }),
    )
    .output(z.object({ keyId: z.string(), teamId: z.string() })),
  removeApns: oc.route({ summary: "Forget the APNs key: no more pushes to the iOS app." }).output(ok),
};

const presence = {
  update: oc
    .route({
      summary:
        "What this connection is showing (route, agent) and whether the page is visible and focused. Suppresses notifications for what you're looking at. Over a WebSocket it describes that socket; over HTTP it describes the state.watch stream opened with the same `connection`.",
    })
    .input(
      z.object({
        route: z.string().max(500),
        agentId: z.string().nullable(),
        visible: z.boolean(),
        focused: z.boolean(),
        connection: connection.optional(),
      }),
    )
    .output(ok),
};

/** Whose turn a Coach read is for: implied by Coach's own token, named when you ask as yourself. */
const chatId = z
  .string()
  .optional()
  .describe("The Coach chat whose turn's workspaces to read (ag_…); Coach's own token implies it.");

/** A scheduled task as you write it (D-050). */
const TaskInput = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PROMPT_CHARS)
    .describe("The exact message each run sends Coach, in your words."),
  schedule: TaskScheduleArgs,
  notify: TaskNotifyArgs.default("every"),
});
const taskId = z.string().describe("A Coach task's id (tk_…).");

/** A workspace or agent picked with @ in Coach's composer (coach-mentions.ts). */
const CoachMention = z.object({
  kind: z.enum(["workspace", "agent"]),
  id: z.string().min(1).max(100).describe("The workspace's id (ws_…) or the agent's (ag_…)."),
  label: z
    .string()
    .min(1)
    .max(MAX_MENTION_LABEL)
    .describe("The name it was picked by: the text reads @<label>."),
  start: z.number().int().min(0).describe("Where its @label starts in text (UTF-16 offset)."),
  end: z.number().int().min(1).describe("Where it ends."),
});

const coach = {
  send: oc
    .route({
      summary:
        "Send a message to Coach (D-044), rowrow's assistant, which reads the agents in the workspaces settings.coach allows and does no coding itself; it proposes actions you confirm (D-045). Those workspaces (with settings.coach.fullAccess, all of them) are captured now and stay fixed for the turn, and its previews still waiting are cancelled: a new question replaces them. Starts a chat when there is none (or when settings.coach.runtime differs from the current chat's), applies settings.coach's model and effort, and refuses while Coach works or one of its actions executes. `chatId`: the chat you saw, so a stale window can't send to another one (CONFLICT). `mentions`: workspaces and agents the message references, each at its exact @label in the (trimmed) text; they focus the question, never widen what Coach may read and send the agents nothing, and one that's archived, removed or outside those workspaces refuses the message (PRECONDITION_FAILED: pick it again).",
    })
    .input(
      z.object({
        inputId: z.string().uuid().describe("A UUID you generate; the idempotency key."),
        text: z.string().trim().min(1).max(20_000),
        chatId: z.string().nullable().optional(),
        mentions: z.array(CoachMention).max(MAX_MENTIONS).optional(),
      }),
    )
    .output(SendResult.extend({ chatId: z.string() })),
  newChat: oc
    .route({
      summary:
        "Leave Coach's current chat (it stays in coach.chats) so the next message starts a new one. Not while Coach works.",
    })
    .output(ok),
  chats: oc
    .route({ summary: "Coach's chats, newest first (at most 200): its History." })
    .output(z.array(z.custom<CoachChat>())),
  open: oc
    .route({ summary: "Make an earlier Coach chat the current one again. Not while Coach works." })
    .input(z.object({ chatId: z.string() }))
    .output(ok),
  stop: oc
    .route({
      summary:
        "Stop Coach's answer: its proposals still waiting for you are cancelled first (they belonged to that question).",
    })
    .input(z.object({ chatId: z.string() }))
    .output(z.object({ accepted: z.boolean(), reason: z.string().optional() })),
  confirm: oc
    .route({
      summary:
        "Run an action Coach proposed (D-045), exactly as its card shows it: not while Coach is still answering, and one action at a time. Recorded as executing before anything happens, then as succeeded, failed or uncertain with what rowrow checked. A second confirm of the same action is refused (CONFLICT); an action never runs twice.",
    })
    .input(z.object({ chatId: z.string(), actionId: z.string() }))
    .output(z.custom<CoachActionView>()),
  cancel: oc
    .route({ summary: "Cancel an action Coach proposed; nothing runs. Not while Coach is still answering." })
    .input(z.object({ chatId: z.string(), actionId: z.string() }))
    .output(z.custom<CoachActionView>()),
  proposeWorktree: oc
    .route({
      summary:
        "Coach's tool propose_worktree_create: a pending proposal to create a worktree of a workspace in the turn's scope (with Full access, done at once: the receipt).",
    })
    .input(CoachToolArgs.propose_worktree_create.extend({ chatId }))
    .output(z.custom<CoachActionView>()),
  proposeAgent: oc
    .route({
      summary:
        "Coach's tool propose_agent_start: a pending proposal to start an agent in a workspace of the turn's scope with an exact first message (with Full access, done at once: the receipt).",
    })
    .input(CoachToolArgs.propose_agent_start.extend({ chatId }))
    .output(z.custom<CoachActionView>()),
  proposePrompt: oc
    .route({
      summary:
        "Coach's tool propose_agent_prompt: a pending proposal to send an exact message to an agent in the turn's scope (with Full access, done at once: the receipt).",
    })
    .input(CoachToolArgs.propose_agent_prompt.extend({ chatId }))
    .output(z.custom<CoachActionView>()),
  tasks: oc
    .route({
      summary:
        "Coach's scheduled tasks (D-050), newest first: each a prompt you wrote and a schedule (once, daily at a time in an IANA time zone, or every N minutes), whether it's paused, its next run, an occurrence queued behind another run, and its current and last run. Also in the app state (coach.tasks).",
    })
    .output(z.array(z.custom<CoachTask>())),
  taskRuns: oc
    .route({
      summary:
        "A task's runs, newest first (it keeps its latest 20): each is a Coach chat (chatId: read it with agents.view), with its status (running, waiting: it holds proposals for you, succeeded, failed, stopped) and error.",
    })
    .input(z.object({ taskId }))
    .output(z.array(z.custom<CoachTaskRun>())),
  createTask: oc
    .route({
      summary:
        "Create and enable a scheduled task (D-050): each run is a new Coach chat that sends Coach your prompt and reads the workspaces Coach may read then; runs never overlap, and occurrences missed while the server was down run once. Saved in Coach's permission mode now: with Full access on, its runs act without asking while Full access stays on. notify: every (a notification when each run finishes) or coach (Coach decides; failures still notify). At most 50 tasks.",
    })
    .input(
      TaskInput.extend({
        requestId: z.string().uuid().describe("A UUID you generate; the idempotency key."),
      }),
    )
    .output(z.custom<CoachTask>()),
  updateTask: oc
    .route({
      summary:
        "Edit a task: its words, schedule and notifications, saved in Coach's permission mode now. Only a schedule that runs at other times moves its next run; a paused task stays paused.",
    })
    .input(TaskInput.extend({ taskId }))
    .output(z.custom<CoachTask>()),
  pauseTask: oc
    .route({
      summary:
        "Pause a task (no more scheduled runs; one going finishes) or resume it (what passed while paused doesn't run, except a once that never did).",
    })
    .input(z.object({ taskId, paused: z.boolean() }))
    .output(z.custom<CoachTask>()),
  runTask: oc
    .route({
      summary:
        "Run a task now, beside its schedule (a paused one too): queued behind another task's run if one is going. CONFLICT while this task's own run is still open.",
    })
    .input(z.object({ taskId }))
    .output(z.custom<CoachTask>()),
  stopTask: oc
    .route({
      summary: "Stop a task's run that's going (and the proposals it holds for you). It doesn't notify.",
    })
    .input(z.object({ taskId }))
    .output(z.custom<CoachTask>()),
  deleteTask: oc
    .route({
      summary:
        "Delete a task: its run going is stopped, and its runs' chats go with it (one you carried on in Coach stays, as your chat).",
    })
    .input(z.object({ taskId }))
    .output(ok),
  listTasks: oc
    .route({
      summary:
        "Coach's tool list_coach_tasks (in a chat, not a task's run): every task, and the server's time and time zone for reading dates.",
    })
    .input(z.object({ chatId }))
    .output(z.custom<{ now: string; timeZone: string; tasks: Record<string, unknown>[] }>()),
  proposeTask: oc
    .route({
      summary:
        "Coach's tool propose_coach_task (in a chat, not a task's run): a pending proposal of a task, enabled when you confirm its card (with Full access, at once).",
    })
    .input(CoachToolArgs.propose_coach_task.extend({ chatId }))
    .output(z.custom<CoachActionView>()),
  notify: oc
    .route({
      summary:
        "Coach's tool send_user_notification (only a task's run, while it runs): notify the user, once a run, and never twice for the same eventKey of a task. accepted false says why (already_notified, run_limit).",
    })
    .input(CoachToolArgs.send_user_notification.extend({ chatId }))
    .output(
      z.object({
        accepted: z.boolean(),
        delivery: z.literal("best_effort").optional(),
        reason: z.enum(["already_notified", "run_limit"]).optional(),
      }),
    ),
  agentsStatus: oc
    .route({
      summary:
        "Coach's tool agents_status: the agents in the turn's workspaces and their status, bounded (80 agents).",
    })
    .input(CoachToolArgs.agents_status.extend({ chatId }))
    .output(z.custom<AgentsStatusResult>()),
  agentHistory: oc
    .route({
      summary:
        "Coach's tool agent_history: an agent's transcript as text (rowrow agent view's fold), its latest turns, at most 32,000 characters; `before` pages back.",
    })
    .input(CoachToolArgs.agent_history.extend({ chatId }))
    .output(z.custom<AgentHistoryResult>()),
  agentChanges: oc
    .route({
      summary:
        "Coach's tool agent_changes: the changed files of an agent's workspace (80 at most), or one file's diff (32,000 characters at most).",
    })
    .input(CoachToolArgs.agent_changes.extend({ chatId }))
    .output(z.custom<AgentChangesResult>()),
  agentBackground: oc
    .route({
      summary:
        "Coach's tool agent_background: the commands an agent runs in the background and the end of their output.",
    })
    .input(CoachToolArgs.agent_background.extend({ chatId }))
    .output(z.custom<AgentBackgroundResult>()),
};

const settings = {
  update: oc
    .route({
      summary:
        "Change settings that follow you to every device (quickReplies: what one tap puts in the composer; checkForUpdates: whether the server asks npm for a newer rowrow; instanceName: a name for this server, shown as rowrow · <name> in its page titles and installed app, empty for none; coach: the workspaces Coach may read and what it runs on). Give only what changes; returns all settings. Every client sees the change in its app state (state.settings).",
    })
    .input(Settings.partial())
    .output(Settings),
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
  coach,
  git,
  files,
  commands,
  devices,
  notify,
  presence,
  settings,
  telemetry,
  logs,
};
export type Contract = typeof contract;
