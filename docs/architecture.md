# Architecture

How rowrow is put together and why. The rules it serves are in
[PRINCIPLES.md](../PRINCIPLES.md); the reasons for each choice, and when to revisit them,
are in [decisions.md](decisions.md).

## What it is

rowrow runs many coding agents (Claude Code, Codex, Grok, Kimi, Pi) in parallel on your
machine and lets you steer them from any browser, including your phone. It borrows
[herdr](https://herdr.dev)'s model of a long-lived server that owns the agents,
workspaces, and attention-first status. It drops the terminal: agents are driven through
their programmatic interfaces via [oar](https://github.com/botiverse/oar), so status is
exact, transcripts are structured, and the whole thing works over a phone's network.

```
 browsers (desktop, phone PWA)          rowrow CLI, agents, scripts
        │  WebSocket (oRPC)                   │  HTTP (oRPC / OpenAPI)
        └───────────────┬─────────────────────┘
                        ▼
 ┌─ rowrow server (Node 24, one per machine and profile) ───────────────────────┐
 │  api/        contract → router; auth, trace and log middleware; ws + http     │
 │  agents/     one actor per agent: runs (oar sessions), input, log append      │
 │  store/      SQLite: workspaces, agents, entries (the logs), devices, seen    │
 │  state/      AppState (immer) → snapshot + patches to every client            │
 │  git/        worktrees, hooks, diffs, last-turn snapshots                     │
 │  notify/     attention transitions → web push                                 │
 │  telemetry/  JSONL logs, trace context, ring buffer, client error intake      │
 └──────────────────────────────┬────────────────────────────────────────────────┘
                                ▼
                  oar → claude · codex · grok · kimi · pi (child processes)
```

There are two tiers: the server and its clients. Remote control means reaching the
server over a network you trust (Tailscale, a tunnel, a LAN), with device credentials on
every request. There is no cloud relay (D-002).

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
  | { kind: "agent.created"; workspaceId; runtime; model?; title?; by }
  | { kind: "agent.updated"; changes; by }              // title, model, archived
  | { kind: "input"; inputId; text; mode; by }          // what you sent, before delivery
  | { kind: "input.result"; inputId; landed; code?; reason? } // where it landed
  | { kind: "run.started"; runId; runtime; model?; cwd; resume?; sessionId }
  | { kind: "run.failed"; runId; error }                // could not start
  | { kind: "oar"; runId; record: RawEvent }            // oar's record, verbatim
  | { kind: "run.ended"; runId; reason; code? }         // idle, stopped, exited, shutdown, crashed
  | { kind: "host.error"; code; message }
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

### Folds

All folds are pure functions in `src/shared`, used by the server, the web app, the CLI and
tests alike.

| Fold | From → to | Used by |
| --- | --- | --- |
| `timelineOf` | entries → timeline: one oar `SessionView` per run (`reduceSessionView`, `streamId = runId`), with rowrow's host facts between runs | the transcript, `rowrow agent view`, tests |
| `summaryOf` | entries → agent summary: live status and phase, last turn outcome, pending requests, preview, usage, last completion `seq` | the sidebar, attention, notifications |
| `attentionOf` | summary × seen marker → `blocked`, `done`, `working`, `idle` | everywhere a status is shown |
| `renderText` | timeline → plain text | the CLI and debugging agents |

The transcript fold runs **in the client** over slim entries (D-006). The server folds
summaries for every agent, because lists and notifications need them for all agents at
once.

## Agents at runtime

Each agent has one **actor**: a serial queue that every operation on the agent goes
through (send, abort, answer, restart, archive, change model). It owns the agent's
current run and is the only writer of its log. Serial execution makes the races easy to
reason about: two clients sending at once become an ordered prompt, then a steer.

- **Input.** `agents.send {inputId, text, mode}`. The actor records an `input` entry,
  starts a run if none is live (resuming the runtime's conversation), then prompts when
  idle or steers-or-queues when busy (oar decides where it can land). The outcome is an
  `input.result` entry. `inputId` is the idempotency key: a retried send returns the
  first outcome.
- **Runs.** A run starts lazily on the first input. It stays live after a turn for a
  while (the idle timeout), then is disposed to free memory. `run.ended` says why. At
  boot, a run with no end is closed as `crashed`.
- **Environment.** Each run gets `ROWROW_URL`, `ROWROW_TOKEN`, `ROWROW_AGENT_ID` and
  `ROWROW_WORKSPACE_ID`, so an agent can use the `rowrow` CLI to start, prompt and wait on
  other agents.

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
- **Notifications** fire on entering `blocked` and on a completion, after a short delay
  and a re-check (no flapping), and only if no focused client is looking at that agent.
  Channels: in-app toasts, then Web Push to devices that subscribed.

## Replicating state to clients

There are two kinds of replicated data, with one mechanism each:

- **AppState** is small and shared: host info, workspaces (with git summaries), agent
  summaries with attention, runtimes, settings. The server owns it in an immer store.
  `state.watch` sends a snapshot, then patches coalesced per tick. On reconnect a client
  takes a fresh snapshot; it is small.
- **Agent logs** are large and append-only. `agents.entries` reads a window (for
  example the last few turns), and `agents.watch {after}` streams entries after a cursor.
  On reconnect a client resumes from its last `seq`.

Everything else (diffs, files, model lists) is request/response, cached by the client.

## API

`src/shared/contract` declares every procedure once with zod schemas and a summary
written for an agent that has never seen the code. `src/server/api/router.ts` implements
it once. It is served two ways:

- **WebSocket** (`/rpc`) for browsers: one multiplexed, compressed connection that
  carries every call and subscription.
- **HTTP** (`/api/*`, OpenAPI at `/api/openapi.json`) for the CLI, agents and `curl`.
  Streams arrive as server-sent events.

Every call passes the same middleware: authenticate, adopt or create a trace id, log
`api.call` with duration and outcome, and turn errors into typed `ORPCError`s whose
message says what to do next.

## Auth and remote access

- The server binds to `127.0.0.1` by default. `--host` exposes it; `--tls-cert/--tls-key`
  serve HTTPS directly, or put it behind `tailscale serve` or a tunnel. Service workers
  and Web Push need HTTPS (or localhost).
- Every request needs a device credential, even from loopback: a tunnel or proxy makes
  remote requests look local. Browsers hold an HttpOnly session cookie, and the CLI holds
  a bearer token. Tokens are stored hashed.
- New browsers sign in with a one-time link: `rowrow open` mints one for this machine,
  and **Pair a device** shows one as a QR code for your phone. There are no passwords.
- WebSocket upgrades must come from the server's own origin.

## Workspaces and git

- A workspace is registered by path. rowrow reads its git facts (repository key, branch,
  upstream ahead and behind, changed files) and refreshes them after turns and on demand.
- **Worktrees.** "New worktree" creates a branch and a linked worktree from the freshly
  fetched default branch of `origin` (never assumed to be `main`), registers it as a
  workspace in the repository's group, and runs the repository's hooks. Removal refuses
  a dirty checkout unless forced and never deletes the branch.
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
  (kept a week) and mentioned by absolute path, which every runtime can read.
- **Inspector.** A workspace can also be looked into and tidied up through the API (and
  `rowrow ws log|show|search|read|pr`; the web UI for it is still to come):
  - *File actions* stage, unstage, discard unstaged edits, delete untracked files or mark a
    conflict resolved, one file or all at once. Each is one fixed git command on paths git
    itself reports, and carries the stamp of what the client saw: when the file changed
    since, it is refused and nothing happens (D-019).
  - *History* pages through the current branch's commits; a commit shows its message,
    people, dates, parents and files, compared with its parent (a root commit with the
    empty tree, a merge with its first parent).
  - *Search* finds file names and lines through git's own view of the checkout (tracked and
    untracked files, .gitignore honored, binaries skipped), bounded at 200 each, and
    `files.read` previews a file (D-021).
  - *Pull request*: the branch's GitHub PR (state, checks, review decision), read with the
    host's `gh`, so rowrow holds no token; every other outcome is an explicit state (D-020).

  All of it is in [git.md](git.md).

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

## Repository layout

| Path | Contents |
| --- | --- |
| `src/shared/` | Browser-safe code: the contract, schemas, entry types, folds. No Node built-ins. |
| `src/server/` | The server. `main.ts` is the composition root. |
| `src/cli/` | The `rowrow` CLI. |
| `src/web/` | The web app (React, Tailwind, shadcn/ui). Talks to the server only through the contract. |
| `test/` | Integration and end-to-end tests, fixtures, the scripted runtime. |
| `scripts/` | Development tools: dev runner, screenshots, the npm package's build (`build-node.ts`) and its test (`test-package.ts`). |
| `lib/`, `dist/web/` | Build output, not in git: the server and CLI as JavaScript, and the web app; the npm package ships both (D-018). |
