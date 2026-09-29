# Decisions

Each entry says what we chose, why (from the requirements, not from habit), and what
would make us revisit it. Newest last. Entries are never deleted; a reversed decision
gets a new entry that points back.

---

## D-001 Drive agents through oar, not terminals (2026-09-29)

**Context.** herdr runs each agent's own TUI in a PTY and works out its status by
reading the screen. That keeps each agent's native UI, but status is a heuristic (a new
permission dialog can read as idle), input is keystrokes (IME, paste and timing
problems), and a remote client has to stream terminal repaints.

**Decision.** rowrow drives agents through their programmatic interfaces via oar: one
ordered record stream per session, with explicit prompt, steer, queue and abort. No
PTY, no terminal emulator, no screen scraping.

**Why.** Every herdr feature rowrow wants gets better with structured data: status
comes from the runtime's own turn events, the transcript can be rendered for a phone,
input is a text field (IME and dictation just work), and a remote stream is a few
hundred bytes per event instead of screen repaints.

**Cost.** Native TUI features are gone: interactive menus, the agent's own slash-command
UI, its permission dialogs. rowrow must provide what matters (model switching, commands,
approvals) itself, or through oar.

**Revisit when** a runtime people need has no programmatic interface oar can drive.

## D-002 Two tiers: server and clients, no cloud relay (2026-09-29)

**Context.** Remote control needs a phone to reach the machine running the agents.
A cloud relay solves NAT traversal and can keep history readable while the machine
sleeps. It also needs hosted infrastructure, an identity provider, and replication
between the machine and the relay (acks, cursors, divergence, orphaned sessions).

**Decision.** The server on the machine is the only server. Clients connect to it
directly over a network the user already trusts: loopback, a LAN, Tailscale, or a
tunnel. rowrow provides the security (device credentials, TLS, origin checks) and the
documentation for those setups.

**Why.** Agents can't run while the machine sleeps anyway, so a relay mostly buys
reachability, which Tailscale and tunnels provide without us operating anything. One
tier removes the hardest distributed-systems problems.

**Revisit when** users need access without any VPN or tunnel, or want to read history
while the machine is off. The API is transport-agnostic (D-003), so a relay can be a
proxy in front of the same contract.

## D-003 One oRPC contract; WebSocket for browsers, HTTP for everything else (2026-09-29)

**Decision.** Every procedure is declared once in `src/shared/contract` with zod schemas
(oRPC contract-first) and implemented once. Browsers use one WebSocket for all calls and
subscriptions. The CLI, agents and scripts use HTTP with OpenAPI routes; streams arrive
as server-sent events.

**Why.** Contract-first gives the web app, the CLI and the server the same types, and
runtime validation where input arrives. Async-iterator streams give live data a typed
shape. OpenAPI makes the whole surface discoverable by an agent with `curl`. A single
WebSocket avoids the HTTP/1.1 limit of six connections per origin, which several live
subscriptions would hit, and compresses well (permessage-deflate) for phones.

**Revisit when** oRPC's WebSocket link can't express something we need (for example
per-message backpressure), or a second non-JavaScript client appears.

## D-004 oar comes from npm; unreleased oar changes are linked locally (2026-09-29)

**Decision.** rowrow depends on the published `@botiverse/oar` (0.8.0 has everything v0.1
needs, including the scripted test runtime). When rowrow needs an oar change, make it in
the oar repository (`../oar`, with oar's own tests and docs), try it here with
`pnpm add @botiverse/oar@link:../oar/packages/oar` without committing that, and move the
version once oar releases it.

**Why.** A registry dependency keeps CI and fresh clones simple. An earlier draft of this
entry pinned a git checkout at `.deps/oar`; oar 0.8.0 shipped the same day with what we
needed, so the checkout was removed before it was ever committed.

**Revisit when** rowrow needs oar changes faster than oar releases; then pin a git
commit.

## D-005 SQLite (built into Node) holds all durable state, including agent logs (2026-09-29)

**Decision.** One SQLite database per profile through `node:sqlite`: workspaces, agents,
entries, devices, seen markers, push subscriptions. Entries go in one table keyed by
`(agent_id, seq)`.

**Why.** The log needs frequent appends, crash safety, reads from any cursor, windowed
reads (the last few turns) and cross-agent queries while debugging. SQLite does all of
these; JSONL files do the first two. `node:sqlite` needs no native build. An agent can
inspect everything with `sqlite3`.

**Revisit when** write volume or database size becomes a measured problem; oar's voyage
format stays available as an export (`rowrow agent export`).

## D-006 The transcript fold runs in the client; summaries fold on the server (2026-09-29)

**Context.** A transcript can be built on the server (send the view and diffs of it) or
in the client (send log entries and fold them there).

**Decision.** Clients receive slim entries and fold them with oar's `reduceSessionView`.
The server folds only summaries, which every list and notification needs for every
agent.

**Why.** An append-only stream with a `seq` cursor is the simplest replication primitive
that is exactly right: resuming is "give me what's after N", with no loss or
duplication. Diffing a view tree correctly while text streams in is a protocol of its
own. The same pure fold runs in the CLI and tests, so what an agent sees when debugging
is what the UI showed. Windowed reads (start at a turn boundary; oar's fold adopts a
turn it joins midway) keep long sessions cheap to open on a phone.

**Revisit when** measured payloads on a phone make first paint slow even with windows
and compression.

## D-007 The agent is the durable unit; a workspace is a directory (2026-09-29)

**Context.** In herdr, the durable containers are workspace, tab and pane, and an agent
is a transient process inside a pane. Without terminals, tabs and panes have nothing
left to contain.

**Decision.** A workspace is a directory (usually a git checkout). An agent is a durable
conversation with one runtime in one workspace. A linked worktree is its own workspace,
grouped under its repository. Changes and diffs belong to a workspace, not to an agent.

**Why.** Several agents can share a checkout (a coder and a reviewer), and a worktree can
outlive the agent that used it. Diffs describe the files, which don't know which agent
wrote them.

**Revisit when** people consistently want one agent per worktree and nothing else; then
"new agent in a new worktree" becomes the only path.

## D-008 "Seen" is one marker per agent for the user, not per client (2026-09-29)

**Context.** herdr tracks acknowledgement per client, so a completion seen in one client
still shows as done in another.

**Decision.** One seen marker per agent. A client reports "seen up to seq N" only when
the agent's view is visible in a focused window.

**Why.** rowrow has one user with several devices. If you read the result on your phone,
the badge on your desktop is noise. A strict rule for reporting keeps "seen" honest.

**Revisit when** rowrow gets multiple users, which makes this per principal.

## D-009 Device credentials on every request, even from loopback (2026-09-29)

**Decision.** Every request needs a device credential: an HttpOnly session cookie for
browsers, a bearer token for the CLI. New browsers sign in with one-time links, minted
by `rowrow open` or shown as a QR code by **Pair a device**. There are no passwords.
Tokens are stored hashed, listed per device, and revocable.

**Why.** Agents run arbitrary commands, so the API is remote code execution by design.
Trusting loopback is unsafe once a tunnel or reverse proxy is in front of the server,
because those connections arrive from loopback. Links are easier on a phone than a
password and never get reused elsewhere.

**Revisit when** multiple users need accounts.

## D-010 Runs are lazy and idle out; a server restart ends them (2026-09-29)

**Decision.** A run starts on the first input to an agent with no live run, resuming the
runtime's conversation. After a turn it stays live for an idle timeout, then is disposed.
Stopping the server disposes all runs; on the next start, an unfinished run is recorded
as `crashed`.

**Why.** Each runtime process holds hundreds of megabytes; twenty idle agents shouldn't
cost gigabytes. Every runtime oar supports can resume its native conversation, so a
disposed run loses nothing but the process. Surviving a server restart would need a
separate process to own the agents' pipes; not worth it yet.

**Revisit when** restarts interrupting turns becomes a real complaint (for example
during upgrades); then split out a small, rarely restarted run host.

## D-011 Agents run without approval prompts for now (2026-09-29)

**Context.** oar starts runtimes with approval prompts disabled ("YOLO"): an embedded
agent with nobody at the prompt would hang. herdr's `blocked` status mostly comes from
those prompts.

**Decision.** v0.1 runs agents without approvals, and says so in the UI. The model, the
summary fold and the UI carry pending runtime requests from day one (oar's
`SessionView.pendingRequests`), so approvals slot in when oar grows an opt-in to pause on
them and an `answer` call. That is the first oar change on the roadmap.

**Revisit** as soon as the oar change lands.

## D-012 Node 24 runs the server's TypeScript directly (2026-09-29)

**Decision.** The server and CLI are written in erasable TypeScript (no enums,
namespaces or parameter properties; relative imports carry `.ts`) and run with `node`
directly. Only the web app is bundled (Vite).

**Why.** No build step between an edit and a restart, and stack traces point at the
source. oar already requires Node 24.

**Revisit when** we publish to npm (Node won't strip types under `node_modules`); then
bundle the server for the package only.

## D-013 One profile = one data directory (2026-09-29)

**Decision.** `ROWROW_HOME` (default `~/.rowrow`) holds one directory per profile:
`default` is yours, `dev` is `pnpm dev`'s, and tests use throwaway homes. A profile has
its own database, logs, worktrees, snapshots, VAPID keys and `server.json` (the address
and a local CLI token, mode 0600).

**Why.** Development, tests and agents must never touch the user's running instance or
data, and an agent debugging the user's instance must know exactly where to look.

**Revisit when** a system-wide install needs another layout.

## D-014 Web app: React 19, Vite, Astryx with pre-built CSS, StyleX for our own styles (2026-09-29)

**Context.** The user chose [Astryx](https://astryx.atmeta.com) (Meta's design system,
`@astryxdesign/*`, 0.6.x beta) for the UI. It can be used three ways: pre-built CSS with
no compiler, pre-built CSS plus the StyleX compiler for app styles, or a full source
build of Astryx through its own Vite plugin.

**Decision.** Pre-built Astryx CSS (`reset.css`, `astryx.css`, the neutral theme) plus
`@stylexjs/unplugin` for rowrow's own `stylex.create` styles (with its own class prefix
and CSS layer after Astryx's). All `@astryxdesign/*` packages pinned to one exact version.
`build.cssTarget` keeps native `light-dark()`.

**Why.** Astryx's components cover most of what rowrow needs (app shell, side nav with
status dots, chat layout and composer with `/` triggers, tool-call lists, streaming
Markdown, command palette, bottom sheets, resizable panels). Pre-built CSS keeps dev
builds fast (no compiling Astryx's source); StyleX keeps our own styles typed, atomic
and in the same layer system. A full source build saves ~10 KB of gzipped CSS, which
doesn't matter yet.

**Revisit when** CSS size or class collisions between the two StyleX outputs become a
measured problem (then use `@astryxdesign/build/vite`), or Astryx makes breaking changes
faster than we can follow (pin and wait).

## D-015 "Last turn" is per agent, from a snapshot at its start to one at its end (2026-09-29)

**Context.** The first version kept one baseline per workspace, taken when the workspace
went from quiet to active, and compared it with the worktree *now* (the approach
roamgate #37 describes). Seeding a demo exposed the flaw: with several agents taking turns
in one checkout, agent X's "last turn" showed whichever agent went last, and anything done
after X's turn ended leaked into X's diff.

**Decision.** Each agent keeps its own latest turn: a snapshot when rowrow starts the turn
(bounded: 5 s, else no baseline rather than a late, wrong one) and another when the runtime
ends it. The turn diff compares the two; while the turn runs, it compares the start with the
worktree now. The workspace page shows the workspace's most recent turn by any agent.

**Why.** "What did this agent just change?" is the question people ask when an agent
finishes, and it's per agent. The end snapshot makes the answer stable after the fact.

**Limits.** Agents working in the same checkout at the same time show up in each other's
turns: files don't know who wrote them, and we never claim attribution. Worktrees (one
agent per checkout) avoid it. A turn the runtime starts on its own (a queued input) has no
fresh start snapshot, so it merges with the previous one.

**Revisit when** runtimes report file edits reliably enough to attribute changes per tool
call.

## D-016 The OS supervisor keeps the server running, not a daemon mode (2026-09-29)

**Context.** Agents outlive clients only while the server lives, and remote control means
nobody is at the terminal that started it. `pnpm start` in a terminal dies with the terminal,
at logout, and on a crash.

**Decision.** `rowrow service install [serve flags]` writes a launchd agent (macOS) or a
`systemd --user` unit (Linux) that runs `node …/main.ts serve …` from the checkout, then waits
for the server to come up. It starts at login, restarts after a crash (not after a clean
stop), runs with the installing shell's PATH, and sends startup output to
`<profile>/service.log`. `status`, `restart` and `uninstall` go with it.

**Why.** Supervising processes is the OS's job, and it does it better than a homemade
`--daemon`: boot, login and crash restart, throttling, logs, and the user can inspect it with
tools they already know (`launchctl print`, `systemctl --user status`). The definitions are
plain files, generated by pure functions that are tested by round-tripping through `plutil`.

**Limits.** The service pins the `node` binary that ran the install; after changing Node
versions, install again. On Linux a user service stops at logout unless lingering is enabled
(install says so). Windows isn't supported.

**Revisit when** rowrow ships as an installable package (then the service runs its binary,
not a checkout), or when it gets a desktop app that owns the server.
