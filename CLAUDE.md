# rowrow: working in this repo

rowrow runs many coding agents (Claude Code, Codex, Cursor, Antigravity, Grok, Kimi, OpenCode, Pi) on
one machine and lets you steer them from any browser, including your phone. Read
[PRINCIPLES.md](PRINCIPLES.md) first. The design is in [docs/architecture.md](docs/architecture.md),
the reasons in [docs/decisions.md](docs/decisions.md), git mechanics in [docs/git.md](docs/git.md), and
dependency workarounds in [docs/upstream.md](docs/upstream.md).

## Commands

```bash
pnpm install        # pnpm fetches Node 24 (devEngines) when your shell has another version
pnpm dev            # a server (profile dev, scripted runtime) + Vite with hot reload; prints a sign-in link
pnpm check          # typecheck + lint + format check + unit and integration tests: must pass before a commit
pnpm test:e2e       # Playwright on a desktop and a phone viewport (rebuilds the web app if it changed)
pnpm test:e2e -g "the inspector" --project desktop   # one test on one viewport
pnpm test:package   # packs the npm package, installs it with npm in a temp prefix, and runs it
pnpm rowrow …       # the CLI (node src/cli/main.ts …)
pnpm shot <route>   # a screenshot of the real UI, signed in: --mobile, --dark, --profile dev (default),
                    # --click "Name" (a button, tab, tree row…), --element "Name" (just that dialog or region)
pnpm ios:test       # the iOS app's core (swift test), against a real server from this checkout
pnpm desktop        # the Mac app from this checkout: throwaway home, its server as a child process
pnpm test:desktop   # builds the Mac app's code, then drives it with Playwright (test/e2e-desktop)
pnpm package:desktop  # rowrow.app with this Mac's server bundle, signed ad hoc (--pack: zip, dmg, latest-mac.yml)
pnpm build:bundle   # a server bundle (Node + the package + its dependencies) for --target darwin-arm64,linux-x64,linux-arm64
```

The iOS app (`ios/`, [docs/ios.md](docs/ios.md)) builds with Xcode:
`xcodebuild -project ios/Rowrow.xcodeproj -scheme Rowrow -destination 'platform=iOS Simulator,name=iPhone 17' build`.
To try it in the simulator against `pnpm dev`, open the sign-in link as
`xcrun simctl openurl booted "rowrow://pair?link=<the link, URL-encoded>"`.

The Mac app (`src/desktop`, [docs/desktop.md](docs/desktop.md)) is Electron: `pnpm desktop` runs
it without touching your launchd or `~/.rowrow`. Its log is `~/Library/Logs/rowrow/desktop.jsonl`
(`.dev/desktop/app/logs/` for `pnpm desktop`).

## Verify your change like a user would

1. **Prove it at the cheapest layer that can catch its regression.** Pure folds
   (`src/shared`): unit tests. Server behavior: `test/server.test.ts`, which runs the whole
   server in-process on a throwaway home with the scripted runtime and drives it through the
   real typed client over HTTP and WebSocket. UI flows: `test/e2e/` (Playwright, desktop and
   phone).
2. **Look at it.** Run `pnpm dev` (or `pnpm rowrow serve --profile <name> --test-runtime`),
   then `pnpm shot /a/<agent-id> --mobile` and read the PNG it prints. `pnpm shot` also
   prints the browser console's warnings and errors.
3. **Ask it.** `pnpm rowrow --profile dev status`, `agents`, `agent view <id>`,
   `logs --since 10m`, `errors`. The CLI calls the same API the UI uses.

While you work, run the one test that covers your change (`pnpm exec vitest run
test/inspector.test.ts -t "for the tree"`, `pnpm test:e2e -g "the inspector" --project desktop`); run all
of `pnpm check` and `pnpm test:e2e` once before you commit. Both are quiet when they pass:
what they print is what failed. Keep your own context small too: send a long log to a file
and search it, shoot just the region you changed, and hand wide reading (a library's API,
every caller of a function) to a subagent that returns the answer.

The scripted runtime (`src/server/agents/scripted.ts`) is a real oar session with no model:
`/echo <text>`, `/write <path>` (then the file's lines), `/sleep <ms>`, `/stream <n>`,
`/fail <reason>`, `/run <ms> <command>` (a Bash tool call that takes that long),
`/background <ms> <text>` (a background command that outlives the turn). It starts signed
out; its sign-in (Settings → Agent runtimes) asks for a code, which is always `rowrow`, and
Sign out signs it out again.
Real runtimes spend the user's quota: use them only on purpose.

## Debug the user's running rowrow

The user's own server runs under profile `default`, so leave out `--profile`:

```bash
rowrow status                     # version, live runs, connected clients, recent problems
rowrow errors --since 2h          # warnings and errors, the browser's too (client.*)
rowrow logs --agent <id> --since 1h
rowrow logs --trace <id>          # everything one action caused; CLI errors print their trace id
rowrow agents                     # every agent, the ones that need attention first
rowrow agent view <id>            # the transcript, folded exactly as the UI folds it
rowrow agent entries <id> --full  # the raw log, with native payloads
rowrow state agents.<id>          # the AppState every client renders
rowrow service status             # when it runs as a service: what launchd/systemd says
```

Where things are (`~/.rowrow/<profile>/`, or `$ROWROW_HOME/<profile>/`):

- `rowrow.db`: everything durable (`sqlite3` it: `entries` is every agent's log).
- `logs/rowrow.jsonl`: structured logs of the server and of every browser.
- `server.json` (mode 0600): the running server's address and a token for the local CLI.
- `service.log`: the server's stdout and stderr when launchd runs it (systemd: `journalctl
  --user -u rowrow-<profile>`). A crash loop shows up here first.
- `worktrees/`, `snapshots/`: git worktrees rowrow made; private objects for turn diffs.

Don't change the user's data or agents while debugging unless they asked.

## Rules of the codebase

- **One contract.** Every capability is a procedure in `src/shared/contract.ts` (zod
  schemas and a summary for agents), implemented in `src/server/api/router.ts`. The web
  app, the CLI and agents all use it. There are no side channels.
- **The log is the truth.** An agent's entries and the database are facts; everything else
  (status, attention, transcripts) is a fold in `src/shared` that can be rebuilt. Never
  store a derived value as truth, and never show a fact nobody reported.
- **Boundaries.** `src/shared` runs in the browser too: no `node:*`, and from oar only type
  imports or `@botiverse/oar/observe`. `src/web` talks to the server only through the
  contract. Lint enforces both.
- **Erasable TypeScript**, run directly by Node 24: relative imports carry `.ts`; no enums,
  namespaces or parameter properties. The npm package runs the same modules stripped into
  `lib/*.js` (D-018), so runtime code never names a `.ts` file, and imports are literal
  strings (never a computed `import()`).
- **Log events, not prose.** `log.info("agent.run.started", { runtime })` with a stable,
  dot-namespaced name. Never swallow an error: log it with context, or return it to the
  caller as a `UserError` whose message says what to do.
- **The kit** (`src/kit`, D-027) is what the iOS app runs: `src/shared`'s folds and nothing
  else, no DOM, timers or console. A change to transcript items (`src/shared/transcript-model.ts`)
  bumps `TRANSCRIPT_MODEL_VERSION` and updates `ios/RowrowCore/Sources/RowrowCore/Transcript.swift`.
- **The Mac app** shows each server's own web app and manages hosts only through their
  `rowrow` CLI with `--json` (`src/shared/host.ts` is that output's schema, D-032): a new host
  capability is a CLI command first. Its main process never imports `src/server` or `src/cli`;
  pure logic lives in modules without `electron` imports so vitest covers it (`plan.ts`,
  `ssh.ts`, `servers.ts`). Nothing it starts may run from inside the app bundle after it quits
  (an update would replace it underneath: updater.ts says what else keeps updates installing).
- **The iOS app** uses the contract's HTTP routes like the CLI (D-026): a new capability is a
  procedure first, then a typed call in `RowrowCore/Procedures.swift`. SwiftUI with system
  components, Swift 6 concurrency, no third-party packages; everything but views lives in
  `RowrowCore` so `swift test` covers it. Look at it in the simulator (Xcode, or
  `xcrun simctl`) like the web app with `pnpm shot`.
- **UI.** Tailwind classes and the components in `src/web/components/ui` (shadcn/ui on
  Radix, ours to edit; D-017). Colors are tokens (`bg-card`, `text-muted-foreground`,
  `bg-diff-add`…, defined in `src/web/index.css`), never raw colors. Keep accessible names
  stable: the e2e tests find things by role and name. Inputs are 16px on phones (iOS zooms
  into smaller ones). Every screen must work at 375 px: check with `pnpm shot --mobile`.
- **oar is ours.** Fix gaps in oar (`../oar`, its own tests and docs) instead of working
  around them here; list any temporary workaround in `docs/upstream.md`.
- **Tests never touch the user's world.** Every server a test starts uses a throwaway
  `ROWROW_HOME`.
- **Decide explicitly.** A choice that constrains later work gets an entry in
  `docs/decisions.md`, with what would make us revisit it.

## Releasing

CI publishes to npm (D-018); nobody runs `npm publish` by hand.

1. Bump `version` in package.json (`npm version 0.2.0 --no-git-tag-version`), commit it,
   and push it to main.
2. Tag that commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` checks that the tag matches the version, runs
   `pnpm check`, packs and smoke-tests the tarball, publishes it with provenance (npm
   trusted publishing, no token), and creates the GitHub release. A prerelease
   (`0.3.0-rc.1`) goes to npm's `next` tag.
4. The same tag sends the iOS app to TestFlight (`.github/workflows/ios.yml`, D-029) once
   the repository has an Apple team configured ([docs/ios.md](docs/ios.md) → TestFlight).
5. The same release carries the server bundles for SSH hosts and rowrow for Mac, signed with
   Botiverse's Developer ID (`MACOS_CERT_P12_BASE64`, which expires 2027-02-01) and notarized,
   with the `latest-mac.yml` its updater reads ([docs/desktop.md](docs/desktop.md) → Releases,
   D-031).
