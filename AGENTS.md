# rowrow: working in this repo

rowrow runs many coding agents (Claude Code, Codex, Grok, Kimi, Pi) on one machine and lets
you steer them from any browser, including your phone. Read [PRINCIPLES.md](PRINCIPLES.md)
first. The design is in [docs/architecture.md](docs/architecture.md), the reasons in
[docs/decisions.md](docs/decisions.md), git mechanics in [docs/git.md](docs/git.md), and
dependency workarounds in [docs/upstream.md](docs/upstream.md).

## Commands

```bash
pnpm install        # pnpm fetches Node 24 (devEngines) when your shell has another version
pnpm dev            # a server (profile dev, scripted runtime) + Vite with hot reload; prints a sign-in link
pnpm check          # typecheck + lint + format check + unit and integration tests: must pass before a commit
pnpm test:e2e       # builds the web app, then Playwright on a desktop and a phone viewport
pnpm rowrow …       # the CLI (node src/cli/main.ts …)
pnpm shot <route>   # a screenshot of the real UI, signed in: --mobile, --dark, --profile dev (default)
```

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

The scripted runtime (`src/server/agents/scripted.ts`) is a real oar session with no model:
`/echo <text>`, `/write <path>` (then the file's lines), `/sleep <ms>`, `/stream <n>`,
`/fail <reason>`. Real runtimes spend the user's quota: use them only on purpose.

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
  namespaces or parameter properties.
- **Log events, not prose.** `log.info("agent.run.started", { runtime })` with a stable,
  dot-namespaced name. Never swallow an error: log it with context, or return it to the
  caller as a `UserError` whose message says what to do.
- **UI.** Astryx components first. Check props with `pnpm exec astryx component <Name>
  --dense`; the types in `node_modules/@astryxdesign/core/dist/**/*.d.ts` are the truth
  when docs disagree. Our own styles use `stylex.create` and theme tokens
  (`var(--color-…)`). Every screen must work at 375 px: check with `pnpm shot --mobile`.
- **oar is ours.** Fix gaps in oar (`../oar`, its own tests and docs) instead of working
  around them here; list any temporary workaround in `docs/upstream.md`.
- **Tests never touch the user's world.** Every server a test starts uses a throwaway
  `ROWROW_HOME`.
- **Decide explicitly.** A choice that constrains later work gets an entry in
  `docs/decisions.md`, with what would make us revisit it.
