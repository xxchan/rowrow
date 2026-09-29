# Roadmap

What's next, in order. The feature-by-feature comparison with roamgate (every existing
roamgate feature, the need behind it, and rowrow's status) is in
[roamgate-parity.md](roamgate-parity.md). The short version: rowrow's core loop already
matches or beats roamgate; the gaps are below. Moving fast: reorder freely, and update this
file when something lands.

## In flight

- **New web UI** (D-017). Astryx is out: Tailwind + components we own (shadcn/ui on Radix),
  with a dense, dark-first look in the spirit of roamgate. Accessible names stay, so the e2e
  suite checks the port. The new composer must let Return insert a newline on phones
  (the current one likely swallows it; parity finding 1).
- **Workspace inspector** (roamgate #227 search, #228 PR/MR status, #229 commit history, file
  tree, previews, file actions): server side first, then UI on the new stack.
- **Approvals from the phone**: answer an agent's permission request or question (oar
  approvals), with per-agent plan/permission mode.

## Next, in build order

1. **Model/effort switcher on the agent page.** `agents.update {model, effort}` exists; only
   the control is missing.
2. **"Next agent that needs you" on phones**, a needs-you count on the menu, and the app icon
   badge (`navigator.setAppBadge`). ⌘J is keyboard-only today.
3. **Quick replies**: chips above the phone composer that fill the draft (never send), stored
   in a new server-side `settings` group so every device has them.
4. **Command/skill picker** (roamgate #226): `runtimes.commands` from oar, a `/` trigger in the
   composer; fills the draft, never sends; IME-safe.
5. **Revert a file to the start of the agent's last turn**, from the turn snapshots, refusing
   if the file changed since the turn ended.
6. **Run a command in a workspace** (`commands.run`): tests, `git status`, restarting a dev
   server, without tokens or a terminal. Streamed output, exit code, Stop, "send output to
   agent".
7. **Transcript search** on the server (the iPhone home-screen app has no find-in-page).
8. **File paths open in the inspector**, from tool calls, inline code and diffs.
9. **Notification preferences and per-agent mute.**
10. **"rowrow was updated: Reload" banner**, then npm packaging with `rowrow update`.

## Later (P2)

Diff readability (highlighting, search, side by side, image diffs); workspace management in
the UI (rename, archive, pin, forget, discover worktrees, review hooks before running them,
update from origin); transcript filters, turn durations, copy a whole reply, session
download; theme and text-size overrides; more keyboard shortcuts and a recent-agents
switcher; Mermaid, PDF and HTML previews; open a session started outside rowrow; a Machines
switcher for several servers; a Kanban-style backlog of tasks that become agents
(roamgate #174); Windows.
