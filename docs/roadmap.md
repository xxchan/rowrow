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
- **Comments on what the agent wrote** (#182), and **`rowrow service`** (D-016).
- **Model and effort switcher**, **one tap to the next agent that needs you** (and the Home
  Screen badge), and **quick replies** kept on the server for every device.
- **The / command picker** (#226): the runtime's own skills and commands, read by oar in the
  workspace; and **agent icons** (each runtime's mark, with its state on the corner).

- **Keyboard shortcuts sheet**: `?` anywhere, or the keyboard button beside Settings.
- **Right-click menus** (long press on touch): an agent's actions on its rows in the nav and
  on Home (the same list as its ⋯ menu), a workspace's (new agent here, copy path), and a
  changed file's (copy path, stage, discard).

- **rowrow on npm** (D-018): 0.1.0, published by GitHub Actions from a version tag with
  trusted publishing and provenance; `npx rowrow serve` to try it.

- **"A newer rowrow is out" banner** (D-025): the server asks npm twice a day and every
  client shows the command that updates this install; off in Settings.

- **The iOS app** (D-026, D-027, D-028, [ios.md](ios.md)): a native SwiftUI app built for the
  phone's loop (be told, triage, read one answer, reply, next), notifications with Reply and
  Mark as Seen through APNs, sealed so Apple reads nothing, and the server's own folds in
  JavaScriptCore.

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

## The iOS app, next

1. Verify the notification service extension on a device with a real APNs key.
2. App Intents: "start a rowrow agent" from Siri, Shortcuts and the Action button.
3. An inbox across every paired server; a split view on iPad.
4. Widgets and Live Activities, content-free (PRINCIPLES.md, product 7): counts, not names.

## Later (P2)

Inspector: a browsable file tree, GitLab MRs, image and PDF previews.

Diff readability (highlighting, search, side by side, image diffs); workspace management in
the UI (rename, archive, pin, forget, discover worktrees, review hooks before running them,
update from origin); transcript filters, turn durations, copy a whole reply, session
download; theme and text-size overrides; more keyboard shortcuts and a recent-agents
switcher; Mermaid, PDF and HTML previews; open a session started outside rowrow; a Machines
switcher for several servers; a Kanban-style backlog of tasks that become agents
(roamgate #174); Windows.
