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

## In flight

- **Approvals from the phone**: answer an agent's permission request or question (oar
  approvals), with per-agent plan/permission mode.
- **npm package** (D-018): built, tested in CI, and published by GitHub Actions on a version
  tag (trusted publishing). The first publish waits on npmjs.com's trusted-publisher setup.

## Next, in build order

1. **Command/skill picker** (roamgate #226): `runtimes.commands` from oar, a `/` trigger in the
   composer; fills the draft, never sends; IME-safe.
2. **Revert a file to the start of the agent's last turn**, from the turn snapshots, refusing
   if the file changed since the turn ended.
3. **Run a command in a workspace** (`commands.run`): tests, `git status`, restarting a dev
   server, without tokens or a terminal. Streamed output, exit code, Stop, "send output to
   agent".
4. **Transcript search** on the server (the iPhone home-screen app has no find-in-page).
5. **File paths open in the inspector**, from tool calls, inline code and diffs.
6. **Notification preferences and per-agent mute.**
7. **"rowrow was updated: Reload" banner**, then `rowrow update` for npm installs.

## Later (P2)

Inspector: a browsable file tree, GitLab MRs, image and PDF previews.

Diff readability (highlighting, search, side by side, image diffs); workspace management in
the UI (rename, archive, pin, forget, discover worktrees, review hooks before running them,
update from origin); transcript filters, turn durations, copy a whole reply, session
download; theme and text-size overrides; more keyboard shortcuts and a recent-agents
switcher; Mermaid, PDF and HTML previews; open a session started outside rowrow; a Machines
switcher for several servers; a Kanban-style backlog of tasks that become agents
(roamgate #174); Windows.
