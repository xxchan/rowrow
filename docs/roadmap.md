# Roadmap

What's next, in order. The feature-by-feature comparison with roamgate (every existing
roamgate feature, the need behind it, and rowrow's status) is in
[roamgate-parity.md](roamgate-parity.md). The short version: rowrow's core loop already
matches or beats roamgate; the gaps are below. Moving fast: reorder freely, and update this
file when something lands.

## Done recently

- **New web UI** (D-017): Tailwind and components we own, dense and dark-first; Return on a
  phone inserts a newline; the menu button counts the agents that need you.
- **Workspace inspector**: search (#227), PR status (#228, GitHub), history (#229), file
  previews, and stage/unstage/discard/delete on uncommitted files.
- **Downloads** (#312, D-042): a file, or a folder as .tar.gz, from a tree row's menu or the
  preview; straight to disk on a desktop, the share sheet on an iPhone; `rowrow ws download`.
  **A file as of a commit** (#304): Preview on each file of a commit in History.
- **Comments on what the agent wrote** (#182), and **`rowrow service`** (D-016).
- **Model and effort switcher**, **one tap to the next agent that needs you** (and the Home
  Screen badge), and **quick replies** kept on the server for every device.
- **The / command picker** (#226): the runtime's own skills and commands, read by oar in the
  workspace; and **agent icons** (each runtime's mark, with its state on the corner).

- **Keyboard shortcuts sheet**: `?` anywhere, or the keyboard button beside Settings.
- **Right-click menus** (long press on touch): an agent's actions on its rows in the nav and
  on Home (the same list as its ⋯ menu), a workspace's (new agent here, copy path), and a
  changed file's (copy path, stage, discard).
- **Small things from roamgate 0.8** (#347, #353, #354, #368): double-click an agent's title
  to rename it; a title suffix per server ("rowrow · Work") for its tabs and installed app;
  per-device preferences (theme, Changes scope, inspector width) follow across open tabs; on a
  phone the header folds away while you type.
- **Mermaid diagrams** (#26, #159, #346, #350) in replies, Markdown previews and `.mmd` files:
  zoom, Fit, 100%, fullscreen (Escape leaves it), in the app's colors, loaded with the first
  diagram and sanitized so a diagram can't load anything.

- **rowrow on npm** (D-018): 0.1.0, published by GitHub Actions from a version tag with
  trusted publishing and provenance; `npx rowrow serve` to try it.

- **"A newer rowrow is out" banner** (D-025): the server asks npm twice a day and every
  client shows the command that updates this install; off in Settings.

- **The iOS app** (D-026, D-027, D-028, [ios.md](ios.md)): a native SwiftUI app built for the
  phone's loop (be told, triage, read one answer, reply, next), notifications with Reply and
  Mark as Seen through APNs, sealed so Apple reads nothing, and the server's own folds in
  JavaScriptCore.

- **rowrow for Mac** (D-030 to D-033, [desktop.md](desktop.md)): an Electron window onto each
  server's own web app, and the manager of the servers it runs, on this Mac (launchd) or over
  SSH (a bundle put on the host, systemd, a tunnel), through the same `rowrow service`
  commands as the CLI. Updates itself from GitHub Releases; servers follow once no agent is
  mid-turn. Notifications with Reply and Mark as Seen (`notify.watch`). Signed with
  Botiverse's Developer ID and notarized since 0.3.0.

- **Agents can notify you themselves** (D-043): `rowrow notify "<title>" ["<body>"]` from
  inside an agent reaches every device and the transcript, once per `--key` a day, for
  watchers that should stay quiet until what they watch happens (roamgate's "Let Ranger
  decide").
- **Pinned agents** (#295, D-046): Pin agent in an agent's menu puts it first in the side nav,
  on Home, in its workspace and in ⌘K, on every device; a pin on its row unpins it, and a
  pinned agent can't be archived. `rowrow agent pin|unpin`.
- **Coach, phase 1** (D-044): an assistant that reads your crew of agents (status,
  conversations, changes, background output) in the workspaces you allow, on your own claude or
  pi with its tools turned off and rowrow's read-only tools instead; a window floating, pinned
  or maximized beside every page (⌘⌥⇧A), full screen on a phone. roamgate's Ranger, rebuilt.
- **Coach, phase 2** (D-045): Coach proposes creating a worktree, starting an agent or sending
  one a message, on a card with the target, every parameter and the exact text; you confirm, and
  it reads rowrow's receipt (succeeded, failed, uncertain) with your next message. Full access,
  only through a dialog and marked in Coach's header, lets it act on every workspace without
  asking.

## Parked

- **Permission prompts from the phone** (D-022): agents run with prompts off, by design.
  oar's side is ready (botiverse/oar#26, on hold) if that changes.

## Next, in build order

1. **Revert a file to the start of the agent's last turn**, from the turn snapshots, refusing
   if the file changed since the turn ended.
2. **Run a command in a workspace** (`commands.run`): tests, `git status`, restarting a dev
   server, without tokens or a terminal. Streamed output, exit code, Stop, "send output to
   agent".
3. **Transcript search** on the server (the iPhone home-screen app has no find-in-page).
4. **File paths open in the inspector**, from tool calls, inline code and diffs.
5. **Notification preferences and per-agent mute.**
6. **"rowrow was updated: Reload" banner**, then `rowrow update` for npm installs (the app
   already says when a newer version is out, D-025).

## Coach, next (D-044)

1. Scheduled checks: a prompt Coach runs on a schedule, and a notification only when what you
   asked about happens.
2. Coach in the iOS app.
3. Only rowrow's MCP server on claude (docs/upstream.md).

## The Mac app, next

1. See "Restart to Update" and the install when the Mac is idle work on a real Mac. So far
   only the install on quit has been seen: a signed build updating itself to 0.3.0.
2. A G2 Developer ID certificate from Botiverse's Account Holder before 2027-02-01, when the
   current one expires.
3. SSH hosts that ask for a password or a 2FA code (an askpass through the app).
4. Reaching this Mac's server from the phone in a click: `tailscale serve` and the public
   URL, set up from the app.
5. A notification for what finished while the app was closed (today: the badge counts it).

## The iOS app, next

1. Verify the notification service extension on a device with a real APNs key.
2. App Intents: "start a rowrow agent" from Siri, Shortcuts and the Action button.
3. An inbox across every paired server; a split view on iPad.
4. Widgets and Live Activities, content-free (PRINCIPLES.md, product 7): counts, not names.

## Later (P2)

Inspector: GitLab MRs, image and PDF previews.

Diff readability (highlighting, search, side by side, image diffs); workspace management in
the UI (rename, archive, pin, forget, discover worktrees, review hooks before running them,
update from origin); transcript filters, turn durations, copy a whole reply, session
download; theme and text-size overrides; more keyboard shortcuts and a recent-agents
switcher; PDF and HTML previews; open a session started outside rowrow; a Machines
switcher for several servers; a Kanban-style backlog of tasks that become agents
(roamgate #174); Windows.
