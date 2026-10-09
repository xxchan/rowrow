# Architecture

How rowrow is put together and why. The rules it serves are in
[PRINCIPLES.md](../PRINCIPLES.md); the reasons for each choice, and when to revisit them,
are in [decisions.md](decisions.md).

## What it is

rowrow runs many coding agents (Claude Code, Codex, Cursor, Antigravity, Grok, Kimi, OpenCode, Pi) in
parallel on your machine and lets you steer them from any browser, including your phone, or
from the iOS app (docs/ios.md) and the Mac app (docs/desktop.md). It borrows
[herdr](https://herdr.dev)'s model of a long-lived server that owns the agents,
workspaces, and attention-first status. It drops the terminal: agents are driven through
their programmatic interfaces via [oar](https://github.com/botiverse/oar), so status is
exact, transcripts are structured, and the whole thing works over a phone's network.

```
 browsers (desktop, phone PWA),    iOS app                 rowrow CLI, agents, scripts
 the Mac app's windows               │                        │
        │  WebSocket (oRPC)          │  HTTP + SSE (OpenAPI)    │  HTTP (oRPC / OpenAPI)
        └────────────────────────────┼──────────────────────────┘
                                     ▼
 ┌─ rowrow server (Node 24, one per machine and profile) ───────────────────────┐
 │  api/        contract → router; auth, trace and log middleware; ws + http     │
 │  agents/     one actor per agent: runs (oar sessions), input, log append      │
 │  store/      SQLite: workspaces, agents, entries (the logs), devices, seen    │
 │  state/      AppState (immer) → snapshot + patches to every client            │
 │  git/        worktrees, hooks, diffs, last-turn snapshots                     │
 │  commands/   commands run in a workspace: process groups, output in memory    │
 │  notify/     attention transitions → Web Push, APNs (sealed for the device)   │
 │  telemetry/  JSONL logs, trace context, ring buffer, client error intake      │
 └──────────────────────────────┬────────────────────────────────────────────────┘
                                ▼
                  oar → claude · codex · cursor · antigravity · grok · kimi · opencode · pi (child processes)
```

The Mac app is a client like the others (each window shows a server's own web app, and it
holds `notify.watch` for notifications), and also the manager of the servers it runs: it
installs a server bundle on this Mac or an SSH host (`ROWROW_HOME/versions/<version>`) and
drives that bundle's own `rowrow service` commands, so launchd or systemd supervises the
server as for a CLI install (D-030 to D-033, docs/desktop.md).

There are two tiers: the server and its clients. Remote control means reaching the
server over a network you trust (a LAN, Tailscale, a tunnel), with device credentials on
every request. There is no cloud relay, and the server never dials out to reach its
clients (D-002).

Local first means the server makes no connection of its own except these, and each one is
on the user's behalf:

- the agent CLIs, which talk to their model providers exactly as they do in a terminal;
- `git` and `gh`, for fetches, worktrees and pull request status;
- Web Push, only to devices that turned notifications on: each notification goes to that
  browser's push service (Apple, Google, Mozilla), encrypted for the device;
- APNs, only once you gave the server your APNs key and only to iOS apps that turned
  notifications on: Apple gets a generic alert, and what it says goes sealed with the
  app's own key (D-028).

No telemetry, update checks or accounts. Logs, including the browser's, stay in
`~/.rowrow`.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Server** | The `rowrow serve` process. It owns everything below. One per machine and profile. |
| **Client** | A connected browser tab, the CLI, or an agent using the API. Clients hold no truth: they render state and send intents. |
| **Device** | A credential: one signed-in browser or CLI token. Listed, named and revocable. |
| **Workspace** | A directory that agents work in, usually a git checkout. A repository's main checkout and its linked worktrees form a **worktree group** (keyed by the git common dir); the sidebar nests worktrees under their repository. |
| **Agent** | A durable conversation with one runtime (for example Claude Code) in one workspace. It lives for days. The unit you create, talk to, and get notified about. |
| **Run** | One live oar `Session` of an agent, from process start to exit. An agent has many runs: runs end when idle for a while, on restart, or when the process dies. The next input resumes the runtime's own conversation in a new run. |
| **Entry** | One element of an agent's log, with a dense per-agent `seq`. |
| **Turn** | One prompt and the agent's work in answer to it, ending when the runtime reports the turn ended. |
| **Attention** | Why an agent needs you now: `blocked` (it asked you something), `done` (it finished and you haven't seen it), otherwise `working` or `idle`. |

## The agent log

Every agent has one append-only log. It is the only source of truth about what happened
to the agent; everything the UI shows about an agent is computed from it.

```ts
type Entry = { seq: number; at: number } & (
  | { kind: "agent.created"; workspaceId; runtime; model?; effort?; serviceTier?; title?; role?; task?; by } // role "coach": D-044; task: D-050
  | { kind: "agent.updated"; changes; by; reason? }     // title, model, effort, serviceTier (D-049), archived; reason: D-047
  | { kind: "input"; inputId; text; mode; by; scope?; fullAccess? } // what you sent, before delivery
  | { kind: "input.result"; inputId; landed; code?; reason? } // where it landed
  | { kind: "run.started"; runId; runtime; model?; effort?; serviceTier?; cwd; resume?; sessionId }
  | { kind: "run.failed"; runId; error }                // could not start
  | { kind: "oar"; runId; record: RawEvent }            // oar's record, verbatim
  | { kind: "run.ended"; runId; reason; code? }         // idle, stopped, exited, shutdown, crashed
  | { kind: "host.error"; code; message }
  | { kind: "notification.sent"; title; body; dedupKey?; by } // notify.send: an agent told you
  | { kind: "coach.proposal"; proposal; by }           // Coach proposed an action: D-045
  | { kind: "coach.action"; actionId; status; detail; by } // what became of it: the receipt
);
```

- **Single writer.** Only the agent's actor appends. It assigns `seq` synchronously, so the
  order is total and dense.
- **Ack after commit.** Entries are committed to SQLite (batched per tick) before any
  client sees them, so a cursor never points past what survives a crash.
- **Host facts are separate from runtime facts.** rowrow never writes into oar's stream.
  "The server restarted and the run is gone" is a `run.ended {reason: crashed}` stamped
  when the server observed it at boot.
- **Lossless underneath, slim on the wire.** `oar` entries keep oar's `RawEvent` verbatim
  in the database. Clients get slim entries by default: frame `native` payloads are
  dropped (the folds never read them). `toApp` request bodies are kept, since a UI must
  show what the agent is asking. Full entries are available to debugging tools.
- **Packed when old (D-041).** Every few minutes, `oar` entries older than two minutes move
  from rows into zstd blocks of up to 2,000 (`entry_packs`), unchanged; other entries stay
  rows. Every read merges both by `seq`, so nothing above the log knows.

### Folds

All folds are pure functions in `src/shared`, used by the server, the web app, the CLI and
tests alike.

| Fold | From → to | Used by |
| --- | --- | --- |
| `timelineOf` | entries → timeline: one oar `SessionView` per run (`reduceSessionView`, `streamId = runId`), with rowrow's host facts between runs | the transcript, `rowrow agent view`, tests |
| `summaryOf` | entries → agent summary: live status and phase, last turn outcome, pending requests, preview, usage, last completion `seq`, the last notification it sent, when a person last sent it a message (the lists' order, D-053) | the sidebar, attention, notifications |
| `attentionOf` | summary × seen marker → `blocked`, `done`, `working`, `idle` | everywhere a status is shown |
| `renderText` | timeline → plain text | the CLI and debugging agents |
| `paceOf`, `chartSegments` | a subscription window's stored readings → its cycles, its pace against an even burn, where its chart line breaks (D-040) | Settings → Subscription usage, `rowrow runtimes usage` |

The transcript fold runs **in the client** over slim entries (D-006). The server folds
summaries for every agent, because lists and notifications need them for all agents at
once.

## Agents at runtime

Each agent has one **actor**: a serial queue that every operation on the agent goes
through (send, abort, answer, restart, archive, change model). It owns the agent's
current run and is the only writer of its log. Serial execution makes the races easy to
reason about: two clients sending at once become an ordered prompt, then a steer. Stopping a
turn doesn't wait in the queue (oar ends a runtime process that doesn't stop within 10 s), and
stopping the run waits behind other work for at most 10 s before it ends the process itself,
which settles a call a frozen runtime never answers.

- **Input.** `agents.send {inputId, text, mode}`. The actor records an `input` entry,
  starts a run if none is live (resuming the runtime's conversation), then prompts when
  idle. The outcome is an `input.result` entry. `inputId` is the idempotency key: a
  retried send returns the first outcome.
- **Busy input (D-035).** While a turn runs, `mode` says where input goes. `queue` (and
  `auto`) is held by rowrow (`input.result` landed `queued`, `held`) and sent as the next
  turn's prompt when the turn ends, one per turn, in order (`input.sent`). Until then it can
  be taken back (`agents.withdraw` → `input.withdrawn`) or sent now (`agents.sendNow`: a
  steer while it works, the next turn when idle). `steer` goes into the running turn and
  can't be taken back; a runtime that can't steer holds it instead, with a `reason`.
  `interrupt` aborts the turn, then prompts. When a turn is stopped or fails, or the run
  exits or rowrow restarts, held inputs wait (`queue.paused`) until someone resumes them
  (`agents.resume`, `queue.resumed`). The summary folds all of this into `queued`,
  `queuePaused`, `steering` (steered, not read yet; a stopped turn leaves it for the next) and
  `unread` (dropped: the runtime said so, `input_dropped`, or its process ended first).
- **Runs.** A run starts lazily on the first input. It stays live after a turn for a
  while (the idle timeout), then is disposed to free memory; not while work it started runs
  in the background (a dev server, a build), which disposing would end. `run.ended` says why. At
  boot, a run with no end is closed as `crashed`.
- **Environment.** Each run gets `ROWROW_URL`, `ROWROW_TOKEN`, `ROWROW_AGENT_ID` and
  `ROWROW_WORKSPACE_ID`, so an agent can use the `rowrow` CLI to start, prompt and wait on
  other agents, and `rowrow notify` to tell you something about itself (requests with the
  agents' token and `ROWROW_AGENT_ID` act as that agent).

## Attention and notifications

Status vocabulary, in priority order (a workspace shows its highest):

| Status | Meaning | From |
| --- | --- | --- |
| `blocked` | the agent is waiting on a question or approval | pending `toApp` requests in the summary |
| `done` | a turn ended after the last time you looked | last completion `seq` > your seen marker |
| `working` | a turn is running; `stalled` when silent for too long (fold × clock) | oar's status fold |
| `idle` | nothing new | otherwise |

- **Seen.** One marker per agent, for you (not per client): the log position you have
  seen. A client reports it only when the agent's view is visible in a focused window.
- **Pins** (D-046) sit beside it: when you pinned the agent, or null. Pinned agents lead
  every list in pin order (`byPin` in `src/shared/schemas.ts`), before attention order.
- **Order** (D-053): within a list's groups, the agent a person last sent a message to comes
  first (`byLastPersonInput`, from `summary.lastPersonInputAt`); what an agent does never moves it.
- **Notifications** fire on entering `blocked` and on a completion, after a short delay
  and a re-check (no flapping), and only if no focused client is looking at that agent.
  Channels: in-app toasts (the iOS app: its own banners), then Web Push and APNs to devices
  that subscribed and have no focused window, and `notify.watch` streams (the Mac app) the
  same way. APNs pushes and the Mac app's notifications carry Reply and Mark as Seen and the
  badge; seeing an agent anywhere clears its notifications on every phone and Mac.
- **Agents' own notifications** (`notify.send`, `rowrow notify "<title>" ["<body>"]`, D-043):
  an agent says what happened in its own words, for a condition it was asked to watch for.
  It is logged as `notification.sent` (the transcript shows "Notified you: <title>" where it
  was sent) and sent at once, whether or not anyone is looking at the agent: browsers toast
  it from AppState (`summary.lastNotification`), Web Push and `notify.watch` go to devices
  with no focused window (a focused one shows the toast), and APNs to every phone, where the
  app shows it unless that agent is on screen. In browsers and on phones each is its own
  notification (it replaces neither "finished" nor an earlier one; the Mac app keeps one per
  agent), and it opens the agent. A `dedupKey` sends once per agent per 24 h, and an agent
  may send one per 10 s and 30 an hour; both count the log, so they hold across restarts.

## Coach

Coach (D-044) is rowrow's assistant: it reads the agents of the workspaces you allow, helps
you keep track of them and proposes actions you confirm (D-045), and does no coding itself. It is roamgate's Ranger, built from
rowrow's own parts.

- **A chat is an agent** with `role: "coach"`: same actor, log, runs, transcript, stop, model
  and effort. It runs in `<profile>/coach`, in no workspace, and AppState carries it as
  `coach.chat` instead of under `agents`, so lists, counts, attention toasts, notifications and
  `rowrow agents` never see it. Leaving a chat archives it; `coach.chats` is its History.
- **A message** goes through `coach.send`, which captures `settings.coach.workspaces` (those
  still there) into the `input` entry's `scope`, fixed for the turn, and applies Coach's model,
  effort and runtime from `settings.coach`. The runtime reads the scope as a frame before your
  text (`src/server/coach/prompt.ts`); the transcript shows your text.
- **References** (Ranger's mentions, `src/shared/coach-mentions.ts`): @ in Coach's composer
  offers the workspaces of the next message's scope and their agents not archived, from
  AppState (`CoachMentions.tsx`). A pick binds `{kind, id, label}` to the exact `@label` it
  inserted; an edit inside that text unbinds it, so typed or pasted names stay text. Each
  chat's draft keeps its own (`useCoachMentions`, in memory like the text). `coach.send` takes
  them as `mentions` with their offsets, refuses ones that don't match the text or aren't in
  the captured scope (archived, removed, outside it: "select it again"), and keeps them on the
  `input` entry. The frame lists them, by id with their current names, as data after the
  scope; they widen nothing and send the agents nothing. The transcript draws each as a link to
  `/a/<id>` or `/w/<id>`, opened only while it still exists.
- **A run** opens with Coach's system prompt in place of the runtime's, the runtime's built-in
  tools turned off by name (`src/server/coach/tools.ts`), and one MCP server, `rowrow mcp
  coach` (`src/cli/mcp.ts`), whose environment holds a token minted for that run. Only claude
  and pi take all three; the picker says why the others can't be Coach. Claude also starts with
  `--strict-mcp-config --setting-sources ""` (oar's `launchArgs`) and auto memory off
  (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), so the user's own MCP servers, claude.ai connectors,
  settings, hooks, plugins, skills and CLAUDE.md stay out (managed policy still applies). How
  the user's claude signs in comes back from their settings file (`$CLAUDE_CONFIG_DIR` or
  ~/.claude, `src/server/coach/claude-settings.ts`): its `env` goes into the run's environment,
  under rowrow's own variables, and its credential helpers (`apiKeyHelper`, `awsAuthRefresh`,
  `awsCredentialExport`, `gcpAuthRefresh`) into `--settings` with nothing beside them (argv, so
  a helper's command shows in `ps`); a file that can't be read logs
  `coach.claude_settings_unreadable` and the run starts without it. Pi refuses launch flags and
  still adds its AGENTS.md files (docs/upstream.md). The tools claude says it loaded are
  checked: any but rowrow's is a warning in the log and in the chat.
- **Its tools** are four reads and three proposals, each a `coach.*` procedure. The reads: `agents_status`, `agent_history`
  (the `agent view` fold, paged back by turns), `agent_changes` (files, or one file's diff) and
  `agent_background` (background commands and the end of their output). The token reaches only
  these and the proposals, and they reach only the turn's scope; results are bounded (80 items, 8,000
  characters a message, 32,000 a read) and say when they were read and when something was cut.
- **Its actions** (D-045): `propose_worktree_create`, `propose_agent_start` and
  `propose_agent_prompt` freeze a proposal in the chat's log (`coach.proposal`). Your Confirm
  (`coach.confirm`, never on the token's list) re-checks the target, records `executing`, runs
  exactly what was frozen (`src/server/coach/actions.ts`) and records rowrow's receipt
  (`coach.action`: succeeded, failed or uncertain); the next message's frame carries the latest
  receipts to the model. Previews expire with their question, a stop, narrower settings or a
  restart. With Full access (`settings.coach.fullAccess`, on only through a dialog) every
  workspace is in scope and a proposal runs at once.
- **Its window** (`src/web/components/Coach.tsx`) opens from every page's header or ⌘⌥⇧A:
  floating at the right, pinned beside the page, or maximized; full screen on a phone. Its
  conversation is the transcript component, with each answer's tool calls folded into "Work
  performed (N)", its actions as cards under the answer that proposed them
  (`CoachActionCard.tsx`), and a wave bar to jump between messages (`ConversationWave.tsx`, the
  one an agent's transcript has on a desktop).
- **Its tasks** (D-050, `src/server/coach/tasks.ts`; the schedule math and the planner are pure,
  in `src/shared/coach-tasks.ts`): a prompt and a schedule in `coach_tasks`, with the next
  occurrence and one that came due and waits (missed ones combine into it). A timer starts each
  run as a new Coach chat (`agent.created {task}`, archived until you open it, so it never
  replaces your chat) sent the prompt `by: system`, with what Coach may read then; one run works
  at a time, and a task whose run holds proposals waits for you. `coach_task_runs` is the
  scheduler's record of each run (its chat, the occurrence, how its turn ended, read from the
  chat's log), which decides the notification: fixed alerts, or with "Let Coach decide" only
  failures, confirmations and Coach's own `send_user_notification` (once a run, an `eventKey`
  once per task, kept in `coach_task_notices`). Those go out through `Notifier.taskNotice` and,
  for open windows, as the task's `lastNotice` in AppState (`coach.tasks`), and open Coach on
  the task and run. A run's MCP server has `send_user_notification` instead of the task tools
  (`ROWROW_COACH_TASK_RUN`). Each task keeps its newest 20 runs; older runs' chats are forgotten
  (`AgentService.forget`), unless you carried one on. The Tasks view (`CoachTasks.tsx`) lists
  them, shows one with its run history and each run's chat, and edits them; `rowrow coach tasks`.
- **On the iOS app** Coach is a tab (`ios/Rowrow/Views/CoachScreen.swift`): the chat with
  History, New chat and Stop, the action cards (the kit's `action` transcript items, placed
  after the answer that proposed them as the web app places its cards), and Tasks (run now,
  pause, resume, stop, delete, each run's chat). A task's notification carries `coachTask` and
  `coachRun`, and opens that run. Coach's settings, turning Full access on and the task form
  stay in the web app.

## Replicating state to clients

There are two kinds of replicated data, with one mechanism each:

- **AppState** is small and shared: host info, workspaces (with git summaries), agent
  summaries with attention, runtimes, settings, Coach's current chat and its tasks. The server
  owns it in an immer store.
  `state.watch` sends a snapshot, then patches coalesced per tick. On reconnect a client
  takes a fresh snapshot; it is small.
- **Agent logs** are large and append-only. `agents.entries` reads a window (for
  example the last few turns), and `agents.watch {after}` streams entries after a cursor,
  in batches at most ten a second (a streaming answer is dozens of small records a second).
  On reconnect a client resumes from its last `seq`.

Everything else (diffs, files, model lists) is request/response, cached by the client.

## API

`src/shared/contract` declares every procedure once with zod schemas and a summary
written for an agent that has never seen the code. `src/server/api/router.ts` implements
it once. It is served two ways:

- **WebSocket** (`/rpc`) for browsers: one multiplexed, compressed connection that
  carries every call and subscription.
- **HTTP** (`/api/*`, OpenAPI at `/api/openapi.json`) for the CLI, agents, `curl` and the
  iOS app. Streams arrive as server-sent events. An HTTP client names its `state.watch`
  stream (`connection`) so `presence.update` can describe it (D-026).

Besides the procedures, the server serves the kit at `/kit.js`: `src/shared`'s folds bundled
for JavaScriptCore, which the iOS app runs to read the agent log exactly as the web app does
(D-027).

Every call passes the same middleware: authenticate, adopt or create a trace id, log
`api.call` with duration and outcome, and turn errors into typed `ORPCError`s whose
message says what to do next.

## Auth and remote access

- The server binds to `127.0.0.1` by default. `--host` exposes it; `--tls-cert/--tls-key`
  serve HTTPS directly, or put it behind `tailscale serve` or a tunnel. Service workers
  and Web Push need HTTPS (or localhost).
- Every request needs a device credential, even from loopback: a tunnel or proxy makes
  remote requests look local. Browsers hold an HttpOnly session cookie; the CLI and the
  iOS app hold a bearer token (the app in the Keychain). Tokens are stored hashed.
- New browsers sign in with a one-time link: `rowrow open` mints one for this machine,
  and **Pair a device** shows one as a QR code for your phone. The iOS app scans the same
  code and trades it for a token (`POST /auth/token`). There are no passwords.
- WebSocket upgrades must come from the server's own origin.

## Workspaces and git

- A workspace is registered by path (the + beside the side nav's Workspaces, ⌘K's New
  workspace, `rowrow ws add`), optionally with a name. rowrow reads its git facts (repository
  key, branch, upstream ahead and behind, changed files) and refreshes them after turns and on
  demand.
- **Rename, archive, remove** (D-047; the workspace's right-click and ⋯ menus, ⌘K, `rowrow ws
  rename|archive|unarchive|remove`, a swipe on iOS). Archiving hides the workspace, the
  worktrees under it and their agents (through the workspace: `src/shared/workspaces.ts`,
  their own flags untouched), stops their runs and refuses new agents, sends and worktrees
  there until it's unarchived. Removing (`workspaces.remove`, `workspaces/lifecycle.ts`)
  makes rowrow forget it and the worktrees registered under it, never their files; refused
  while one of their agents works; their agents are archived with the reason, and their
  turn baselines, snapshots, pull request cache and Coach permission go.
- **Worktrees.** "New worktree" creates a branch and a linked worktree from the freshly
  fetched default branch of `origin` (never assumed to be `main`), registers it as a
  workspace in the repository's group, and runs the repository's hooks. Removal refuses
  a dirty checkout unless forced and never deletes the branch; rowrow then forgets the
  workspace and archives its agents.
- **Hooks** come from `rowrow.json` at the repository root: `worktree.setup`, `opened`,
  `teardown`, `removed`. A failed teardown blocks removal.
- **Diffs** have three scopes: working tree, branch (against the merge base with the
  default branch), and an agent's last turn (between snapshots taken when the turn started
  and when it ended, D-015). A snapshot never touches your index or object store: it is
  written to a private object directory that borrows the repository's objects as
  alternates.
- **Review.** Comments on diff lines collect per workspace in the browser and compile into
  one "Review feedback" message that fills the agent's composer; you send it.
- **Files.** Pasted, dropped or picked files are uploaded to the profile's `uploads/`
  (kept a week) and wait as tiles above the composer. A message carries them as
  attachments: the runtime reads their absolute paths listed before your text, and images
  also as its own image input when it takes images (D-024).
- **Inspector.** A workspace can also be looked into and tidied up through the API (and
  `rowrow ws log|show|search|read|download|pr`), and in the web app's Changes / Files /
  History tabs:
  - *File actions* stage, unstage, discard unstaged edits, delete untracked files or mark a
    conflict resolved, one file or all at once. Each is one fixed git command on paths git
    itself reports, and carries the stamp of what the client saw: when the file changed
    since, it is refused and nothing happens (D-019).
  - *Revert* puts a file the last turn changed back as the turn's start snapshot had it,
    unless it changed since the turn ended, which the end snapshot says (D-051).
  - *History* pages through the current branch's commits; a commit shows its message,
    people, dates, parents and files, compared with its parent (a root commit with the
    empty tree, a merge with its first parent), and `files.read {rev}` reads a file as it
    was in a commit.
  - *Search* finds file names and lines through git's own view of the checkout (tracked and
    untracked files, .gitignore honored, binaries skipped), bounded at 200 each, and
    `files.read` previews a file (D-021).
  - *Downloads*: `files.download` sends any file, or a folder as a .tar.gz of what the tree
    shows, up to 256 MiB, as a GET the browser can fetch with its cookie (D-042).
  - *Pull request*: the branch's GitHub PR (state, checks, review decision), read with the
    host's `gh`, so rowrow holds no token; every other outcome is an explicit state (D-020).

  All of it is in [git.md](git.md).
- **Commands** (D-052, `src/server/commands/service.ts`; the inspector's Commands tab, `rowrow ws
  run|runs|output|stop`): `commands.run` runs a command line in the workspace's folder, the
  user's shell with `-c`, no input and no TTY, in its own process group, with the server's
  environment minus rowrow's own credentials. Stop (and archiving, removing, the server
  stopping) sends the group SIGTERM, then SIGKILL after 5 s; when the shell exits, what it left
  in its group is stopped too. Runs live in memory, not in a log: each workspace's newest 20,
  with the first 16 K and last 240 K characters of output. `commands.watch` streams a
  workspace's runs, `commands.output` a run's output from a character cursor to its end.
  "Send to agent" fills a composer with the command, how it ended and the end of its output
  (`commandReport` in `src/shared/commands.ts`).

## Observability

- **Logs.** The server writes JSON lines to `<profile>/logs/rowrow.jsonl` and keeps a ring
  buffer for fast queries and live tails. Each line has `time`, `level`, `evt` (a stable,
  dot-namespaced event name), `trace`, and ids for the work it belongs to (`agent`,
  `run`, `ws`, `device`). Query with `rowrow logs`.
- **Traces.** A trace id starts in the browser (or CLI), travels in a request header,
  lives in AsyncLocalStorage on the server, and is stamped on every log line and on the
  entries the action caused.
- **Browser errors** (uncaught errors, rejected promises, render errors, failed calls,
  connection drops) are sent to `telemetry.report` and logged as `client.*` with device,
  route and version.
- **Introspection.** `rowrow status` (server, runs, clients, recent problems),
  `rowrow state` (the AppState the UI renders), `rowrow agent view <id>` (the transcript
  fold as text), `rowrow agent entries <id>` (the raw log), `rowrow shot <route>` (a
  screenshot of the real UI, desktop or mobile).

## Tests

| Layer | What | Runs |
| --- | --- | --- |
| Unit | folds, git helpers, auth, store | `pnpm test` |
| Integration | the whole server in-process on a temp profile with a scripted runtime, driven through the real oRPC client over HTTP and WebSocket | `pnpm test` |
| End to end | the built web app in Chromium against a real server with the scripted runtime; screenshots in `test-results/` | `pnpm test:e2e` |
| Package | the npm tarball's contents, then the tarball installed with npm in a throwaway prefix and run: serve, status, the web app, a scripted agent | `pnpm test:package` |
| iOS core | the Swift package: JSON patches, sealed pushes, Coach's models and words, and a real server from the checkout driven through the Swift client (pairing, state, the kit, transcripts, diffs, uploads, Coach and its tasks) | `pnpm ios:test` |
| Mac app | its pure logic (planning a host, SSH scripts run by a real `sh`, the server list) and its connection against a real server, in `pnpm test`; the app itself in Electron, driven by Playwright (set up this Mac, sign in by link, notifications) | `pnpm test` and `pnpm test:desktop` |
| Server bundle | a bundle in a throwaway `ROWROW_HOME/versions`, run by its own `bin/rowrow` with no Node on the PATH | `pnpm test:package --bundle <dir>` |

## Repository layout

| Path | Contents |
| --- | --- |
| `src/shared/` | Browser-safe code: the contract, schemas, entry types, folds. No Node built-ins. |
| `src/server/` | The server. `main.ts` is the composition root. |
| `src/cli/` | The `rowrow` CLI. |
| `src/web/` | The web app (React, Tailwind, shadcn/ui). Talks to the server only through the contract. |
| `src/kit/` | The kit: `src/shared`'s folds as one script for JavaScriptCore (D-027). |
| `ios/` | The iOS app (SwiftUI), its notification extension, and `RowrowCore` (docs/ios.md). |
| `src/desktop/` | The Mac app (Electron): its main process, its preload, and its own pages in `ui/` (docs/desktop.md). |
| `desktop/` | What the Mac app's build needs: icons, entitlements, and the signing and packing scripts. |
| `test/` | Integration and end-to-end tests, fixtures, the scripted runtime. |
| `scripts/` | Development tools: dev runner, screenshots, the npm package's build (`build-node.ts`) and its test (`test-package.ts`), server bundles (`build-bundle.ts`), the Mac app's build and packaging. |
| `lib/`, `dist/web/`, `dist/kit/` | Build output, not in git: the server and CLI as JavaScript, the web app, and the kit; the npm package ships them (D-018). |
| `dist/bundles/`, `dist/desktop/`, `dist/desktop-release/` | Build output, not in git: server bundles, the Mac app's code, and rowrow.app. |
