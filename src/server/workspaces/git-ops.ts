// What the API does with git (docs/git.md for the mechanics): worktrees with the
// repository's hooks, the three diff scopes, and each agent's "last turn": snapshots of
// its workspace when its turn starts and when it ends, so the turn diff is exactly what
// changed during that turn. (Another agent working in the same checkout at the same time
// shows up in it too: files don't know who wrote them.) Also the workspace inspector:
// file actions on the working tree, commit history, the branch's pull request, search.
import type {
  BulkAction,
  Changes,
  DiffScope,
  FileAction,
  PullRequestStatus,
  SeenFile,
  Workspace,
  WorktreeHooks,
} from "../../shared/schemas.ts";
import { basename } from "node:path";
import type { GitOps } from "../api/router.ts";
import { UserError } from "../errors.ts";
import { fileDiff, listChanges } from "../git/changes.ts";
import { ActionRefused, applyBulkAction, applyFileAction, StaleError } from "../git/file-actions.ts";
import { downloadWorkspacePath } from "../git/download.ts";
import { commitPatch, HistoryError, listCommits, readCommit, readFileAtCommit } from "../git/history.ts";
import { resolveHooks, runHook, type HookEvent, type HookRun } from "../git/hooks.ts";
import { pullRequestStatus } from "../git/pull-request.ts";
import { listWorkspaceFiles, readWorkspaceFile, SearchError, searchWorkspace } from "../git/search.ts";
import type { SnapshotStore } from "../git/snapshots.ts";
import { createWorktree, DirtyWorktreeError, listWorktrees, removeWorktree } from "../git/worktrees.ts";
import type { Db } from "../store/db.ts";
import { log, serializeError } from "../telemetry/log.ts";
import type { Workspaces } from "./service.ts";

export interface GitOpsDeps {
  readonly db: Db;
  readonly workspaces: Workspaces;
  readonly store: SnapshotStore;
  /** Where rowrow puts the worktrees it creates. */
  readonly worktreesRoot: string;
  /** Stop the live runs of agents in a workspace (before its checkout is removed). */
  readonly stopAgentsIn: (workspaceId: string) => Promise<void>;
  /** An agent's title, to say whose turn the "last turn" baseline is. */
  readonly agentTitle: (agentId: string) => string | null;
  /** The GitHub CLI to ask about pull requests: `gh` on PATH unless given (tests pass a fake). */
  readonly gh?: string;
}

/** How long a turn may wait for its baseline before starting without one. */
const CAPTURE_BUDGET_MS = 5000;
/** A pull request answer is reused this long (an error, less), unless a refresh is asked for. */
const PR_TTL_MS = 60_000;
const PR_ERROR_TTL_MS = 10_000;

interface TurnRow {
  agent_id: string;
  workspace_id: string;
  start_tree: string | null;
  end_tree: string | null;
  started_at: number;
  ended_at: number | null;
  note: string | null;
}

export interface TurnSnapshots {
  /** Before a turn starts. Waits at most CAPTURE_BUDGET_MS; never throws. */
  turnStarted(workspaceId: string, agentId: string): Promise<void>;
  /** After the runtime ended the turn. Never throws. */
  turnEnded(agentId: string): Promise<void>;
}

export function createGitOps(deps: GitOpsDeps): GitOps & TurnSnapshots {
  const { db, workspaces, store } = deps;

  const gitWorkspace = (id: string): Workspace & { git: NonNullable<Workspace["git"]> } => {
    const ws = workspaces.require(id);
    if (ws.git === null) throw new UserError(`${ws.label} is not a git repository`);
    if (ws.missing) throw new UserError(`${ws.path} no longer exists`);
    return ws as Workspace & { git: NonNullable<Workspace["git"]> };
  };

  const baseOf = (id: string): string | null =>
    db.get<{ base: string | null }>("select base from workspaces where id = ?", id)?.base ?? null;
  /** The turn a "turn" diff is about: this agent's latest, or the workspace's latest of any agent. */
  const turnOf = (workspaceId: string, agentId?: string): TurnRow | undefined =>
    agentId === undefined
      ? db.get<TurnRow>(
          "select * from agent_turns where workspace_id = ? order by started_at desc limit 1",
          workspaceId,
        )
      : db.get<TurnRow>("select * from agent_turns where agent_id = ?", agentId);
  const clock = (at: number): string =>
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  /** One working-tree mutation at a time per workspace: two clicks never race for the index lock. */
  const mutations = new Map<string, Promise<unknown>>();
  const serially = async <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = mutations.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    mutations.set(workspaceId, next);
    try {
      return await next;
    } finally {
      if (mutations.get(workspaceId) === next) mutations.delete(workspaceId);
    }
  };

  /** After a file action: the new working-scope list, and fresh git facts in AppState. */
  const afterAction = async (workspaceId: string, dir: string, action: string): Promise<Changes> => {
    await workspaces
      .refresh(workspaceId)
      .catch((error: unknown) =>
        log.warn("workspace.refresh_failed", { ws: workspaceId, err: serializeError(error) }),
      );
    try {
      return await listChanges({ dir, scope: "working", defaultBase: baseOf(workspaceId), store });
    } catch (error) {
      log.warn("git.changes_failed", { ws: workspaceId, after: action, err: serializeError(error) });
      // Not worth a retry: the action happened (a retry would be refused as stale anyway).
      throw new UserError(
        `${action} was done, but listing the changes again failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const prCache = new Map<string, { branch: string | null; value: PullRequestStatus }>();
  const prInFlight = new Map<string, Promise<PullRequestStatus>>();

  /** A git module's error, as what the caller should do next. */
  const asUserError = (error: unknown): UserError => {
    if (error instanceof UserError) return error;
    if (error instanceof StaleError) return new UserError(error.message, "CONFLICT");
    if (error instanceof ActionRefused || error instanceof HistoryError || error instanceof SearchError)
      return new UserError(error.message, "BAD_REQUEST");
    // git failing (a corrupt repository, a full disk): the message says what; the stack is for us.
    log.warn("git.inspector_failed", { err: serializeError(error) });
    return new UserError(error instanceof Error ? error.message : String(error));
  };

  /** The checkout a linked worktree was made from: where its hooks run once it's gone. */
  const sourceOf = async (ws: Workspace & { git: NonNullable<Workspace["git"]> }): Promise<string> => {
    if (!ws.git.linked)
      throw new UserError(
        `${ws.label} is a repository's main checkout, not a worktree; only worktrees can be removed`,
      );
    const parent = ws.parentId === null ? undefined : workspaces.get(ws.parentId);
    return parent?.path ?? (await listWorktrees(ws.path))[0]?.path ?? ws.git.repoRoot;
  };

  const hook = async (
    event: HookEvent,
    target: string,
    source: string,
    cwd: string,
    expected?: string | null,
  ): Promise<HookRun | null> => {
    const config = await resolveHooks({ target, source });
    const command = config?.worktree[event];
    if (expected !== undefined && (command ?? null) !== expected) throw new HookMismatch(command ?? null);
    if (config === null || command === undefined) return null;
    const run = await runHook({ event, command, cwd, worktreePath: target, sourcePath: source });
    log[run.ok ? "info" : "warn"]("worktree.hook", {
      event,
      config: config.path,
      legacy: config.legacy,
      ok: run.ok,
      code: run.code,
      ms: run.ms,
    });
    return run;
  };

  return {
    async createWorktree(workspaceId, options) {
      const source = gitWorkspace(workspaceId);
      if (workspaces.archived(workspaceId))
        throw new UserError(
          `${source.label} is archived: unarchive the workspace to make a worktree of it`,
          "PRECONDITION_FAILED",
        );
      let created;
      try {
        created = await createWorktree({
          repoDir: source.path,
          root: deps.worktreesRoot,
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(options.base === undefined ? {} : { base: options.base }),
          ...(options.newBranch === true ? { newBranch: true } : {}),
        });
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : String(error));
      }
      const ws = await workspaces.add(created.path);
      db.run(
        "update workspaces set base = ?, base_label = ? where id = ?",
        created.base,
        created.baseLabel,
        ws.id,
      );
      log.info("worktree.created", {
        ws: ws.id,
        from: workspaceId,
        branch: created.branch,
        base: created.baseLabel,
      });
      let setup: HookRun | null;
      try {
        setup = await hook("setup", created.path, source.path, created.path, options.setup);
      } catch (error) {
        if (!(error instanceof HookMismatch)) throw error;
        log.warn("worktree.hook_changed", { ws: ws.id, expected: options.setup ?? null });
        return {
          workspace: workspaces.get(ws.id) ?? ws,
          hook: {
            ran: false,
            ok: false,
            output: `The new worktree's setup hook (${error.command ?? "none"}) isn't the one shown (${options.setup ?? "none"}), so it didn't run.`,
          },
        };
      }
      return {
        workspace: workspaces.get(ws.id) ?? ws,
        hook: setup === null ? null : { ran: true, ok: setup.ok, output: setup.output },
      };
    },

    async worktreeSetup(workspaceId) {
      const source = gitWorkspace(workspaceId);
      try {
        return (await resolveHooks({ target: source.path, source: source.path }))?.worktree.setup ?? null;
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : String(error));
      }
    },

    async hooks(workspaceId, action): Promise<WorktreeHooks> {
      const ws = gitWorkspace(workspaceId);
      // A new worktree's setup reads its own file first, then this checkout's: before it exists,
      // this checkout's is the best answer (the same file unless origin's differs).
      const source = action === "create" ? ws.path : await sourceOf(ws);
      try {
        const config = await resolveHooks({ target: ws.path, source });
        return {
          config:
            config === null
              ? null
              : {
                  path: config.path,
                  file: basename(config.path),
                  legacy: config.legacy,
                  hooks: config.worktree,
                },
          error: null,
        };
      } catch (error) {
        return { config: null, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async removeWorktree(workspaceId, force) {
      const ws = gitWorkspace(workspaceId);
      const source = await sourceOf(ws);
      await deps.stopAgentsIn(workspaceId);
      const teardown = await hook("teardown", ws.path, source, ws.path);
      if (teardown !== null && !teardown.ok) {
        throw new UserError(
          `the repository's teardown hook failed, so the worktree was kept:\n${teardown.output.slice(-2000)}`,
          "PRECONDITION_FAILED",
        );
      }
      try {
        await removeWorktree({ path: ws.path, force });
      } catch (error) {
        if (error instanceof DirtyWorktreeError)
          throw new UserError(
            `${ws.label} has uncommitted changes; remove it with force to discard them`,
            "CONFLICT",
          );
        throw new UserError(error instanceof Error ? error.message : String(error));
      }
      await hook("removed", ws.path, source, source);
      log.info("worktree.removed", { ws: workspaceId, force });
    },

    async forget(ws) {
      prCache.delete(ws.id);
      prInFlight.delete(ws.id);
      const turns = db.run("delete from agent_turns where workspace_id = ?", ws.id).changes;
      // The repository's snapshots go with the last workspace of it rowrow knows.
      const repo = ws.git?.repoKey;
      const kept = workspaces.list().some((w) => w.id !== ws.id && w.git?.repoKey === repo);
      if (repo !== undefined && !kept)
        await store
          .drop(repo)
          .catch((error: unknown) =>
            log.warn("git.snapshot.drop_failed", { ws: ws.id, err: serializeError(error) }),
          );
      log.info("workspace.git_forgotten", { ws: ws.id, turns, snapshots: repo !== undefined && !kept });
    },

    async changes(workspaceId, scope: DiffScope, agentId?: string): Promise<Changes> {
      const ws = gitWorkspace(workspaceId);
      const turn = scope === "turn" ? turnOf(workspaceId, agentId) : undefined;
      let changes: Changes;
      try {
        changes = await listChanges({
          dir: ws.path,
          scope,
          turnBaseline: turn?.start_tree ?? null,
          turnEnd: turn?.end_tree ?? null,
          defaultBase: baseOf(workspaceId),
          store,
        });
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : String(error));
      }
      if (scope !== "turn") return changes;
      if (turn === undefined)
        return {
          ...changes,
          note: "No turn yet: rowrow snapshots the workspace when a turn starts and ends.",
        };
      if (turn.start_tree === null)
        return { ...changes, note: turn.note ?? "The start of the latest turn wasn't captured." };
      // Say whose turn and when.
      const who = deps.agentTitle(turn.agent_id);
      const span = `${clock(turn.started_at)}–${turn.ended_at === null ? "now" : clock(turn.ended_at)}`;
      return {
        ...changes,
        baseLabel: `${who === null ? "the latest turn" : `${who}'s latest turn`} (${span})`,
      };
    },

    async diff(workspaceId, scope, path, agentId?: string) {
      const ws = gitWorkspace(workspaceId);
      const turn = scope === "turn" ? turnOf(workspaceId, agentId) : undefined;
      try {
        return await fileDiff({
          dir: ws.path,
          scope,
          path,
          turnBaseline: turn?.start_tree ?? null,
          turnEnd: turn?.end_tree ?? null,
          defaultBase: baseOf(workspaceId),
          store,
        });
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : String(error));
      }
    },

    async fileAction(workspaceId, action: FileAction, file: SeenFile) {
      const ws = gitWorkspace(workspaceId);
      return serially(workspaceId, async () => {
        let paths: string[];
        try {
          ({ paths } = await applyFileAction({ dir: ws.path, store, action, file }));
        } catch (error) {
          log.info("git.file_action.refused", {
            ws: workspaceId,
            action,
            reason: error instanceof Error ? error.message : String(error),
          });
          throw asUserError(error);
        }
        log.info("git.file_action", { ws: workspaceId, action, paths });
        return { paths, changes: await afterAction(workspaceId, ws.path, action) };
      });
    },

    async bulkAction(workspaceId, action: BulkAction, files: readonly SeenFile[]) {
      const ws = gitWorkspace(workspaceId);
      return serially(workspaceId, async () => {
        let paths: string[];
        try {
          ({ paths } = await applyBulkAction({ dir: ws.path, store, action, seen: files }));
        } catch (error) {
          log.info("git.file_action.refused", {
            ws: workspaceId,
            action,
            reason: error instanceof Error ? error.message : String(error),
          });
          throw asUserError(error);
        }
        log.info("git.file_action", { ws: workspaceId, action, count: paths.length });
        return { paths, changes: await afterAction(workspaceId, ws.path, action) };
      });
    },

    async log(workspaceId, options) {
      const ws = gitWorkspace(workspaceId);
      try {
        return await listCommits({ dir: ws.path, ...options });
      } catch (error) {
        throw asUserError(error);
      }
    },

    async commit(workspaceId, sha) {
      const ws = gitWorkspace(workspaceId);
      try {
        return await readCommit({ dir: ws.path, sha });
      } catch (error) {
        throw asUserError(error);
      }
    },

    async commitDiff(workspaceId, sha, path) {
      const ws = gitWorkspace(workspaceId);
      try {
        return await commitPatch({ dir: ws.path, sha, path });
      } catch (error) {
        throw asUserError(error);
      }
    },

    async pullRequest(workspaceId, refresh) {
      const ws = gitWorkspace(workspaceId);
      const branch = ws.git.branch;
      const cached = prCache.get(workspaceId);
      const ttl = cached?.value.state === "error" ? PR_ERROR_TTL_MS : PR_TTL_MS;
      if (
        !refresh &&
        cached !== undefined &&
        cached.branch === branch &&
        Date.now() - cached.value.checkedAt < ttl
      )
        return cached.value;
      const running = prInFlight.get(workspaceId);
      if (running !== undefined) return running;
      const started = Date.now();
      const task = pullRequestStatus({ dir: ws.path, ...(deps.gh === undefined ? {} : { gh: deps.gh }) })
        .then((value) => {
          prCache.set(workspaceId, { branch: value.branch, value });
          log[value.state === "error" ? "warn" : "info"]("git.pr.checked", {
            ws: workspaceId,
            state: value.state,
            ...(value.pr === null ? {} : { pr: value.pr.number }),
            ...(value.state === "error" ? { msg: value.message } : {}),
            ms: Date.now() - started,
          });
          return value;
        })
        .finally(() => prInFlight.delete(workspaceId));
      prInFlight.set(workspaceId, task);
      return task;
    },

    async search(workspaceId, query, kind) {
      const ws = gitWorkspace(workspaceId);
      try {
        return await searchWorkspace({ dir: ws.path, query, kind });
      } catch (error) {
        throw asUserError(error);
      }
    },

    async listFiles(workspaceId) {
      const ws = gitWorkspace(workspaceId);
      try {
        return await listWorkspaceFiles({ dir: ws.path });
      } catch (error) {
        throw asUserError(error);
      }
    },

    async readFile(workspaceId, path, rev) {
      const ws = gitWorkspace(workspaceId);
      try {
        return rev === undefined
          ? await readWorkspaceFile({ dir: ws.path, path })
          : await readFileAtCommit({ dir: ws.path, sha: rev, path });
      } catch (error) {
        throw asUserError(error);
      }
    },

    async download(workspaceId, path) {
      const ws = gitWorkspace(workspaceId);
      try {
        return await downloadWorkspacePath({ dir: ws.path, path });
      } catch (error) {
        throw asUserError(error);
      }
    },

    async turnStarted(workspaceId, agentId) {
      const ws = workspaces.get(workspaceId);
      if (ws?.git === null || ws === undefined || ws.missing) return;
      const started = Date.now();
      db.run(
        "insert into agent_turns (agent_id, workspace_id, start_tree, end_tree, started_at, ended_at, note) values (?, ?, null, null, ?, null, ?) on conflict(agent_id) do update set workspace_id = excluded.workspace_id, start_tree = null, end_tree = null, started_at = excluded.started_at, ended_at = null, note = excluded.note",
        agentId,
        workspaceId,
        started,
        "capturing the start of the turn…",
      );
      // A capture that finishes after the turn started may include the agent's own edits:
      // then there is no baseline rather than a wrong one.
      let late = false;
      const capture = (async (): Promise<void> => {
        try {
          const result = await store.capture(ws.path);
          const stillThisTurn =
            db.get<{ started_at: number }>("select started_at from agent_turns where agent_id = ?", agentId)
              ?.started_at === started;
          if (!stillThisTurn) return;
          if (late) {
            db.run(
              "update agent_turns set note = ? where agent_id = ?",
              "The snapshot took too long, so this turn has no baseline.",
              agentId,
            );
            log.warn("turn.snapshot_late", { ws: workspaceId, agent: agentId, ms: Date.now() - started });
          } else if (result.kind === "ok") {
            db.run(
              "update agent_turns set start_tree = ?, note = null where agent_id = ?",
              result.tree,
              agentId,
            );
            log.info("turn.snapshot", {
              ws: workspaceId,
              agent: agentId,
              edge: "start",
              ms: Date.now() - started,
            });
          } else {
            db.run(
              "update agent_turns set note = ? where agent_id = ?",
              `Not captured: ${result.reason}`,
              agentId,
            );
            log.warn("turn.snapshot_refused", { ws: workspaceId, agent: agentId, reason: result.reason });
          }
        } catch (error) {
          log.error("turn.snapshot_failed", { ws: workspaceId, err: serializeError(error) });
        }
      })();
      await Promise.race([
        capture,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            late = true;
            resolve();
          }, CAPTURE_BUDGET_MS).unref(),
        ),
      ]);
    },

    async turnEnded(agentId) {
      const turn = db.get<TurnRow>("select * from agent_turns where agent_id = ?", agentId);
      if (turn === undefined || turn.start_tree === null || turn.ended_at !== null) return;
      const ws = workspaces.get(turn.workspace_id);
      if (ws === undefined || ws.missing) return;
      try {
        const result = await store.capture(ws.path);
        if (result.kind === "ok") {
          db.run(
            "update agent_turns set end_tree = ?, ended_at = ? where agent_id = ? and started_at = ?",
            result.tree,
            Date.now(),
            agentId,
            turn.started_at,
          );
          log.info("turn.snapshot", { ws: turn.workspace_id, agent: agentId, edge: "end" });
        } else {
          db.run(
            "update agent_turns set ended_at = ?, note = ? where agent_id = ? and started_at = ?",
            Date.now(),
            `The end wasn't captured (${result.reason}); comparing with now.`,
            agentId,
            turn.started_at,
          );
        }
      } catch (error) {
        log.error("turn.snapshot_failed", { agent: agentId, err: serializeError(error) });
      }
    },
  };
}

/** A hook isn't the one the caller showed: it doesn't run. */
class HookMismatch extends Error {
  readonly command: string | null;
  constructor(command: string | null) {
    super("the hook changed");
    this.command = command;
  }
}
