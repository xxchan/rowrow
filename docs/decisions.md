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
format stays available as an export (not built yet; today `rowrow agent entries --full`
dumps an agent's whole log as JSON lines).

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

> Revisited in D-022: the oar change exists (botiverse/oar#26), and prompts stay off.

## D-012 Node 24 runs the server's TypeScript directly (2026-09-29)

> Revisited in D-018, for the npm package: it runs `lib/`, JavaScript stripped from this
> source with every line and column kept. A checkout still runs `src/` directly.

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

> Superseded by D-017: the web app no longer uses Astryx or StyleX.

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

> Since D-018, a service installed from the npm package runs the package's
> `lib/cli/main.js`; one installed from a checkout still runs `src/cli/main.ts`.

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

## D-017 Web UI: Tailwind and components we own (shadcn/ui on Radix), not a design system (2026-09-29)

**Context.** D-014 adopted Astryx. The user doesn't like how it looks, and asked what
roamgate uses. roamgate uses no component library at all: hand-written components with
plain CSS, plus a few focused libraries (Radix Popover, cmdk, lucide icons, CodeMirror,
shiki, `@pierre/diffs`). Its look (dense, dark, calm developer tool) comes from owning
its styles, not from a library.

**Decision.** Tailwind CSS v4 for styling, and shadcn/ui components copied into the repo
(`src/web/components/ui`) on Radix primitives, restyled to a dense, dark-first look in the
spirit of roamgate, with a light theme too. Focused libraries where a component needs real
depth: cmdk (palette), sonner (toasts), react-resizable-panels (split view), lucide (icons),
shiki (code), and a proper diff renderer. Astryx and StyleX go.

**Why.** Owning the components means the look is ours to tune, which is the whole
complaint; a design system's look comes as a package. shadcn/ui gives accessible
dialogs, menus, sheets and popovers without hand-rolling focus management, and Tailwind
with shadcn is the stack coding agents know best, so agents write good UI code here. Tailwind's
output is only the classes we use.

**Rules.** Keep accessible names stable (the e2e suite finds things by role and name). Inputs are
at least 16px on phones (iOS zooms into smaller ones). Touch targets are at least 40px on phones.

**Revisit when** the owned components drift into inconsistency (then extract our own small
design tokens and variants), or Tailwind gets in the way of something specific.

## D-018 The npm package: types stripped into lib/, published from CI by trusted publishing (2026-09-29)

**Context.** Using rowrow meant cloning it and installing pnpm. Node runs our TypeScript
directly (D-012), but not under `node_modules`, so a package has to contain JavaScript. And
a publish token kept in CI is exactly what supply-chain attacks go looking for.

**Decision.**

- **The package.** `npm install -g rowrow` (Node 24, which oar requires) installs `lib/` (the
  server and the CLI), `dist/web` (the built web app, without source maps), the README and
  the license. `pnpm build` makes both, and `prepack` runs it. `dependencies` holds only what
  the server and the CLI import; everything the web app bundles is a devDependency.
- **The build.** `scripts/build-node.ts` writes each module the CLI imports (following
  imports from `src/cli/main.ts`, which leaves out tests and their helpers) into `lib/` at
  the same depth as in `src/`. Node's `stripTypeScriptTypes` (mode `strip`) turns types into
  spaces, and each relative `.ts` specifier becomes `.js`. The build fails if an import
  doesn't land on a module of the package. Paths found relative to a module (`package.json`,
  `dist/web`) hold from `src/` and from `lib/`, and `rowrow service` runs the `main` next to
  it, `.ts` or `.js`.
- **Releases.** Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`. A first job
  checks that the tag matches `version`, runs `pnpm check`, packs the tarball, then installs
  it with npm and runs it (`scripts/test-package.ts`, which CI runs too). A second job, in
  the GitHub environment `npm`, publishes that tarball with npm trusted publishing and
  creates the GitHub release. A prerelease version goes to the `next` dist-tag.

**Why.** No bundler: stripping is one Node API, with no dependency or configuration, and it
keeps D-012's promise in the package, since nothing moves: a stack trace points at the line
you wrote, with no source maps to ship or apply. Dependencies stay external, so npm installs
and deduplicates them as usual. Trusted publishing exchanges the job's short-lived OIDC
token for the publish, so no npm token exists to leak, and npm attaches provenance that ties
each version to this repository, workflow and commit. The job that runs our code and our
dependencies' code holds no credentials; the one that can publish runs only npm and gh.

**Limits.** `stripTypeScriptTypes` is still experimental in Node 24 (the build runs on the
Node pinned in `devEngines`). Only literal specifiers are rewritten and followed, so a
computed `import()` would break the package: don't write one. npm trusts a publisher only
for a package that already exists, so the first version under the name was published by
hand.

**Revisit when** Node strips types under `node_modules` (then ship `src/` as it is), a
runtime dependency has to be bundled or patched, or releases should wait for a person (npm's
staged publishing: CI runs `npm stage publish`, and a maintainer approves it with 2FA).

## D-019 Working-tree actions are narrow, and conditional on what the client saw (2026-09-29)

**Context.** roamgate #71: stage, unstage, discard and delete from the list of changes.
Discarding and deleting destroy work, and with agents editing the same checkout, the list a
person acts on is often seconds old.

**Decision.** Each action is a fixed procedure (`git.fileAction`, `git.bulkAction`) that runs
one git command, with literal pathspecs, on paths git itself reports as changed; a client
never sends a git command. Every row of the working list carries a stamp (git's status
record of its paths, their `lstat` metadata, and a hash of their content when small), and
every action, destructive or not, re-reads the state first: when it doesn't match, the
action fails with CONFLICT and changes nothing. A bulk action also refuses when it would
touch a file the client's list didn't have. Conflicts are resolved one file at a time, once
their markers are gone; bulk actions leave them alone.

**Why.** PRINCIPLES.md, product 4: destructive actions are narrow, confirmed and re-checked
so they never destroy newer work. The stamp is a precondition, like HTTP's If-Match: a click
on a stale list is harmless, and a retried action is refused instead of applied twice, with
no idempotency keys to store. Metadata (with change times, which no program can set back)
catches any write; the content hash covers filesystems with coarse timestamps.

**Cost.** A refused action costs a refresh and a second click, also after harmless changes
like `touch`. The action itself takes the repository's index lock like any git command, so
an agent committing at that moment can make it fail ("try again").

**Revisit when** hunk or line staging comes (a stamp per hunk), or refusals after
metadata-only changes become a nuisance (compare the content first).

## D-020 Pull request status comes from the host's `gh`, GitHub only for now (2026-09-29)

**Context.** roamgate #228: a workspace shows its branch's pull request with checks and
review. Calling GitHub's API directly needs a token that rowrow would store, per host, and
the logic for which PR belongs to a branch (push remotes, forks).

**Decision.** rowrow runs `gh pr view --json …` in the checkout (15 s timeout, answers cached
for a minute) and folds the answer. Every other outcome is an explicit state: detached, no
remote, not GitHub, gh not installed, gh signed out, no PR, error. Check and review data
that is missing or unrecognized never reads as passing or approved. GitLab remotes get "GitHub
only for now".

**Why.** gh already holds the user's sign-in (enterprise hosts included) and decides which PR
belongs to the current branch the way the user's own `gh pr view` does. rowrow stores no
credential and exposes none to a browser. Read-only: nothing is posted, merged or closed.

**Revisit when** GitLab users need it (`glab mr view --output json` as a second provider),
or one gh run per workspace a minute is too slow or hits rate limits (one GraphQL query for
all workspaces through `gh api`).

## D-021 Search goes through git's view of the checkout, not ripgrep (2026-09-29)

**Decision.** `files.search` lists names with `git ls-files --cached --others
--exclude-standard` and searches contents with `git grep --untracked -I`, 200 results each,
the output capped (the process is killed at 2 MiB) and timed (10 s).

**Why.** Names and contents then cover exactly the same files (tracked and untracked,
.gitignore honored), the ones the list of changes shows. ripgrep skips hidden files by
default and reads its own ignore files, so the two searches would disagree; git is always
installed, and there is no index to build or keep fresh.

**Revisit when** content search is too slow on big repositories (then ripgrep given git's file
list, or a persistent index).

## D-022 Agents run without permission prompts, by design; approvals are parked (2026-09-29)

**Context.** D-011 waited for oar to pause on an agent's permission prompts and questions.
It can now: botiverse/oar#26 adds `approvals: "ask"` and `Session.answer` for Claude Code,
Codex and Kimi, and rowrow could show an Allow / Deny card on the phone.

**Decision.** Prompts stay off, in oar and in rowrow (oar's default, as today). #26 is on
hold, unmerged. An agent that needs a decision says so in its reply and ends its turn: it
shows as `done`, and you answer in the composer.

**Why.** rowrow is for agents that keep going while you're away. Prompts would turn most
turns into `blocked` waits for a tap, and the protection they buy is thin next to what an
agent with a shell can do anyway. rowrow's safety is elsewhere: worktrees, repositories you'd
hand a colleague, and review after the fact (each turn's diff, discard, history).

**Limits.** Nothing stops a destructive command before it runs, and a runtime's mid-turn
structured question can't be answered (with prompts off, none arrive; one that did would
show as a request rowrow can't answer).

**Revisit when** agents should work on repositories you don't trust, or a runtime's own
sandbox becomes worth gating on: #26 is ready to take up.

## D-023 A new agent starts from where you are; C opens it; this browser remembers the setup (2026-09-29)

**Context.** Starting an agent was a form of six fields: workspace, runtime, model, effort,
worktree, first message. It always started on the first workspace and remembered only the
runtime, so starting a second agent like the one on screen took about ten clicks. There was
no key for it.

**Decision.** The first message comes first; the rest are chips already filled in:

- from an agent: its workspace (the repository, in a new worktree, when it works in one)
  and its runtime, model and effort;
- from a workspace: that workspace; from anywhere else: the workspace you last started one in;
- runtime, model, effort and the worktree choice: what you last used in that workspace.

`C` opens it from anywhere a bare key isn't typing (Linear's and GitHub's "create"). In ⌘K,
text that matches nothing becomes "Start an agent: …" (⌘Return starts one even when
something matches; ⌥Return opens the dialog with it). The home page has the same composer
above the list; on a phone the dialog is a bottom sheet, opened from a button at the bottom.
The resolution is a pure function (`src/web/lib/new-agent-setup.ts`), unit-tested.

**Why.** Most new agents go where you already are, set up like the last one there. Chips keep
every choice one key or tap away without making you read a form. The remembered setup lives
in `localStorage`: it's this device's preference, not a fact about agents (the log is the
truth), and losing it costs one choice.

**Limits.** A phone and a laptop remember separately. `C` does nothing while a text box has
focus (the composer, often): ⌘K works there. Bare-letter shortcuts now exist, so later ones
must skip text boxes and open menus the same way (`busyTarget` in `CommandMenu.tsx`).

**Revisit when** people want the setup to follow them across devices (move it into the
server's `settings` group), or someone asks to rebind keys.
