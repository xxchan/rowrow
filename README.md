<p align="center"><img src="src/web/public/icon-192.png" width="72" alt=""></p>

<h1 align="center">rowrow</h1>

<p align="center">
  Run Claude Code, Codex, Grok, Kimi and Pi side by side on your machine, and steer them
  from any browser, including your phone.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rowrow"><img src="https://img.shields.io/npm/v/rowrow" alt="npm"></a>
  <a href="https://github.com/xxchan/rowrow/actions/workflows/ci.yml"><img src="https://github.com/xxchan/rowrow/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

## Quick start

Needs Node.js 24+, git, and an agent CLI you're signed in to (`claude`, `codex`, `grok`,
`kimi` or `pi`).

```bash
npx rowrow@latest serve        # http://127.0.0.1:7373; open the sign-in link it prints
```

To keep it running, install it as a service (launchd or systemd; same flags as `serve`):

```bash
npm install -g rowrow
rowrow service install         # again after switching Node versions
```

## What it is

[herdr](https://herdr.dev)-style workspaces (a long-lived server owns your agents, and
every screen answers *who needs me now?*), but with a rich web UI you can install on your
phone's home screen, instead of a TUI and tmux keys.

It's local first: your phone connects straight to your machine, over your LAN or
Tailscale. There is no relay, account or cloud, so it works where remote-control apps that
go through a vendor's server are not allowed.

<p align="center">
  <img src="docs/images/agent.png" alt="An agent's conversation next to the inspector, showing what its last turn changed" width="820">
</p>
<p align="center">
  <img src="docs/images/phone-home.png" alt="Agents sorted by who needs you, on a phone" width="240">
  &nbsp;
  <img src="docs/images/phone-agent.png" alt="An agent's conversation on a phone" width="240">
</p>

## On your phone

With [Tailscale](https://tailscale.com):

```bash
tailscale serve --bg 7373
rowrow service install --public-url https://<machine>.<tailnet>.ts.net
```

Then scan the code in **Settings → Pair a device**. On iPhone, *Add to Home Screen* for
push notifications. On a trusted LAN, `--host 0.0.0.0` also works (plain HTTP, no push).

Every request needs a device credential, and anyone signed in can run commands on this
machine: guard your pairing links.

## CLI

Everything the UI does, so agents can drive agents too. `rowrow help` for the rest.

```bash
rowrow agents                                      # who needs you first
rowrow agent new ~/code/app "Fix the flaky test" --runtime codex --wait
rowrow agent send <agent> "also update the changelog" --wait
```

## Status

Early: no compatibility promises before 1.0. Agents run with permission prompts off
([D-022](docs/decisions.md)), so give them repositories you'd give a colleague, ideally in
worktrees.

## More

- [PRINCIPLES.md](PRINCIPLES.md), [architecture](docs/architecture.md),
  [decisions](docs/decisions.md), [roadmap](docs/roadmap.md)
- Contributing: read [AGENTS.md](AGENTS.md), then `pnpm install && pnpm dev`, and
  `pnpm check` before a commit.

Apache-2.0
