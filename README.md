<p align="center"><img src="src/web/public/icon-192.png" width="72" alt=""></p>

<h1 align="center">rowrow</h1>

<p align="center">
  Run a crew of coding agents (Claude Code, Codex, Grok, Kimi, Pi) side by side on your
  machine, and steer them from any browser, including your phone.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rowrow"><img src="https://img.shields.io/npm/v/rowrow" alt="npm"></a>
  <a href="https://github.com/xxchan/rowrow/actions/workflows/ci.yml"><img src="https://github.com/xxchan/rowrow/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

rowrow borrows [herdr](https://herdr.dev)'s idea: a long-lived server owns your agents, and
every screen is organized around one question, *who needs me now?* It drops the terminal.
Agents are driven through their programmatic interfaces with
[oar](https://github.com/botiverse/oar), so status comes from the agent itself (never from
screen scraping), transcripts are structured, and a phone on a flaky network is a
first-class client.

<p align="center">
  <img src="docs/images/agent.png" alt="An agent's conversation next to the inspector, showing what its last turn changed" width="820">
</p>
<p align="center">
  <img src="docs/images/phone-home.png" alt="Agents sorted by who needs you, on a phone" width="240">
  &nbsp;
  <img src="docs/images/phone-agent.png" alt="An agent's conversation on a phone" width="240">
</p>

## What it does

- **Who needs you, first.** Every agent is `blocked`, `done` (finished and you haven't
  looked), `working` or `idle`, and every list sorts by it. You get a push notification when
  an agent finishes or needs you, never for the one you're looking at; one tap (or ⌘J)
  takes you to the next one, and the Home Screen icon counts them.
- **Agents outlive the browser.** Close the tab, lose Wi-Fi, switch to your phone: work goes
  on, and every client resumes exactly where it left off.
- **Talk to them from anywhere.** Send, steer a running turn, queue for the next one, or
  stop. Type `/` for the agent's own commands and skills, tap a quick reply you use often,
  switch model or effort mid-conversation, paste or drop a screenshot. A retried send is
  never delivered twice.
- **See what they changed.** The inspector beside every agent has three tabs:
  - *Changes*: what the agent's last turn changed (snapshots taken at its start and end,
    stored outside your repository), everything uncommitted, or the whole branch; stage,
    unstage, discard or delete files, never touching a file that changed since you looked.
  - *Files*: search names and contents, and read any file, Markdown rendered.
  - *History*: the commits, and the branch's pull request with its checks and review.
- **Review in place.** Comment on diff lines, or select a passage the agent wrote and
  comment on that; your comments become one review message in the agent's composer.
- **Parallel work in worktrees.** One click makes a git worktree on a fresh branch from
  origin's default branch, grouped under its repository, with your repository's setup
  hooks (`rowrow.json`, or roamgate's and paseo's).
- **Built to be driven and debugged by agents.** Everything the UI does is a typed API that
  the `rowrow` CLI exposes; every action carries a trace id through structured logs;
  browser errors land in the server log; any transcript can be re-rendered from its log.

## Install

Needs Node.js 24 or later, git, and at least one agent CLI you're already signed in to
(`claude`, `codex`, `grok`, `kimi` or `pi`).

```bash
npm install -g rowrow
rowrow serve                   # serves rowrow on http://127.0.0.1:7373
```

`rowrow serve` prints a one-time sign-in link; open it. Later, `rowrow open` signs a
browser in and opens it. There are no passwords: browsers sign in with one-time links, and
every signed-in device can be revoked in Settings.

To keep rowrow running without a terminal (it starts when you log in and restarts after a
crash), run it as a service instead, with the same flags as `serve`:

```bash
rowrow service install         # launchd on macOS, systemd on Linux
rowrow service status          # also: restart (after npm install -g rowrow), uninstall
```

The service runs the `node` it was installed with, so install it again after switching Node
versions.

## On your phone

rowrow listens on `127.0.0.1` until you decide otherwise, and every request needs a device
credential even then. The simplest safe way to reach it from your phone is
[Tailscale](https://tailscale.com):

```bash
tailscale serve --bg 7373
rowrow service install --public-url https://<machine>.<tailnet>.ts.net   # or: rowrow serve
```

Then open **Settings → Pair a device** and scan the code with your phone. Over HTTPS the
phone can also get push notifications (on iPhone: *Add to Home Screen* first, then turn them
on in Settings). Other options: `--host 0.0.0.0` on a trusted LAN (plain HTTP: no push
notifications), `--tls-cert/--tls-key` for HTTPS directly, or a tunnel such as
`cloudflared tunnel --url http://127.0.0.1:7373`. Anyone who can sign in can run commands on
this machine through its agents: guard your pairing links.

## The CLI

Everything the UI can do is scriptable, which is also how agents coordinate other agents
(rowrow gives each agent `ROWROW_URL` and `ROWROW_TOKEN`):

```bash
rowrow agents                                      # attention-sorted
rowrow agent new ~/code/app "Fix the flaky test" --runtime codex --wait
rowrow agent send <agent> "also update the changelog" --wait
rowrow agent view <agent>                          # the transcript, as the UI shows it
rowrow ws log ~/code/app                           # the branch's commits; ws show … <sha>
rowrow ws search ~/code/app "TODO"                 # file names and lines, .gitignore honored
rowrow ws pr ~/code/app                            # the branch's pull request: checks, review
rowrow logs --since 30m --level warn
rowrow help
```

`<agent>` is an id, an id prefix, or part of its title. `rowrow call <procedure>` calls any
procedure of the API, and `/api/openapi.json` describes them all.

## How it works

A server per machine (Node 24) owns the agents through oar and keeps each agent's
append-only log in SQLite. Status, attention and transcripts are pure folds over that log,
shared by the server, the web app and the CLI. Browsers hold one WebSocket (oRPC) for live
state; the CLI and agents use the same procedures over HTTP. The web app is React with
Tailwind and [shadcn/ui](https://ui.shadcn.com) components, dark first.

- [PRINCIPLES.md](PRINCIPLES.md): the rules that settle arguments
- [docs/architecture.md](docs/architecture.md): the system design
- [docs/decisions.md](docs/decisions.md): every decision, its reasons, and when to revisit it
- [docs/roadmap.md](docs/roadmap.md): what's next, and how rowrow compares with
  [roamgate](https://github.com/powerfooI/roamgate)

## Working on rowrow

Read [AGENTS.md](AGENTS.md) (for people and coding agents alike). You also need pnpm:

```bash
git clone https://github.com/xxchan/rowrow && cd rowrow
pnpm install
pnpm dev                       # a dev server with a scripted demo agent (no tokens), hot reload
pnpm check                     # typecheck, lint, format, unit and integration tests
```

`node scripts/demo.ts --profile dev` fills the dev server with agents in every state, and
`pnpm rowrow …` is the CLI of the checkout.

## Status

Early and moving fast: no compatibility promises before 1.0. Agents run without approval
prompts for now (oar's default), so give them repositories you'd give a colleague, ideally in
worktrees. Answering an agent's permission requests from your phone comes next.

Apache-2.0
