// What the API does with git (docs/git.md for the mechanics): worktrees with the
// repository's hooks, the three diff scopes, and the "last turn" baseline, a snapshot
// taken when a workspace goes from quiet to active (an agent's turn starts while no other
// agent there is working).
import type { Changes, DiffScope, Workspace } from "../../shared/schemas.ts";
import type { GitOps } from "../api/router.ts";
import { UserError } from "../errors.ts";
import { fileDiff, listChanges } from "../git/changes.ts";
import { resolveHooks, runHook, type HookEvent, type HookRun } from "../git/hooks.ts";
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
}

/** How long a turn may wait for its baseline before starting without one. */
const CAPTURE_BUDGET_MS = 5000;

export function createGitOps(
  deps: GitOpsDeps,
): GitOps & { snapshotTurn(workspaceId: string, agentId: string): Promise<void> } {
  const { db, workspaces, store } = deps;

  const gitWorkspace = (id: string): Workspace & { git: NonNullable<Workspace["git"]> } => {
    const ws = workspaces.require(id);
    if (ws.git === null) throw new UserError(`${ws.label} is not a git repository`);
    if (ws.missing) throw new UserError(`${ws.path} no longer exists`);
    return ws as Workspace & { git: NonNullable<Workspace["git"]> };
  };

  const baseOf = (id: string): string | null =>
    db.get<{ base: string | null }>("select base from workspaces where id = ?", id)?.base ?? null;
  const baselineOf = (id: string): string | null =>
    db.get<{ tree: string }>("select tree from turn_snapshots where workspace_id = ?", id)?.tree ?? null;

  const hook = async (
    event: HookEvent,
    target: string,
    source: string,
    cwd: string,
  ): Promise<HookRun | null> => {
    const config = await resolveHooks({ target, source });
    const command = config?.worktree[event];
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
      let created;
      try {
        created = await createWorktree({
          repoDir: source.path,
          root: deps.worktreesRoot,
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(options.base === undefined ? {} : { base: options.base }),
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
      const setup = await hook("setup", created.path, source.path, created.path);
      return {
        workspace: workspaces.get(ws.id) ?? ws,
        hook: setup === null ? null : { ran: true, ok: setup.ok, output: setup.output },
      };
    },

    async removeWorktree(workspaceId, force) {
      const ws = gitWorkspace(workspaceId);
      if (!ws.git.linked)
        throw new UserError(
          `${ws.label} is a repository's main checkout, not a worktree; only worktrees can be removed`,
        );
      const parent = ws.parentId === null ? undefined : workspaces.get(ws.parentId);
      const source = parent?.path ?? (await listWorktrees(ws.path))[0]?.path ?? ws.git.repoRoot;
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
      workspaces.update(workspaceId, { archived: true });
      void workspaces.refresh(workspaceId).catch(() => undefined);
      log.info("worktree.removed", { ws: workspaceId, force });
    },

    async changes(workspaceId, scope: DiffScope): Promise<Changes> {
      const ws = gitWorkspace(workspaceId);
      try {
        return await listChanges({
          dir: ws.path,
          scope,
          turnBaseline: baselineOf(workspaceId),
          defaultBase: baseOf(workspaceId),
          store,
        });
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : String(error));
      }
    },

    async diff(workspaceId, scope, path) {
      const ws = gitWorkspace(workspaceId);
      try {
        return await fileDiff({
          dir: ws.path,
          scope,
          path,
          turnBaseline: baselineOf(workspaceId),
          defaultBase: baseOf(workspaceId),
          store,
        });
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : String(error));
      }
    },

    /** Record the "last turn" baseline for a workspace. Never throws; never waits past its budget. */
    async snapshotTurn(workspaceId, agentId) {
      const ws = workspaces.get(workspaceId);
      if (ws?.git === null || ws === undefined || ws.missing) return;
      const started = Date.now();
      // A capture that finishes after the turn started may include the agent's own edits:
      // then there is no baseline rather than a wrong one.
      let late = false;
      const capture = (async (): Promise<void> => {
        try {
          const result = await store.capture(ws.path);
          if (late) {
            db.run("delete from turn_snapshots where workspace_id = ?", workspaceId);
            log.warn("turn.snapshot_late", { ws: workspaceId, agent: agentId, ms: Date.now() - started });
          } else if (result.kind === "ok") {
            db.run(
              "insert into turn_snapshots (workspace_id, tree, agent_id, taken_at) values (?, ?, ?, ?) on conflict(workspace_id) do update set tree = excluded.tree, agent_id = excluded.agent_id, taken_at = excluded.taken_at",
              workspaceId,
              result.tree,
              agentId,
              result.at,
            );
            log.info("turn.snapshot", { ws: workspaceId, agent: agentId, ms: Date.now() - started });
          } else {
            db.run("delete from turn_snapshots where workspace_id = ?", workspaceId);
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
  };
}
