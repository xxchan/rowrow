// What the API does with git (docs/git.md for the mechanics): worktrees with the
// repository's hooks, the three diff scopes, and each agent's "last turn": snapshots of
// its workspace when its turn starts and when it ends, so the turn diff is exactly what
// changed during that turn. (Another agent working in the same checkout at the same time
// shows up in it too: files don't know who wrote them.)
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
  /** An agent's title, to say whose turn the "last turn" baseline is. */
  readonly agentTitle: (agentId: string) => string | null;
}

/** How long a turn may wait for its baseline before starting without one. */
const CAPTURE_BUDGET_MS = 5000;

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
