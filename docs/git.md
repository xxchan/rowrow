# Git: worktrees, hooks, snapshots, changes, the inspector

> Turn diffs: rowrow snapshots each agent's workspace when its turn starts and when it ends
> (`src/server/workspaces/git-ops.ts`, docs/decisions.md D-015); `listChanges` compares
> `turnBaseline` with `turnEnd` when given, else with the worktree now.

What `src/server/git/` does and the rules it keeps. The overview is in
[architecture.md](architecture.md#workspaces-and-git). Every git call goes through `exec.ts`
(timeout that kills the process group, no pager or prompts, `LC_ALL=C`, never a shell);
its `run` starts `gh` the same way.

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

**Review** (`workspaces.hooks {id, action}`, roamgate #296): before a hook runs, the dialogs
that create or remove a worktree (and the new-agent form, when a repository has hooks and
New worktree is on) show the file that is in effect, whether it is rowrow's own or another
tool's read for compatibility, its path, and the commands this action runs; a file that
can't be used shows its error there. `create` resolves against the checkout the worktree
comes from (the new worktree's own copy, if origin's default branch has one, wins when it
runs); `remove` resolves exactly as removal will.

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
- **Staged or not** (`working` only): each file also has `staged` (the index differs from
  HEAD), `unstaged` (the worktree differs from the index; always for untracked and
  conflicted files) and a `stamp` for the file actions below. Both come from
  `git status --porcelain=v2 --no-renames` on the same index copy; a renamed row covers both
  of its paths.
- **Generated files** get `generated: true` (roamgate #340): `linguist-generated` or
  `gitlab-generated` set in `.gitattributes` (one `git check-attr --stdin` per listing), or a
  lockfile (`package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`…) that no attribute
  unmarks (`-linguist-generated`, `=false`; an unmarking wins). The web app starts their diffs
  collapsed, as it does diffs of 1,000 changed lines or more and, once loaded, patches of
  128 KB or more or cut at the cap.
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

## File actions (`file-actions.ts`, `status.ts`)

Narrow mutations of a working tree (roamgate #71), behind `git.fileAction` and
`git.bulkAction` (D-019). The client never sends a git command: each action is one fixed
git invocation.

| Action | Applies to | git |
| --- | --- | --- |
| `stage` | unstaged edits, untracked files | `git add -- <paths>` |
| `unstage` | staged changes (the edits stay in the file) | `git reset -q -- <paths>`: unlike `restore --staged`, it works before the first commit |
| `discardUnstaged` | unstaged edits of tracked files; the staged version stays | `git restore --worktree -- <paths>` |
| `deleteUntracked` | one untracked file or symlink | `git clean -f -q -- <path>` |
| `markResolved` | a conflicted file with no line starting with `<<<<<<<` or `>>>>>>>` | `git add -- <path>` |
| `stageAll`, `unstageAll`, `discardAllUnstaged` | the same, for every file it applies to | the same, with `--pathspec-from-file=- --pathspec-file-nul` |
| `deleteAllUntracked` | every untracked file | `git clean`, 100 paths per run |

- **Paths** are the list's: relative to the worktree's top, normalized (no empty, `.` or
  `..` segments), not inside `.git` (any case), no NUL. They go after `--` in argv, with
  `GIT_LITERAL_PATHSPECS=1`, so `-rf.txt`, `*.txt` or `:(top)x` name exactly those files.
  git runs only on paths its own status reports for that action.
- **Refused**: anything conflicted except `markResolved` (bulk actions never touch
  conflicts); a nested repository (`dir/` in the list) for staging or deleting; a submodule
  or an intent-to-add entry for discarding (`restore` would empty an intent-to-add file).
  `git clean` deletes only untracked, unignored files, whatever a path became meanwhile.
- **Stamps.** Every row of the working list has a stamp, `<state>.<content>`: `state`
  hashes, for each of the row's paths, git's porcelain-v2 record (status letters, modes,
  HEAD and index object ids; `--no-renames`, so a record depends on its own path only) and
  the file's `lstat` (type, size, inode, mode, and modification and change times in
  nanoseconds); `content` hashes the bytes (files up to 8 MiB, 64 MiB per listing; else
  `-`). An action re-reads the state through an index copy and recomputes the stamp: the
  state parts must be equal, and the content parts too when both have one. Otherwise it
  fails with CONFLICT ("changed since this list was loaded: refresh and try again") and
  changes nothing. A change time can't be set back by a program, so any write shows.
- **Bulk actions** get the rows the client saw (path, oldPath, stamp). They also fail with
  CONFLICT when a file they would touch isn't among those rows: it changed or appeared
  since, or the list was cut at 2000 files.
- **Retries** carry the old stamp and are refused as stale: an action is never applied twice.
- **Locking.** Looking (the status, the stamps) uses an index copy; the action itself writes
  the real index and takes `index.lock` like any git command, so an agent's concurrent
  commit can make it fail ("try again in a moment"). Actions on one workspace run one at a
  time. Afterwards the workspace's git facts are refreshed and the new working list is
  returned.

## Reverting a file to the start of a turn (`revert.ts`)

`git.revertFile` (D-051) puts one file of the Last turn list back as the turn's start snapshot
had it. The latest turn (the agent's, or the workspace's of any agent) must be over, its agent
not working, both snapshots stored, and its start must be the `base` the client listed (else
CONFLICT: another turn ran since).

- **Which paths**: `git diff --raw -M --no-abbrev <start> <end>` over the whole turn finds the
  row, as the list found it (a rename is detected only among all the files); a rename's row has
  both of its paths. A submodule is refused.
- **The precondition is the end snapshot**: each path must hold exactly what the turn left:
  nothing; a file whose content `git hash-object --path=<path>` hashes to the end's blob (the
  clean filters `git add` ran), whatever its mode bits; or a symbolic link with the same target.
  No folder on the way may be a symbolic link. Otherwise it is refused and nothing is written:
  "already as it was before this turn" when every path holds what the start had, else "changed
  since the turn ended".
- **Writing**: a path the start didn't have is removed, with the folders that leaves empty. A
  file is `git cat-file --filters --path=<path> <blob>` (smudge filters and line endings, as a
  checkout writes it) into a temporary file beside it, renamed over it; it gets the start's
  executable bit and keeps the file's other permission bits (a new file: 0666 or 0777 less the
  umask). A symbolic link is made beside it and renamed over it. A rename restores its old path
  first. Over 64 MiB at the start, it is refused.
- **Never** the index, refs, commits or another path. It runs one at a time with the file
  actions of the same workspace; afterwards the workspace's git facts are refreshed.

## History (`history.ts`)

The current branch's commits and each commit's changes (roamgate #229), behind `git.log`,
`git.commit` and `git.commitDiff`. Read-only.

- **Pages**: `git log -z --format=… --skip=<n> --max-count=<limit + 1> <from> --`, 50 per
  page (at most 200), newest first, with `--no-show-signature --encoding=UTF-8` and
  mailmapped names. `from` is HEAD's commit id when the first page is read; the cursor,
  `<from>:<skip>`, keeps later pages on that history even when the branch moves.
- **What a commit is compared with**:

| Commit | Base | `baseLabel` |
| --- | --- | --- |
| one parent | the parent | `Compared with its parent 1a2b3c4` |
| a root commit | the empty tree (`git hash-object -t tree --stdin`: nothing is written; sha1 or sha256) | `Root commit: compared with the empty tree` |
| a merge | its first parent | `Merge commit: compared with its first parent 1a2b3c4` |
| a shallow clone's oldest commit | none: no files, a note | `This commit's parent isn't in this shallow clone…` |

- Diffs are `git diff <base> <commit>` between trees, with the Changes flags and limits
  (2000 files, patches cut at 512 KB, literal pathspecs): the index and the worktree are
  never read, so uncommitted work can't leak into history.
- **Commit ids only**: hex, full or abbreviated, resolved with `rev-parse --verify
  <id>^{commit}`. No ranges or ref expressions, nothing that could be read as an option.
- A shallow clone says so (`shallow: true`), and its last page notes that older commits
  aren't here.
- **A file as it was** (roamgate #304): `files.read {rev}` finds the path in the commit's tree
  with `git ls-tree -z -l --full-tree <commit> -- <path>` (literal pathspecs) and reads the
  blob with `git cat-file blob`, under the preview's rules (binary refused, cut at 1 MiB on a
  line). A folder, a submodule, or a path the commit doesn't have is refused with a message.
  For a file the commit deleted, the History tab asks for it at the base the commit is
  compared with (its parent, or a merge's first parent) and says so.

## Search (`search.ts`)

File names and contents across a checkout (roamgate #227), behind `files.search`, the whole
list for the Files tree, `files.list`, and the preview a result opens, `files.read` (D-021). Read-only; never takes the index lock
(`GIT_OPTIONAL_LOCKS=0`).

- **Names**: `git ls-files --cached --others --exclude-standard --deduplicate -z`, so tracked
  and untracked files with .gitignore honored. A path matches when it contains every word
  of the query. The file's own name matching first, then shorter paths; files deleted from
  the worktree are skipped.
- **Contents**: `git grep --untracked -I -n --no-column --full-name -z -F [-i] -e <query>`:
  the same files, binary ones skipped, the query as a fixed string. Smart case: an
  uppercase letter in the query makes it case-sensitive. Lines are cut to about 240
  characters around the first match (`…` marks a cut).
- **Bounds**: 200 names and 200 lines, sorted by path (and line), with `namesTruncated` and
  `linesTruncated`. `git grep` is killed once its output passes 2 MiB, or after 10 s (a note
  says so); what it found by then is kept.
- **Preview**: a path relative to the top of the checkout, checked like a file action's; its
  real path must stay inside the checkout and outside `.git` (a symlink leading out is
  refused). Regular files only; a NUL in the first 8000 bytes is binary and refused; the
  text stops at 1 MiB, on a line boundary (`truncated`).
- **Tree**: `files.list` is the names query without a query: every tracked and untracked
  file, .gitignore honored, files deleted from the worktree left out, sorted, at most
  50,000 (`truncated`). The Files tab builds its tree from it and colors it with the
  working changes; it reloads when the workspace's git state changes.

## Downloads (`download.ts`)

Any file of a checkout, or a folder as `<folder>.tar.gz` (roamgate #312), behind
`files.download`: `GET /api/files/download?workspaceId=…&path=…`, so a browser fetches it
with its cookie (D-042). Paths are resolved like the preview's (`resolveInCheckout`: inside
the checkout, outside `.git`, symlinks followed only if they stay in).

- **A file**: sent as it is on disk, binary or not, read as the response goes out
  (`fs.openAsBlob`), as `application/octet-stream` under its own name.
- **A folder**: the files the tree shows in it (`git ls-files --cached --others
  --exclude-standard` on the folder, minus files deleted from the worktree; never `.git`,
  never ignored files like `node_modules`), packed by the system's `tar` (`--no-recursion
  --null -T -`, `-C` the folder's parent so entries start with its name; `COPYFILE_DISABLE`
  for macOS) in memory, for at most 2 minutes. A folder with nothing but ignored files is
  refused.
- **Cap**: 256 MiB, a file's size or a folder's files added up before compression (and the
  archive itself); above it the call fails with a message that says the size and the cap.

## Pull requests (`pull-request.ts`)

The pull request of a checkout's current branch (roamgate #228), behind `git.pullRequest`,
read with the GitHub CLI where the server runs (D-020). Read-only.

1. Without the network: a detached HEAD is `detached`; no remote is `no-remote`; remotes that
   are all local paths or other forges (GitLab, Bitbucket, Codeberg, sourcehut, Gitea) are
   `unsupported`: GitHub only for now.
2. `gh pr view --json number,title,url,state,isDraft,author,headRefName,baseRefName,reviewDecision,statusCheckRollup,updatedAt`
   in the checkout, so gh's sign-in (github.com or an enterprise host) and its rules for
   which PR belongs to the current branch apply. 15 s timeout; no prompts, no update checks.
3. gh not found is `no-gh`; "none of the git remotes … known GitHub host" is `unsupported`;
   "no pull requests found" is `none`; exit code 4 or an authentication message is
   `signed-out`; anything else is `error` with gh's first line of output.

- **State**: `OPEN` (a draft is `draft`), `MERGED`, `CLOSED`.
- **Checks** fold check runs and commit statuses: `failing` if any failed (failure, timed
  out, action required, startup failure, error), else `unknown` if any value isn't one
  rowrow knows, else `pending` while any runs or is expected, else `cancelled` if any was
  cancelled or went stale, else `passing` when there is at least one check (skipped and
  neutral count as fine), else `none`. Missing data is never passing.
- **Review**: GitHub's review decision: `approved`, `changes_requested`, `review_required`;
  empty is `none` (no decision, not approved); anything else `unknown`.
- Answers are cached per workspace and branch for a minute (an error for 10 s); `refresh`
  asks again, and concurrent asks share one gh run. `checkedAt` says when gh answered.
- `gh` is `ServerOptions.gh` (tests pass a fake script), else `gh` on PATH.
