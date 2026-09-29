# Git: worktrees, hooks, snapshots, changes

> Turn diffs: rowrow snapshots each agent's workspace when its turn starts and when it ends
> (`src/server/workspaces/git-ops.ts`, docs/decisions.md D-015); `listChanges` compares
> `turnBaseline` with `turnEnd` when given, else with the worktree now.

What `src/server/git/` does and the rules it keeps. The overview is in
[architecture.md](architecture.md#workspaces-and-git). Every git call goes through `exec.ts`
(timeout that kills the process group, no pager or prompts, `LC_ALL=C`).

## Branch names (`names.ts`)

- `randomBranchName()` gives `rowrow/<adjective>-<noun>-<4 hex>`, e.g. `rowrow/brave-river-0a1b`
  (50 × 50 words × 65,536 suffixes).
- `slugify(branch)` lowercases and turns every run of other characters into one `-`:
  `rowrow/brave-river-0a1b` becomes `rowrow-brave-river-0a1b`.

## Worktrees (`worktrees.ts`)

- **`defaultBranch(repo)`** asks origin itself (`git ls-remote --symref origin HEAD`, 30 s)
  which branch its HEAD points to and at which commit. A local `origin/HEAD` can be stale or
  missing and the default is not always `main`, so neither is trusted. It then fetches that
  exact commit by id (`git fetch --no-tags --no-write-fetch-head --no-recurse-submodules
  --no-auto-maintenance origin <oid>`, 30 s), which rewrites no remote-tracking ref and no
  `FETCH_HEAD`. It returns null when there is no `origin` remote or origin has no commits,
  and throws when origin can't be reached or its HEAD isn't a branch: silently basing work
  on something older is worse than asking for an explicit base.
- **`createWorktree({ repoDir, root, branch?, base? })`**
  - The branch defaults to a random name. Names are checked with
    `git check-ref-format --branch` and must come back unchanged (no `@{-1}` expansion);
    names starting with `-` are refused.
  - The path is `<root>/<repository name>/<slugify(branch)>`, where the repository name is
    the main checkout's directory name (a bare repository's, without `.git`). An existing
    path is refused. The returned path is the real path, as git reports it.
  - An existing local branch is checked out as it is (`git worktree add <path> <branch>`);
    passing a base with it is an error, like `git worktree add -b` would be.
  - A new branch starts at: the explicit `base` (any commit-ish), else origin's freshly
    fetched default commit (`origin/main @ 1a2b3c4`), else local HEAD
    (`main @ 1a2b3c4 (local)`). It is created from the commit id, so it tracks nothing and
    can't push to the default branch by accident.
  - Checkout may take up to 10 minutes. If it is killed, the half-created (locked) worktree
    is removed; the new branch is kept.
- **`removeWorktree({ path, force? })`** removes a linked worktree with
  `git worktree remove`, run from the main checkout. It refuses the main checkout and a
  path that isn't the top of a worktree. With modified or untracked files and no `force`,
  it throws `DirtyWorktreeError`; `force` discards them (`--force`, once: a locked worktree
  stays refused). The branch is never deleted.
- **`listWorktrees(repo)`** reads `git worktree list --porcelain -z`: main checkout first,
  `{ path, branch, head }` with `branch: null` when detached and `head: null` before the
  first commit; bare and prunable (deleted) entries are skipped.

## Hooks (`hooks.ts`)

A repository declares lifecycle commands in `rowrow.json` at a checkout's root:

```json
{ "worktree": { "setup": "pnpm install", "opened": "…", "teardown": "…", "removed": "…" } }
```

**Resolution** (`resolveHooks({ target, source })`): the first of these files that exists
wins, whole; files are never merged:

1. `<target>/rowrow.json`, 2. `<source>/rowrow.json`,
3. `<target>/roamgate.json`, 4. `<source>/roamgate.json`,
5. `<target>/paseo.json`, 6. `<source>/paseo.json`.

The last four exist for repositories set up for those tools (same shape; `legacy: true`).
A valid file without a hook for an event means that event runs nothing; there is no
fallback to a lower file. A file that exists but can't be read, isn't JSON, isn't an
object, or has a non-string hook throws. In `rowrow.json` an unknown key under `worktree`
also throws (a typo would otherwise silently skip a hook); other tools' files may carry
hooks rowrow doesn't have. Blank commands count as absent.

**When they run** (the caller orchestrates; `target` is the worktree, `source` the checkout
it came from):

| Event | Runs | cwd | Config read from | On failure |
| --- | --- | --- | --- | --- |
| `setup` | after a new worktree is created | target | target, then source | report it; the worktree exists |
| `opened` | after an existing worktree is opened | target | target, then source | report it |
| `teardown` | before removal | target | target, then source | **removal is blocked** (the caller checks `ok`) |
| `removed` | after removal | source | source (the target is gone) | report it |

**Running** (`runHook`): `sh -c <command>` in its own process group, with
`ROWROW_HOOK_EVENT`, `ROWROW_WORKTREE_PATH` and `ROWROW_SOURCE_PATH` set on top of the
server's environment (plus any extra `env`). The default timeout is 10 minutes; on timeout
the whole group is killed. stdout and stderr are captured together; the last 200 KB are
kept (the end says why a hook failed). The result is `{ ok, code, timedOut, output, ms }`,
logged as `git.hook.ran`. If a hook leaves a background process holding its output open,
the run ends 1 s after the shell exits; the background process is left alone.

## Turn snapshots (`snapshots.ts`)

When a turn starts, `SnapshotStore.capture(dir)` records the whole worktree (tracked and
untracked files, honoring `.gitignore`) as a git tree, so "what changed in the last turn"
survives the agent committing, stashing, resetting or switching branches.

**It never writes into the user's repository**: not its objects, index, refs or files.
(Another tool's scratch-index snapshots still wrote blobs into `.git/objects` and leaked
~80 GiB of `tmp_pack_*` files on huge or unreadable untracked files.) git runs with:

- `GIT_OBJECT_DIRECTORY=<snapshots root>/<first 16 hex of sha256(common dir)>/objects`: a
  private object directory per repository, shared by its worktrees. New blobs and trees
  land only here. A `repository` file next to it names the repository.
- `GIT_ALTERNATE_OBJECT_DIRECTORIES=<common dir>/objects`: what the repository already
  has is read in place, never copied.
- `GIT_INDEX_FILE=<scratch copy of the worktree's index>`, deleted afterwards (keeping the
  original's mtime, a millisecond earlier, so git's racy-entry check still works). A copy
  rather than `read-tree HEAD` keeps the stat cache (only changed files get hashed) and
  sparse-checkout bits, and it includes staged changes.
- `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, `core.fsmonitor=false`,
  `core.splitIndex=false`, `core.safecrlf=false`.

Steps: `git status --porcelain=v2 -z --untracked-files=all` lists what `git add` would
have to hash (worktree changes, conflicts, untracked files), then `git add --all` and
`git write-tree`.

**Limits**, checked before anything is hashed: no file over 8 MiB, at most 32 MiB in
total, at most 10,000 files, and 15 s for the whole capture (the process group is killed).
Over a limit, or when git fails (for example on an unreadable file), `capture` returns
`{ kind: "refused", reason }` and keeps nothing; a directory that isn't a git repository
is refused the same way.

What git may still do: when a blob or tree it would write already exists in the
repository, it refreshes that object's (or pack's) mtime instead of writing a copy. Clean
filters (Git LFS) run as they do for `git status`, and LFS keeps its own cache of what it
cleaned.

`env(dir)` gives the environment for reading snapshot trees. `prune(maxAgeMs)` deletes
loose objects not written or reused for that long (a snapshot older than that may become
unreadable; the turn scope then says so) and crash leftovers over an hour old. Snapshot ids
are only meaningful to the store that made them.

## Changes (`changes.ts`)

`listChanges({ dir, scope, turnBaseline?, defaultBase?, store })` returns `Changes`
(`src/shared/schemas.ts`); `fileDiff({ …, path })` returns one file's unified diff.

| Scope | Compares | Base / label |
| --- | --- | --- |
| `working` | HEAD against the worktree: staged, unstaged and untracked (the empty tree before the first commit) | HEAD, `main @ 1a2b3c4` (`HEAD @ … (detached)`, `no commits yet`) |
| `branch` | the merge base of HEAD and the default branch against the worktree: committed, uncommitted and untracked | the merge base, `origin/main @ 1a2b3c4 (merge base)` |
| `turn` | the turn's snapshot against a new snapshot of the worktree | the snapshot tree, `start of the turn (snapshot 1a2b3c4)` |

- **Default branch for `branch`**, without the network: the name from
  `refs/remotes/origin/HEAD`, else `init.defaultBranch`, else `main`, else `master`; for
  each name, `origin/<name>` if it exists locally, else the local branch. `defaultBase` (a
  commit known to be on the default branch, normally the `base` `createWorktree` returned)
  also counts: of the merge bases, the one closest to HEAD wins. It matters because
  `defaultBranch` doesn't move `origin/<default>`: a worktree created from a newer origin
  commit would otherwise show the upstream commits in between as its own.
- **Statuses**: `added`, `modified`, `deleted`, `renamed` and `typechange` from
  `git diff --raw --numstat -z -M`; `conflicted` for unmerged paths; `untracked` in the
  worktree scopes (in `turn`, a new file is `added`). Renames are detected between tracked
  paths and between snapshots; a plain `mv` shows in `working` and `branch` as a deletion
  plus an untracked file until it is staged.
- **Line counts**: `null` for binary files. Untracked files are counted the way git would
  count a new file (lines; binary means a NUL in the first 8000 bytes), except files over
  8 MiB or past 64 MiB read per listing, which get `null`.
- **Notes** instead of files: no snapshot yet, the current state can't be snapshotted (with
  the reason), the snapshot was pruned, no default branch, no common history, no commits.
- **Limits**: 2000 files (`truncated: true`); patches cut at 512 KB on a line boundary
  (`truncated: true`); an untracked file over 8 MiB gets an empty, truncated patch rather
  than being read.
- **Paths** for `fileDiff` are relative to the worktree's top; absolute paths and `..`
  segments are refused, and pathspecs are literal (`GIT_LITERAL_PATHSPECS`).
- **Never writes, never locks**: `git diff` against the worktree refreshes (rewrites) the
  index even with `GIT_OPTIONAL_LOCKS=0`, and holding `index.lock` would fail an agent's
  concurrent `git commit`. So the worktree scopes run on a scratch copy of the index, and
  the turn scope compares trees. Output ignores external diff tools, textconv and prefix
  settings from the user's config.
