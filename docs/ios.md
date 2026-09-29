# The iOS app

rowrow for iPhone and iPad: a native SwiftUI app, designed for what you do with a phone
rather than shrunk from the desktop. The server is the same one the web app and the CLI
use; the app is one more window into it (PRINCIPLES.md, product 2). The decisions behind it
are D-026 (a native app over HTTP, paired like a device), D-027 (the server's own fold, run in
JavaScriptCore) and D-028 (push through APNs, encrypted for the device).

## What a phone is for

At a desk you browse many agents, read diffs side by side and type fast. Away from it you
have a minute, one thumb, and a notification. So the phone's loop is:

1. **Told**: an agent finished or needs you. The notification says which and what it said
   last; reply to it or mark it seen without opening the app.
2. **Triage**: the Agents tab is an inbox, sorted by who needs you. Each row shows what the
   agent said last; swipe to reply (a small sheet with a composer and your quick replies),
   to mark it seen, to archive it or to stop it. Open the conversation only when you need
   all of it.
3. **Read**: a conversation opens at the start of the latest turn, not at the bottom: on a
   phone you read an answer from its top. Each turn shows the agent's answer in full and
   folds the work before it (commands, edits, reads, thinking, text along the way) into one
   line that says what happened ("Ran 3 commands, edited 2 files · 11 steps"), or, while it
   works, what it's doing now ("Running pnpm test"). The work opens in place; a step opens
   its input and output.
4. **Answer**: the composer is dictation-first (Return is a newline; the button sends).
   Quick replies fill it, never send. `/` lists the runtime's commands. Photos,
   screenshots and files go as attachments (D-024). While the agent works, a message steers
   the turn; hold the button to queue it or to stop the turn and send.
5. **Next**: the conversation's toolbar offers the next agent that needs you, replacing the
   screen so back still leads to the inbox.

Reviewing changes is there, made for a narrow screen: the last turn, everything
uncommitted or the whole branch; swipe a file to stage, unstage, discard or delete it (the
server refuses when it changed since you looked, D-019); diffs wrap by default; tap a line to
comment on it, and the comments become one "Review feedback" message in the agent's
composer, the same message the web app writes (you read it over and send it).

Starting an agent is a sheet with the text first (dictate it), and the workspace, agent,
model, effort and worktree already chosen the way the web app chooses them (D-023), one tap
away if you want others.

## Screens

| Tab | Screen | What it does |
| --- | --- | --- |
| Agents | Inbox | Needs you, Working, Idle; search; swipe and long-press actions; the connection's state |
| | Conversation | turns (answer first, work folded), the composer, next agent, changes, ⋯ actions |
| | Changes, Diff | scopes, file actions, line comments, the review bar |
| Workspaces | List | repositories with their worktrees, changed files, agents' states |
| | Workspace | agents, changes, history, file search, pull request, new agent or worktree here |
| | History, Commit, Search, File | read-only views of the checkout |
| Settings | | the server, notifications, quick replies, devices (pair one with a QR code), runtimes, servers, sign out |

On iPad the tab bar becomes a sidebar (`.sidebarAdaptable`); the screens are the same.

## Architecture

```
 ios/
  Rowrow/                 the app (SwiftUI): views, navigation, notifications
  RowrowNotifications/    notification service extension: opens sealed pushes (D-028)
  RowrowCore/             a Swift package: everything that isn't a view, tested with `swift test`
    API.swift             POST /api/<group>/<name>, server-sent events, uploads, pairing
    JSON.swift            a JSON tree and immer patches (state.watch)
    Models.swift          the shapes of src/shared/schemas.ts, decoded leniently
    Session.swift         one server, live: app state, the kit, presence, reconnects
    Kit.swift             src/shared's folds in JavaScriptCore (D-027)
    TranscriptStore.swift an agent's conversation: agents.entries, then agents.watch
    Accounts.swift        paired servers; tokens in the Keychain
    PushSeal.swift        the key pushes are sealed with (D-028)
```

- **Transport** (D-026). The app calls the contract's OpenAPI routes, like the CLI and
  curl: `POST /api/<group>/<name>` with JSON, streams as server-sent events. It holds two
  streams while in the foreground (`state.watch`, and `agents.watch` for the agent on
  screen) and closes them in the background.
- **State.** `state.watch` sends a snapshot, then immer patches. The app keeps the JSON
  tree, applies patches to it, and decodes typed models at most every 150 ms (patches come
  much faster while agents stream). The last state is saved, so a cold start shows your
  agents at once while it reconnects. A patch that doesn't fit, or a dropped stream, ends
  in a fresh snapshot.
- **Transcripts** (D-027). The app never interprets the agent log. It downloads the kit
  (`/kit.js`: `src/kit/kit.ts`, which bundles `src/shared`'s folds and oar's) from the server
  it talks to, runs it in JavaScriptCore on a background actor, and feeds it the same slim
  entries the web app folds. The kit answers with transcript items with stable ids
  (`src/shared/transcript-model.ts`) and, after every change, only the items that changed,
  so while text streams one item is decoded and redrawn. The kit also words agents' states
  (`src/shared/describe.ts`), resolves a new agent's setup (`src/shared/new-agent-setup.ts`)
  and compiles review feedback (`src/shared/feedback.ts`), so the app and the web app say the
  same things. The kit is cached per server (ETag) for offline starts.
- **Presence.** Over HTTP there is no socket to hang presence on, so the app names its
  `state.watch` stream (`connection`) and `presence.update` describes that stream (route,
  agent on screen, visible, focused) until it ends. Going to the background, the app says
  it stopped looking before it lets go of the stream. What you look at is marked seen after
  400 ms on screen, as in the web app (D-008).
- **Resilience** (PRINCIPLES.md, engineering 2). Every stream resumes from its cursor after
  a reconnect; the network monitor retries at once when the path comes back; a send that
  may not have arrived keeps its input id, so sending again can't deliver it twice.

## Pairing

The app pairs the way a browser signs in, with the one-time link `rowrow pair` prints and
Settings → Pair a device shows as a QR code. Scan it in the app, paste it (Universal
Clipboard brings it from a Mac), or open a `rowrow://pair?link=…` URL (the app asks first:
pairing sends your messages to that server). The app trades the link's code for a bearer
token (`POST /auth/token`), which it keeps in the Keychain; the server lists it as a device of
kind `app`, revocable like any other. The app can pair with several servers and shows one
at a time (Settings → Servers).

Reaching the server: `tailscale serve` (HTTPS with a real certificate) works anywhere.
iOS allows plain HTTP only on the local network (`NSAllowsLocalNetworking`: localhost,
`.local` names, bare host names, IP addresses), so `--host 0.0.0.0` on a trusted LAN works at
home too.

## Notifications

When an agent finishes or needs you and no screen of yours is showing it, the server
notifies you (D-028). While you use the app, the app shows its own banner (the server doesn't
push to a device you're using). In the background, the server pushes through Apple's push
service, which needs your own APNs key, because Apple takes pushes for an app only from its
developer:

```bash
rowrow push apns AuthKey_ABC123DEFG.p8 --key-id ABC123DEFG --team-id DEF123GHIJ
rowrow push                     # which devices get notifications
rowrow push apns --off
```

The key comes from developer.apple.com → Certificates, IDs & Profiles → Keys (a key with
Apple Push Notifications service enabled), from the same team that signs the app. Apple
sees only "rowrow: An agent finished." Everything else a notification says is sealed
(AES-256-GCM) with a key the app made and gave the server, and the notification service
extension opens it on the phone.

Each notification is one per agent (a newer one replaces it), grouped by agent, and has two
actions: **Reply** (type or dictate; it's sent as your message) and **Mark as Seen**. The
Home Screen badge counts the agents that need you, and when you see an agent anywhere, its
notifications leave every phone (a quiet push with the ids of the agents seen).

## Build and run

Needs Xcode 26 or later (the app targets iOS 26). The project is `ios/Rowrow.xcodeproj`:
an app target and the notification extension, both with synchronized folders (add a file
to the folder and it's in the target), and the local `RowrowCore` package.

- **Simulator**: open the project and run, nothing to configure. `pnpm dev`, then pair with
  the link it prints (open `rowrow://pair?link=<the link, URL-encoded>` with `xcrun simctl
  openurl booted …`, or paste it). The scripted runtime answers `/echo`, `/write`, `/stream`
  and `/fail` without tokens.
- **Your iPhone**: copy `ios/Config/Local.xcconfig.example` to `Local.xcconfig` (not in git)
  and set your team and a bundle id you own. Push needs a paid Apple Developer membership;
  with a free team, use `Config/Rowrow-NoPush.entitlements` there.

Tests:

```bash
pnpm ios:test                   # swift test: the core, and a real server driven through it
xcodebuild -project ios/Rowrow.xcodeproj -scheme Rowrow -destination 'platform=iOS Simulator,name=iPhone 17' build
```

`pnpm ios:test` starts a real rowrow server from the checkout (scripted runtime, throwaway
home) and pairs with it, replicates the app state through patches, downloads the kit and
folds a transcript, sends and follows a turn, uploads a file and reads a diff: the whole wire
the app depends on. The server side of the app is in `test/ios.test.ts` (`pnpm check`).

## TestFlight

`.github/workflows/ios.yml` builds the app and runs `pnpm ios:test` for every change that
can affect it. For a version tag (the one that publishes to npm, AGENTS.md → Releasing), or
when you run the workflow by hand (Actions → ios → Run workflow, or `gh workflow run
ios.yml`), it also archives the app and uploads it to App Store Connect, and TestFlight offers
it to your testers once Apple has processed it. The app's version is the package's
(`0.3.0-rc.1` becomes `0.3.0`), its build number the workflow's run. D-029 says why it
signs the way it does.

Once, with Apple (a paid Apple Developer membership):

1. **The app.** Register its bundle id (developer.apple.com → Identifiers; running the app
   on your iPhone from Xcode does it too), then App Store Connect → Apps → + → New App with
   it. The notification extension's id (`<bundle id>.notifications`) and the capabilities are
   registered by the first upload.
2. **An API key.** App Store Connect → Users and Access → Integrations → App Store Connect
   API → Team Keys → +, with the Admin role: through it Xcode makes the profiles and signs
   with a distribution certificate Apple keeps. Download the `.p8` (you can only once) and
   note its key id and the issuer id.
3. **A development certificate** with its private key, as a `.p12` with a password (Xcode →
   Settings → Accounts → Manage Certificates makes one; Keychain Access exports it). Make one
   for CI so you can revoke it alone; it expires after a year.
4. **A device.** Development profiles list devices, so the team needs one registered: running
   the app on your iPhone from Xcode registers it.

Then in the repository (secrets can also live in the `testflight` environment, which limits
the refs that can use them):

```bash
gh variable set IOS_TEAM_ID --body ABCDE12345            # your team id (developer.apple.com → Membership)
gh variable set IOS_BUNDLE_ID --body com.example.rowrow  # only when it isn't io.github.xxchan.rowrow
gh secret set APP_STORE_CONNECT_KEY_ID --body XYZ987ABCD
gh secret set APP_STORE_CONNECT_ISSUER_ID --body 00000000-0000-0000-0000-000000000000
gh secret set APP_STORE_CONNECT_KEY < AuthKey_XYZ987ABCD.p8
base64 -i ci.p12 | gh secret set IOS_SIGNING_CERTIFICATE
gh secret set IOS_SIGNING_CERTIFICATE_PASSWORD
```

Until `IOS_TEAM_ID` is set, tags skip the upload (a fork's releases don't fail). App Store
Connect holds each build for its export-compliance question (the app uses encryption: HTTPS,
and AES-GCM for notifications) until someone answers it, or until the answer is declared
with `ITSAppUsesNonExemptEncryption` in `ios/Config/Info.plist`.

## Limits and what's next

- The notification service extension is unit-tested (it opens what the server seals) but
  has run only where APNs delivers for real: `simctl push` doesn't start service
  extensions, so in the simulator a push shows its generic text.
- Live Activities and widgets would show agents' progress on the Lock Screen, but their
  content can't be encrypted like a notification's; under PRINCIPLES.md (product 7) they
  could only say "3 agents working" without names. Not built yet.
- App Intents (Siri, Shortcuts: "start a rowrow agent in …"), a merged inbox across
  servers, and a split view with the conversation beside the inbox on iPad.
- Permission prompts stay parked with the web app's (D-022).
