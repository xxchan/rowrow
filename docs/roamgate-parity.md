# roamgate → rowrow feature parity

> Compared on 2026-09-29, before the web app moved off Astryx (D-017). The ordered plan built
> from this is [roadmap.md](roadmap.md).

**What was compared (2026-09-29)**

- **roamgate** `main` @ 6d83557 (#289, just after v0.7.11). Sources: README, FEATURES.md, docs/ARCHITECTURE, DEPLOYMENT, HISTORY and TUTORIAL, SECURITY.md, the source (`server/src`, `web/src`), 62 issues, 229 PRs, and release notes v0.7.7–v0.7.11.
- **rowrow** `main` @ dd5fd8b. Two commits landed while this was being written, and both are counted as **have**:
  - 8d1d5ac: comment on selected transcript passages (roamgate #182).
  - dd5fd8b: `rowrow service` (D-016).
- Paths are relative to each repository.

**Legend**

- **Status:** have / partial / in progress / missing / deliberately different.
- **Priority:**
  - P0: needed for everyday use.
  - P1: clearly useful.
  - P2: nice to have.
  - "—": nothing to build.
- **Last column:** for have rows, it shows where rowrow implements the feature. For partial and missing rows, it holds the design sketch.
- **Work in flight, assumed to land first:**
  - The Workspace Inspector (#227, #228, #229, and file actions).
  - Approvals from the phone (since parked: agents run with prompts off by design, D-022).

**Summary**

- **The core loop already matches roamgate or does better.** This covers attention status and ordering, push notifications, per-agent last-turn diffs, review comments compiled into the composer, worktrees with hooks, attachments, auth, the CLI, and `rowrow service`.
- **Files are the one large missing area.** That is the in-flight inspector.
- **Terminal features come down to five real needs:**
  1. Run a quick command.
  2. Send common replies with one tap.
  3. Find and invoke slash commands and skills.
  4. Copy text and follow links.
  5. Get to the next agent that needs you quickly.
- **Everything else terminal-specific is moot** once there is no PTY (D-001).

---

## 1. Sessions & agents

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Agent status (working / blocked / done / idle), pushed per pane (FEATURES "Agent Awareness"; #20) | Know which agent needs me without checking each one | have | Better than roamgate. Status comes from the runtime via oar, plus the live phase ("Thinking", "Running a command"), "Silent for …" stalls, and Failed (`src/shared/summary.ts`, `src/web/lib/format.ts`) | — |
| Attention-first ordering; idle agents ordered by session-file recency (#137, #161) | See the most urgent first | have | Home groups agents as Needs you / Working / Idle. The side nav has a "Needs you" section. Order is by attention, then last activity (`HomePage.tsx`, `Shell.tsx`) | — |
| Answer the agent's permission dialog or question in its TUI (blocked status + key grid) | Approve, deny or answer from the phone | deliberately different | Agents run with prompts off, by design (D-022): an agent that needs a decision asks in its reply and ends its turn, and you answer in the composer. oar's side exists (botiverse/oar#26, on hold) if that changes | — |
| Agent list layouts: Nested, Separate, Compact. Sort by attention, workspace or manual; grouping; drag to reorder (`web/src/agentOrder.ts`, `workspaceAgentLayout.ts`; #137, #185) | Organize 10+ agents my way | partial | The layout is fixed: Home by attention, side nav by workspace. Pinned agents (roamgate's tab pins, #295, D-046) lead every list, in pin order, synced on the server. Add a sort/group picker on Home (attention, workspace, recent), saved per device. Skip manual order, which fights attention-first | P2 |
| Double-click a tab to rename it, or use its context menu (#354) | Name an agent without hunting for a menu | have | Double-click the agent's title in its header, or its row in the side nav (the first click still opens it), for the same Rename dialog as the menu's Rename…, with the title selected (`Shell.tsx`, `AgentActions.tsx`). Leaving it empty names the agent after its first message again | — |
| Switch model mid-session through the agent's own TUI (e.g. `/model`, codex's `/fast`) | Move to a stronger, cheaper or faster model mid-task | have | `agents.update {model, effort, serviceTier}` restarts the run with the conversation resumed, and the transcript notes "Switched model" or "Switched Fast mode on". "Model and effort…" in the agent menu and in the session details by the composer, fed by `runtimes.models`, with a Fast switch when the model has a Fast tier (D-049) | — |
| Session inspection for Codex, Claude, Kimi, Grok Build, Pi, Muse Code and Antigravity (`server/src/agent/*-session.ts`; #173, #187, #231, #233) | Use whichever agent CLI I like | partial | Claude Code, Codex, Cursor, Antigravity, Grok, Kimi and Pi are supported through oar (`src/server/agents/runtimes.ts`). Add Muse in oar, not in rowrow (PRINCIPLES eng. 6); `runtimes.list` then picks it up | P2 |
| Inspect any agent in any pane, including ones started by hand (`server/src/agent/session-resolver.ts`) | Pick up a session I started in a terminal | missing | rowrow only knows agents it created. Add `agents.create {resume: sessionId}`, plus "recent sessions in this folder" if oar can list them; the first run resumes the session | P2 |
| Herdr agent integrations: install, update, uninstall (Configuration > Integrations; #222) | Make status reporting work | deliberately different | Nothing to install: oar reads each runtime's protocol. The adjacent need, knowing the CLI is installed and signed in, is in section 9 | — |

## 2. Composer & input

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Mobile composer with IME, dictation, multiline and images; Insert vs Send; in-memory drafts (`TerminalComposer.tsx`; #70, #72, #73) | Type reliably on a phone | have | One IME-safe composer. Drafts are kept in memory per agent (`Composer.tsx`, `lib/store.ts`). See finding 1 about Enter on touch | — |
| One typing entry point on mobile (#286 open; the maintainer chose composer-only) | Know which input I'm typing into | have | rowrow only has the composer | — |
| Paste an image; it's uploaded to the host and a shell-safe path is inserted (#280, #281) | Hand the agent a screenshot | have | Better: any file by paste, drop or picker, shown as tiles until sent; images reach the model as images (D-024). Names are sanitized; files are 0600, up to 25 MB, kept 7 days (`src/server/api/uploads.ts`, `files.upload`) | — |
| Drop desktop files on a terminal pane to upload them and insert their paths (#277 open) | Hand over any file quickly | have | Drop onto the composer | — |
| Steering and queueing: Ctrl+Enter forwarded for Claude Code's "send queued now" (#253, #261) | Talk to a busy agent without wrecking its turn | have | Send steers or queues through oar. There is a Queue button, Stop, and an idempotent `inputId` (`agents.send`). Interrupt-and-send is CLI-only (`--interrupt`) | — |
| Customizable 2×8 mobile shortcut grid and side buttons (#4, #77) | One tap for things I send often | missing (as text) | Keys are moot (section 12). The text version is **quick replies**: chips above the phone composer ("continue", "run the tests", "commit and open a PR") that fill the draft and never send. Store them in a new server-side `settings` contract group so every device gets them | P1 |
| Agent-aware command picker: a Commands button plus leading-`/` completion; fills the draft, never sends (#226 open) | Find and run slash commands and skills without memorizing them | missing | oar lists commands and skills per runtime and cwd (0.8 already has a `skills` inventory). Add `runtimes.commands {runtime, workspaceId}`, and a `/` trigger in the composer. List only commands the runtime accepts over its programmatic interface | P1 |
| Drag a file-explorer row into the terminal or composer to insert its path (#270, #271) | Point the agent at an exact file | missing | Needs the inspector. Add an `@` trigger backed by its file search, and "Mention in message" on a file | P2 |

## 3. Transcript & history

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Agent History: user, agent and tool entries; tool payloads on demand; windowed; incremental (docs/HISTORY.md; #95, #102) | Read what the agent did | have | Richer: a live fold of the log with reasoning, tool calls (command, edit, output), sub-agents, steer/queue marks and run boundaries. Loads 4-turn windows with "load older", and resumes from a cursor (`Transcript.tsx`, `lib/store.ts`) | — |
| Search across loaded text (docs/HISTORY.md "Message filters") | Find where it said or did X. The iOS home-screen app has no find-in-page | missing | Add `agents.search {agentId, text}` over the agent's entries in SQLite (text, tool input and output), returning seqs and snippets. The client loads the window around a hit and scrolls to it | P1 |
| User / Agent / Tool filters with counts (#95) | Skim only the answers, or only the commands | missing | A client-side filter over the timeline fold, saved per device | P2 |
| Minimap / wavebar (#55, #105; reused for Ranger's chat, #354) | Find my way around a long session | have | A wave bar at the right edge of an agent's transcript, as in Coach (`ConversationWave.tsx`): a mark per message (longer for yours, accent for the ones on screen), hover to preview one, click or ↑ ↓ Home End to jump. Desktop only: a phone keeps the width for the transcript | — |
| Copy a card; open the full message in a dialog (docs/HISTORY.md; `AgentMessageDialog.tsx`) | Copy an answer or a plan | partial | Code fences and tool details already have copy buttons. Add "Copy as Markdown" for a whole reply | P2 |
| Timestamps on entries, `MM-DD HH:mm` (docs/HISTORY.md) | See when a turn finished and how long it took | partial | Your messages show a time; agent turns show neither end time nor duration. Add a turn footer computed from the entries' `at` | P2 |
| Session Inspector: turns, tokens, last update, session file; timeline; raw/ATIF view and export (`AgentSessionPreviewDialog.tsx`, `server/src/agent/session-trajectory.ts`) | Audit or share a session | partial | The composer shows model, effort and context fullness; tapping it shows runtime, context tokens of the window, token totals, session id and the process. The CLI has `agent view` and `agent entries --full`. Add runs and turns, and "Download": Markdown via `renderText`, JSONL via `agents.entries {full}` | P2 |
| Select terminal text → "Add comment" → review feedback (#182, #190) | Answer one specific passage | have | Select agent text → Comment → it joins the review drawer above the composer (`SelectionComment.tsx`, `ReviewDrawer.tsx`; 8d1d5ac) | — |
| Cmd/Ctrl-click or long-press file paths and URLs in output (#208, #272) | Open what the agent points at | partial | Markdown links work. Make tool-call targets (oar `classifyTool` detail) and inline-code paths open the inspector preview, or that file's Last-turn diff | P1 |

## 4. Files & preview (Workspace Inspector)

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Inspector with Files / Changes / History: docked, resizable, drill-down on phones, state kept per checkout (`WorkspaceInspectorHost.tsx`; #30, #186) | Look at the project without leaving the agent | in progress | Changes already docks beside the transcript (resizable) or opens in a phone bottom sheet (`AgentPage.tsx`). Files is the in-flight inspector | P0 |
| File tree: hidden-file toggle, glob filter on loaded names, git badges, ignored files dimmed (`FileExplorerDialog.tsx`; #162, #66) | Find and open files | done | Files shows the checkout as a tree (`@pierre/trees`, D-034) from `files.list`, colored by git status; a file opens the preview. Ignored files aren't listed, and search is the filter | P0 |
| Project-wide name and content search (#227 open) | Find a file or string anywhere | in progress | A bounded, ignore-aware `git grep`; results open at the matching line | P1 |
| Text preview with highlighting, line numbers, search, refresh, close (`CodePreview.tsx`; #163, #291) | Read a file on the phone | in progress | Highlighted code view with line numbers and copy (shiki) | P0 |
| File preview tabs: a single click opens a temporary tab the next click reuses, a double-click or Enter keeps it; restored per checkout; closed with the file (#309) | Keep a few files open while reading | have | `FileTabs.tsx`, `lib/file-tabs.ts`: tabs above the preview, the temporary one in italics; double-click a tree row, a search result or the tab (or Enter on it) to keep it; ←/→, Home, End move, Delete or middle-click closes, and the next tab shows. A name two open files share shows its folder. Kept per workspace on this device, and the tabs of files the tree no longer lists are dropped. At 640 px of inspector or more the tree and the preview sit side by side, as roamgate splits; narrower (the default beside an agent, and phones) the preview covers the tree with Back, the tabs scrolling sideways, 44 px tall on touch | — |
| Markdown Preview/Source; relative links and local images resolve (#64, #136) | Read the plans and docs agents write | in progress | The transcript's Markdown renderer; resolve links inside the workspace | P0 |
| Images, including SVG, with zoom/Fit (`ZoomablePreview.tsx`; #159) | See screenshots and assets agents produce | in progress | Serve SVG with a sandbox CSP, as roamgate does. The zoom/Fit/fullscreen frame exists (`ZoomablePreview.tsx`, Mermaid's) | P1 |
| Mermaid diagrams (#26, #159, #346, #350) | Read diagrams in docs and in agent replies | have | `mermaid` fences in the transcript and in Markdown previews, and `.mmd`/`.mermaid` files (Diagram/Source), drawn by Mermaid, loaded with the first diagram (`MermaidDiagram.tsx`, `lib/mermaid.ts`). roamgate's frame (`ZoomablePreview.tsx`): − / zoom level / + / Fit / 100% / fullscreen, scroll to pan, Ctrl/⌘ + wheel to zoom; inline it fits the width and grows to the diagram's height, a file fills the pane, fullscreen fits it all and Escape returns focus to where it was. Its messages: Rendering diagram, Empty diagram, Mermaid render failed (with the source). In the app's colors, light or dark; `securityLevel: "strict"`, then DOMPurify again with nothing that loads (links off the page, pictures, CSS `url()`), and a diagram can't restyle itself. Mermaid rather than roamgate's beautiful-mermaid, for every diagram type (pie, gantt, git…) | — |
| PDF (#64) and audio (#289) previews | Check generated reports and media | missing | Browser-native viewers over a download URL that supports byte ranges | P2 |
| Sandboxed HTML preview with workspace CSS, images and fonts (#238, #242) | Look at a static page an agent built | missing | A separate response with an enforcing CSP; scripts blocked; resources inlined | P2 |
| Download a file, or a folder as .tar.gz (`server/src/workspace/file-download.ts`); straight to disk on desktop, the share sheet on iOS (#35, #60, #312) | Get an artifact onto my device | have (web, CLI) | `files.download` (a GET with the cookie, D-042): any file byte for byte, a folder as `<name>.tar.gz` of what the tree shows (.gitignore honored), 256 MiB cap with a message (`src/server/git/download.ts`). A tree row's menu (right-click, long press, or its ⋯) has Download file / Download directory and Copy path; the preview has Download, also under "no preview" for binaries. The desktop layout saves with the file's name; on a phone iOS shares, a home-screen app or iOS without file sharing opens a tab, Android downloads (`lib/download-strategy.ts`); refusals are a toast. `rowrow ws download`. The iOS app has no download yet (a `ShareLink` over the same GET) | P1 |
| Upload by dropping onto a folder; copy path; delete with confirmation (FEATURES "File Explorer") | Put a fixture in the repo; tidy up | in progress | Part of the file actions. Delete should re-check that the file hasn't changed | P2 |
| Read-only browsing outside the checkout (#162) | Check logs or configs elsewhere on the machine | partial | `workspaces.browse` lists folders only, for adding a workspace. Add a read-only file mode to the inspector | P2 |
| Reveal in Finder / open folder on the host, opt-in (#282, #283) | At the desk, jump from the browser to the file | missing | Prefer "Open in editor" links such as `vscode://file/<abs>`. They act on the viewer's machine, so the server never opens anything | P2 |
| Directory preview → New workspace (#172) | Start work in a subfolder | missing | "Add as workspace" and "New agent here" in folder view, via `workspaces.add` | P2 |

## 5. Git: changes & review

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Diff scopes: Working tree / Against main / Last step (#37, #56) | See what changed, and what the last turn changed | have | Better: Last turn is per agent, between snapshots taken at its start and end (D-015). Snapshots live in a private object dir, never the repo's (cf. roamgate #262). Also Uncommitted and Branch scopes (`ChangesView.tsx`, `src/server/git/changes.ts`) | — |
| Status badges and +/- counts; large diffs start collapsed (#28, #48); continuous review loaded near the viewport, a file index, generated files collapsed (#340) | Scan the change set, then read it top to bottom | have | A/M/D/R/U/!/T badges with counts. Changes is one scroll of every file's diff under sticky headers: diffs within 1000 px of the screen load, the nearest dozen first, through one queue that runs 2 at a time and adapts between 1 and 8, into a cache that outlives the view (`lib/diff-loading.ts`); content loading above the screen doesn't move what you read. "File" (Jump to changed file) scrolls to a file, opens it, and shows the file at the top. Generated files (`.gitattributes` linguist/gitlab-generated, or lockfiles) and diffs of 1,000+ lines start collapsed ("Generated file; diff skipped." / "1,200 changed lines; diff skipped." with View diff), and so does a loaded patch of 128 KB or more, or one cut at 512 KB. roamgate's 256 KiB file-size rule isn't copied: the line count and the patch's size catch the same diffs. History's commits keep a per-file list | — |
| Side-by-side on desktop, unified on mobile (#50) | Read big edits on a wide screen | partial | Unified only (`DiffView.tsx`). Add a split view for wide panels, built from the same parsed hunks | P2 |
| Syntax highlighting and search in diffs (FEATURES "Diff Viewer"; `diffSyntaxHighlighting.ts`) | Read and search diffs, on the phone too | partial | Highlighted with word-level emphasis by `@pierre/diffs` (D-034). Add a search box that filters files and highlights hits | P2 |
| Image diff previews (FEATURES "Diff Viewer") | See changed images | missing | `git.blob {scope, side, path}` to show before and after | P2 |
| Per-file and bulk actions: stage, unstage, mark resolved, discard unstaged, delete untracked; stale menus rejected (#71, #79; `server/src/workspace/git-actions.ts`) | Undo an unwanted change without asking the agent | missing | **Start with Revert.** In Last turn, restore a file to the turn's start snapshot, and refuse if it no longer matches the end snapshot. In Uncommitted, discard or delete with the same re-check. Confirm each action (PRINCIPLES product 4). Staging can come later | P1 |
| Jump from a diff to the file preview (FEATURES "Diff Viewer") | See the change in context | missing | Needs the inspector: "Open file" on each file row | P1 |
| Comment on diff line numbers, including dragged ranges (#38, #80) | Give precise review feedback | partial | Single lines only. Add shift-click or long-press to extend a comment over a range; store start, end and the quoted lines | P2 |
| Comment on source gutters and rendered Markdown selections (#97) | Review files and docs, not just diffs | missing | Needs the inspector. Use the same store with `{kind: "file", path, lines, text}` | P2 |
| Compile feedback; copy it or pre-fill a chosen agent (never submitted); delivered comments removed; drafts survive (#38, #80, #190) | Send one clear review message | have | "Add to message" fills the composer. Copy works. Comments persist per workspace in localStorage (`lib/annotations.ts`, `ReviewDrawer.tsx`). A path is a code span that shows it verbatim, backticks and all (#342, `codeSpan` in `shared/feedback.ts`) | — |
| Edit and reorder comments; refresh re-anchors and marks stale anchors (`web/src/annotations.ts`) | Tidy feedback before sending | partial | Comments can only be removed; `updateAnnotation` exists but nothing calls it. Quotes are captured, so the feedback stays readable. Add inline editing, and a "stale" mark when the quoted line is gone | P2 |
| Commit history and commit diffs (#229), with a file's preview as of a commit (#304) | See what was committed | have | `git.log/commit/commitDiff` in `HistoryTab.tsx`, `rowrow ws log/show`, iOS `HistoryView.swift`. Each file of a commit has Preview (and "Preview at this commit" in its menu): `files.read {rev}` in the file preview, marked `@ <hash>` with a read-only note; a deleted file shows as of the commit's base and says so; Back to diff returns with that diff open. `rowrow ws read --rev`. iOS doesn't preview at a commit yet | P1 |
| PR/MR status card with checks and reviews (#228 open) | Know whether CI is green and it's been reviewed | in progress | Part of the inspector; uses `gh`/`glab` on the host | P1 |

## 6. Worktrees & workspaces

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Create a worktree from origin's freshly fetched default branch (never assumed to be `main`), leaving the source's dirty files alone (`server/src/worktree/create.ts`; #245, #249) | Parallel work that doesn't collide | have | `workspaces.createWorktree`, from the workspace page or "Work in a new worktree" in New agent. Branch names are random and memorable (`git/worktrees.ts`, `git/names.ts`) | — |
| Linked worktrees grouped under their repository (FEATURES) | See parallel work together | have | Grouped by git common dir (`workspaces/service.ts`, relink) | — |
| Hooks: setup, opened, teardown, removed; a failed teardown blocks removal (`worktree-hooks.ts`; #293 native config) | Install deps and clean up automatically | have | Reads `rowrow.json`, then `roamgate.json`, then `paseo.json`; takes one whole file; validates strictly (`git/hooks.ts`, docs/git.md). This is already what #293 asks for | — |
| Enable or disable hooks per repository; review them before acting (`WorktreeHooksDialog.tsx`; the effective config path, native or legacy, #296) | Don't run repo code I haven't seen, especially from a phone | partial | Review: the New worktree and Remove dialogs, and the new-agent form with New worktree on, show the file in effect (rowrow.json native; roamgate.json or paseo.json as legacy compatibility), its path, the commands that will run, or its error (`HookReview.tsx`, `workspaces.hooks`). Not done: turning hooks off per repository (trust stored on the server) | P2 |
| Hook diagnostics (FEATURES notices) | Know why setup failed | partial | A failure toast shows the last 300 characters; success output is dropped. Keep the last run per workspace and show it on the workspace page | P2 |
| Remove with confirmation, hooks and process cleanup, keeping residual files (`server/src/worktree/remove.ts`) | Clean up safely | partial | Already done: teardown gate, dirty check with explicit force, stops the workspace's agents, keeps the branch (`git-ops.ts`). Not done: other processes still running in the folder, such as a dev server an agent started. List them (cwd under the path) and offer to stop them | P2 |
| Discover and open existing worktrees; missing ones offer cleanup (`WorktreeOpenDialog.tsx`) | Bring in worktrees made elsewhere; clear dead ones | partial | Adding a worktree's path nests it, but nothing lists worktrees rowrow doesn't know about. Any workspace, a missing one too, can be forgotten with Remove from rowrow (D-047). Add `workspaces.worktrees {id}` (from `listWorktrees`) with Add per entry | P2 |
| Worktree list with path, open state, branch status and uncommitted counts (`WorktreeLifecycleRow.tsx`) | Compare parallel branches at a glance | partial | Each workspace page shows branch, ahead/behind and changed files; the worktree list shows only name and path. Reuse `GitSummary` in the list rows | P2 |
| Pull (`git.pull`) | Keep a long-lived branch current | missing | "Update from origin/<default>": fetch and merge. Refuse when the worktree is dirty or an agent in it is working | P2 |
| Automatic branch updates every 10 minutes, opt-in (`server/src/workspace/auto-sync.ts`) | Stay current without thinking about it | missing | Only after manual update proves useful, and only while no agent in the worktree is working | P2 |
| Create, rename, pin and close workspaces (#5) | Keep the project list tidy | have, except pins | D-047: New workspace (a + beside Workspaces in the side nav, ⌘K) with an optional name; Rename… (also a double-click), Archive…/Unarchive and a red Remove from rowrow… in the right-click and ⋯ menus and ⌘K (Remove also matches "delete/remove workspace"), a swipe on iOS, `rowrow ws rename|archive|unarchive|remove`. roamgate's Close is rowrow's Remove: rowrow forgets the workspace and its registered worktrees, never their files, and archives their agents; Archive hides one reversibly, with an Archived section at the bottom of the side nav. Agents can be pinned (D-046), workspaces can't | — |

## 7. Notifications

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Background Web Push for "needs input" and "completed" (#196, #200, #204) | Hear about it when I'm away | have | The notifier waits 1.5 s and re-checks before sending. VAPID keys per profile, `sw.js`, and Home Screen guidance for iPhone (`src/server/notify/*`, `SettingsPage.tsx`) | — |
| Workspace and tab names in payloads instead of ids (#258) | Know which agent without opening it | have | "<title> needs you / finished / failed", plus the workspace and a preview (`notifier.ts` `describe`) | — |
| Clicking opens the pane; no duplicates while a page is enrolled (`task-notifications-sw.js`) | One alert that goes straight to the agent | have | One tag per agent; a click focuses the app and opens `/a/<id>`. Nothing is sent for an agent someone is looking at, and no push goes to a device with a focused window (`presence.ts`) | — |
| Separate toggles for needs-input and completed; Background push vs Active page only (`taskNotifications.ts`) | Get only the alerts I want | partial | One on/off per device, plus Test. Store per-device preferences (blocked, done, failures only) with the subscription and have the notifier filter on them | P2 |
| Custom monitoring alerts: "Let Ranger decide" sends its own title and message only when the condition you wrote is met, deduplicated across runs and restarts; clicking opens the run (#358, 2026-10-05) | Be told when the thing an agent watches happens, and not otherwise | have (D-043) | Any agent can: `rowrow notify "<title>" ["<body>"] [--key K]` (`notify.send`) from inside it. Sent to every device even while you look at that agent, as a toast in open browsers, and shown in its transcript ("Notified you: …"); clicking opens the agent. A `--key` sends once a day; at most 1 per 10 s and 30 an hour per agent, counted from its log so both survive restarts (`notifier.ts` `send`). Coach's scheduled tasks pair it with a schedule (D-050) | — |
| Follows Herdr's own notification policy, including suppression for external agents (#267) | Less noise | deliberately different | rowrow has its own policy: never notify about what you're watching. The adjacent need is missing: mute one noisy agent. Add `agents.update {muted}`; the notifier skips muted agents, and lists show a muted icon | P2 |

## 8. Mobile & PWA

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Installable PWA, explicitly not offline (README) | App-like access on the phone | have | `manifest.webmanifest`; `sw.js` caches nothing | — |
| Resume after backgrounding: black terminals (#53), iOS reconnect loops (#219) | Open the app and it just works | have | Reconnects on `visibilitychange` and `online` with backoff, and resumes from cursors (`lib/connection.ts`, `lib/store.ts`) | — |
| Read without the keyboard popping up; long-press to select → Copy / Add comment (#192, #193, #198) | Read and quote on a phone | have | The transcript isn't an input. Selection → Comment works with touch selection handles (`SelectionComment.tsx`) | — |
| Collapse the mobile header while typing (#347) | More of the conversation above the keyboard | have | On phone widths, while the composer has focus the agent's header folds to the safe-area strip and the update banner steps aside, without animation, as roamgate does (`index.css`, `data-folds-while-typing`). rowrow has no tab bar to hide | — |
| Tabs sheet with a nav badge (#67); bottom-sheet menus and draggable drawers (#94, #224) | See at a glance that other agents need me, and switch | partial | The drawer has "Needs you" and Changes opens in a bottom sheet, but ⌘J only exists on keyboards. Add a "Next: <agent>" button in the agent header when others need you, a count on the menu button, and `navigator.setAppBadge(count)` on the Home Screen icon | P1 |
| Layout: Automatic, Mobile or Desktop; adjustable breakpoint; `?layout=` override (#138) | Tablets, landscape phones, narrow windows | missing | The breakpoint is fixed at 767 px (`lib/use-narrow.ts`, AppShell). Add a per-device override in Settings that feeds `useNarrow` | P2 |
| Reload stale tabs when chunks 404 after an update (#132); "Reload page" in the menu (#16) | Don't run an old UI against a new server | missing | Compare `host.version` in AppState with the bundle's build version. On a mismatch, show "rowrow was updated: Reload" | P2 |

## 9. Settings & appearance

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Light, dark or system theme, plus accent colors (`web/src/appearance.ts`) | Comfort | have | System, Light or Dark per device (Settings → Appearance, `lib/theme.ts`); no accents | — |
| Browser preferences sync across open tabs (#353) | Change a preference once, not in every tab | have | `lib/device-prefs.ts`: one `storage` listener re-reads the `rowrow.*` key that changed. The theme, the Changes scope, the inspector beside the conversation (open, and its width), a dismissed update banner and review comments follow at once; which inspector tab shows stays per tab, as roamgate keeps its inspector's view | — |
| Instance title suffix: "Roamgate · Work" for the page and the installed app (#368) | Tell my servers' tabs and Home Screen apps apart | have | `settings.instanceName` (Settings → Server → App and webpage title suffix; up to 32 characters, spaces collapsed, no control characters), on every device through the app state. The server names `index.html` and `/manifest.webmanifest` for signed-in browsers only; the page keeps `document.title` current. The Mac and iOS apps' server lists don't show it yet | — |
| Interface scale 80–150% (#94, #141) | Legibility on small or distant screens | missing | A per-device text size applied to the root font size | P2 |
| Keyboard shortcuts: reference and editor, presets, 3 bindings per action, JSON import/export (#139) | Keyboard speed on the desktop | partial | ⌘K, ⌘J, ⌘, and C (new agent, D-023) (`CommandMenu.tsx`), and a "?" sheet of every shortcut, also a button beside Settings (`ShortcutsDialog.tsx`). Add next/previous agent, focus composer, toggle Changes and stop turn. No editor until someone asks | P2 |
| Connection details: server, socket, version (`ConfigMenu.tsx`) | Know what I'm connected to | have | Settings → Server: machine, versions (rowrow, oar, node), address, data directory, uptime | — |
| Integration versions, Herdr status and managed Herdr setup (#191, #222) | Know whether my agent CLI is installed and working | have | Settings → Agent runtimes shows installed, version and reason, with "Check again", whether a newer version is out, with Update (D-036), and who it's signed in as, with Sign in / Sign out (D-038). Settings → Subscription usage shows each window's % left, pace and reset, and its last two days (D-040) | — |

## 10. Remote access & auth

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Binds to loopback by default; token or password off loopback; loopback bypasses login (SECURITY.md) | Safe remote control | deliberately different | Stronger: every request needs a device credential, even from loopback (D-009). One-time links and QR pairing; tokens stored hashed and revocable. The WebSocket Origin is checked, which roamgate doesn't do (`auth/devices.ts`, `api/server.ts`) | — |
| `?token=` sets an HttpOnly cookie and strips the URL (DEPLOYMENT) | Sign a phone in easily | have | `/auth/redeem?code=`: single use, valid 10 minutes | — |
| Log out this browser (#223, #232) | End a session | have | Settings → Devices: Sign out this device, or Revoke any other. roamgate can't revoke copied cookies | — |
| Native HTTPS (#197, #199) | Push and the PWA need a secure origin | have | `--tls-cert/--tls-key` | — |
| Private-access guides: Tailscale Serve, SSH forwarding, Tailcat (docs/TUTORIAL.md) | Reach it from the phone safely | have | README "On your phone": `tailscale serve` with `--public-url`, LAN, TLS, cloudflared | — |
| Multiple connections: local and SSH profiles, selected per browser (#18; `server/src/connections/*`) | Steer agents on several machines from one place | missing | One server per machine (D-002). Start with a Machines list that switches origins and shows each one's version. An aggregated "needs you" would need a hub server that holds CLI tokens for the others and proxies their `state.watch` with machine-qualified ids | P2 |
| SSH transport: files, git and hooks run on the remote host (DEPLOYMENT) | Work on a remote box | deliberately different | Run rowrow on that box and reach it over Tailscale; nothing needs forwarding | — |
| Client counts; pause other browsers (`bridge.pause_others`) | See who else is connected; stop devices contending | partial | `rowrow status` lists clients with their route and focus. There's nothing to pause, because there's no shared terminal size to fight over. Show connected clients under Settings → Devices | P2 |

## 11. CLI, service & operations

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Server flags and env: host, port, password, TLS, log level, `--open` (DEPLOYMENT) | Configure the server | have | `rowrow serve --host --port --profile --public-url --tls-cert --tls-key --idle-timeout --open` | — |
| User service: install, status, restart, reload, uninstall via systemd, launchd or a Windows task (`server/src/config/service-manager.ts`) | Survive logout, reboot and crashes | have | `rowrow service install/status/restart/uninstall` using launchd or systemd --user (`src/cli/service.ts`, D-016). No Windows | — |
| `/health` and `/healthz` | Monitoring | have | `/healthz` | — |
| Log levels and bounded logs (#82, #84) | Diagnose problems | have | Better: JSONL logs with trace ids, browser errors in the server log, `rowrow logs/errors/status/state`, and OpenAPI | — |
| Checksum-verified standalone binary, installer, in-app update check and install, `.previous` rollback (#1; `server/src/http/update.ts`) | Install and update without a toolchain | partial | `npm install -g rowrow`, published from CI with provenance (D-018: the server's JavaScript stripped from its source, not bundled); upgrade with `npm install -g rowrow`, then `service restart`. Still missing: `rowrow update`, and "update available" in Settings | P2 |
| Bounded CPU profiling (#292) | Diagnose slowness | missing | `rowrow serve --cpu-profile <seconds>`, using Node's `--cpu-prof`, writing into `<profile>/profiles/`. (`--profile` already means the data profile) | P2 |
| Native Windows, x64 and ARM64 (#41, #42, #44) | Windows users | missing | D-016 says Windows isn't supported, and hooks use `sh -c`. Record "not before 1.0" as a decision | P2 |
| Herdr plugin: install, start/url/status/restart actions, panel (#90, #91, #252) | Run inside an existing tool | deliberately different | rowrow isn't a Herdr client. Its extension point is the contract: the CLI and OpenAPI, plus `ROWROW_URL`/`ROWROW_TOKEN` for agents | — |
| Website and hands-on tutorial (`site/`, docs/TUTORIAL.md; #83, #96) | Learn the workflow; set up phone access safely | partial | README quick start; `pnpm dev` with the `scripts/demo.ts` demo. Add a phone-setup checklist in Settings that reads live state: exposed, HTTPS, paired, push on | P2 |

## 12. Terminal & panes: the needs behind them

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Full browser terminal (FEATURES "Full Browser Terminal"; `server/src/bridge/*`) | (a) Run a quick command without spending tokens: tests, `git status`, restarting a server. (b) Watch a long-running process. (c) Fix something by hand | deliberately different; (a) and (b) missing | There's no PTY (D-001). Add `commands.run {workspaceId, command}`: a non-interactive `sh -c` in the workspace with streamed, bounded output, an exit code and Stop. Keep recent runs per workspace in their own log, not an agent's. "Send output to agent" fills the composer. (c) stays with ssh | P1 |
| Dev servers running in panes (implicit: `pnpm dev` in a split) | See the app being built, from the phone too | missing | Mark a run as long-lived, detect the port it listens on, and link `http://<server host>:<port>`, which works over Tailscale. No proxy at first | P2 |
| Mobile key grid: Esc, Ctrl, arrows, Tab, Shift+Tab (#4, #77) | Interrupt, answer menus, switch plan/auto modes, recall history | deliberately different | Covered by Stop, steer/queue and ↑ history (`hasHistory`). Permission prompts are off by design (D-022). Frequent text goes to quick replies (section 2) | — |
| Selection and copy; OSC 52 clipboard relay (#108, #109, #118) | Copy output | deliberately different | The transcript is plain DOM text. The missing whole-reply copy is listed in section 3 | — |
| Cmd-click or long-press links and paths (#202, #208, #257, #272; open PRs #275, #276) | Open what the agent mentions | partial | Tracked in section 3: paths open in the inspector | P1 |
| Tabs and panes: split, resize, zoom, focus neighbors (#89, #183) | See several things at once; organize parallel work | deliberately different | Agents are the unit (D-007); the transcript and Changes already sit side by side. Maybe later: a second agent beside the first on wide screens | P2 |
| Recent pane switcher: Ctrl+Tab over the 12 most recent panes (FEATURES) | Bounce between the 2–3 agents I'm actively steering | missing | Keep a most-recently-used list of opened agents per device: "Recent" first in ⌘K, and Ctrl+Tab cycles through it | P2 |
| Pane search: Alt+K over every live pane (#241) | Find any agent fast | have | ⌘K matches title, id, workspace, runtime, status and branch | — |
| Zen mode (#177, #205, #266) | Focus | partial | The side nav collapses and resizes (`Shell.tsx`) | P2 |
| Terminal themes, custom font, font size (#131, #268, #278) | Legible output | deliberately different | Covered by the app's theme and text size (section 9) | — |
| Incremental transport; dropping stale repaints (#207, #213) | Stay usable on slow links | have | Slim entries, immer patches coalesced per tick, permessage-deflate, cursor resume | — |
| Pause other browsers; Herdr protocol negotiation and fallbacks (DEPLOYMENT "Herdr compatibility") | Avoid contention; work with whichever Herdr is installed | deliberately different | No shared terminal size to fight over; oar is pinned from npm (D-004) | — |

## 13. Ranger, roamgate's assistant (v0.8.0, compared 2026-10-08): rowrow's Coach

| roamgate feature (source) | User need | rowrow status | rowrow evidence / design sketch | Priority |
|---|---|---|---|---|
| Ranger chat: topbar button and ⌘⌥⇧A; float, pin (resizable) or maximize; full screen on mobile; History, New chat; wave bar (#354, #364, #365) | Make sense of many agents at once, from any device | have | Coach (D-044): a rowrow agent with role coach, in its own window (`Coach.tsx`, `ConversationWave.tsx`), its chats kept out of every agent list | — |
| Reads: workspace status, agent history, diffs, terminal output; scope per workspace, none by default, fixed per question; bounded results with read times (#354, #374) | Ask without opening each agent, and control what reaches a model provider | have | `agents_status`, `agent_history`, `agent_changes`, `agent_background` over `rowrow mcp coach`, with a per-run token that reads only the turn's workspaces (`src/server/coach/`) | — |
| Model connection and quick model/effort pickers (#364, #367, #371) | Choose what it runs on | deliberately different | Coach runs on a runtime signed in on this machine (claude or pi), with its built-in tools off; model and effort pills under the composer apply to the next message | — |
| Proposals confirmed on cards; high-permission mode (#354, #364) | Act on what it found without switching screens | have | D-045: `propose_worktree_create`, `propose_agent_start`, `propose_agent_prompt` freeze a proposal; its card (`CoachActionCard.tsx`) shows the target, every parameter and the exact text with its length, and Confirm runs it once and records rowrow's receipt, which Coach reads with your next message. Full access (Ranger's high-permission mode, all workspaces) only through a dialog, with a header marker. Tabs and splits have no rowrow equivalent | — |
| Workspace and agent mentions: @ in the message box, removable references kept per chat, links in the conversation (#375) | Point Ranger at the exact workspace or agent, even when names repeat | have | `CoachMentions.tsx`, `src/shared/coach-mentions.ts`: @ (or the @ button) lists the workspaces Coach may read and their agents with workspace and runtime; ↑/↓, Enter or Tab pick, Escape closes, Shift+Enter is a new line; editing a reference's text unbinds it. `coach.send {mentions}` checks each against the turn's scope (archived, removed or outside it: pick it again) and the frame names them as data; the transcript links each to its agent or workspace. Tasks don't carry references: a task's prompt names agents by id, and rowrow never gives an id to another agent, so a monitor keeps its agent without them | — |
| Scheduled tasks and monitoring notifications (#356, #358) | Be told when the condition I care about happens | have | D-050: Chat \| Tasks in Coach's header; a task is a prompt, a schedule (once, daily in an IANA zone, every N minutes) and "Notify when each run finishes" or "Let Coach decide"; each run a fresh Coach chat the server starts, one at a time, missed occurrences combined; Run now, Pause, Stop run, Edit, Delete, run history with each run's chat; `propose_coach_task` cards and `send_user_notification` (once a run, deduplicated by eventKey); `rowrow coach tasks`. Tasks use Coach's workspaces rather than a scope of their own; no Cancel state (Delete stops and removes) | — |

---

## Top 10 gaps, in build order

This order assumed the Workspace Inspector lands first (it has); approvals have since been parked (D-022).

1. **Model/effort switcher on the agent page.** The contract, fold and transcript notice already exist, so this is a small piece of UI for a daily need.
2. **Phone "next agent that needs you", plus badges.** ⌘J is keyboard-only and attention is rowrow's first principle, so the phone needs the same one-tap jump and a count you can see at a glance.
3. **Quick replies, stored in a new server-side `settings` group.** Typing is the main cost of steering from a phone, and this is the need roamgate's custom shortcut grid really serves. The settings group also unblocks the per-device and notification preferences.
4. **Command/skill picker (#226).** oar lists catalogs per runtime and cwd (a fix upstream), and the composer gets a `/` trigger. Without it, skills and commands can't be discovered or invoked from a phone.
5. **Revert in Changes.** Per-agent turn snapshots allow "undo this turn's edits to this file" with a content re-check, which roamgate's discard can't do. It saves a round trip through the agent.
6. **Run a command in a workspace.** This serves the real needs behind the terminal (tests, `git status`, restarting a server) without tokens or a PTY.
7. **Transcript search.** iOS home-screen apps have no find-in-page, and windowed history hides older turns from the browser's search anyway.
8. **File-path links into the inspector** from tool calls, inline code and diffs. Once the inspector exists, this cheap addition closes the loop from "the agent says it changed X" to looking at X.
9. **Notification preferences and per-agent mute.** With many agents, controlling noise is what keeps push notifications worth trusting.
10. **Stale-build reload banner, then `rowrow update`** (the npm package is D-018). Otherwise, after an upgrade, phones keep running an old UI against the new server.

After these: diff readability (highlighting, search, side-by-side); workspace management UI (rename, archive, forget, pin, discover worktrees, turn hooks off per repository); session download; a Machines switcher.

## roamgate open issues worth adopting

- **#226, agent-aware command picker.** Adopt it on phone and desktop both (PRINCIPLES product 6), with catalogs from oar. Selecting a command fills the draft and never sends. Keep the issue's safety rules: never intercept keys during IME composition, and never replace a non-empty draft without confirmation.
- **#227 search, #228 PR/MR status, #229 commit history.** These are in progress in the inspector. Take their acceptance criteria as written:
  - no stale results after switching checkout;
  - missing CI is never shown as passing;
  - root and merge commits get the right diff base.
- **#174, Kanban/Linear-style triggering.** Worth a later look (P2): a backlog of task cards, each of which becomes an agent (optionally in a new worktree). It fits "jot it down on the phone, start it later".
- **Already covered by rowrow:**
  - #277: rowrow already sanitizes names and uses a private 0700/0600 upload dir with retention. Borrow the stream-to-disk idea only if the 25 MB cap grows.
  - #286: rowrow is composer-only, which roamgate's maintainer also chose.
  - #293: rowrow reads `rowrow.json` first, then `roamgate.json`, then `paseo.json`.
- **Not applicable:** #171, and open PRs #275 and #276 (terminal rendering and terminal link clicks).

## Found along the way (verified in code, not changed)

1. **Enter may do nothing on touch devices.** `src/web/components/Composer.tsx` calls `preventDefault()` on Enter for coarse pointers, intending Enter to insert a newline. But Astryx `ChatComposerInput` returns early when the consumer has prevented default, and preventing default also cancels the browser's own line break. So on keyboards that report `Enter` (iOS Safari, hardware keyboards on tablets), Return likely does nothing. The phone e2e test uses the Send button, so this isn't covered. Check it on an iPhone.
2. **`rowrow agent export` doesn't exist.** docs/decisions.md D-005 mentions it, but the CLI has no such command.
3. **Two update procedures have no UI.** `agents.update {model, effort}` has no control in the web app. `workspaces.update {label, archived}` has neither a UI nor a CLI verb; it's reachable only through `rowrow call`.
