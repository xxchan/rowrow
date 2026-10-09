// Archiving and removing workspaces, and what that does to their agents (docs/decisions.md,
// D-047). Archiving hides a workspace, the linked worktrees under it and their agents, and
// stops their runs; the agents' own archived flags stay as they were, so unarchiving brings
// back exactly what was there. Removing makes rowrow forget a workspace and the worktrees
// registered under it: never a file, a checkout or a branch. Their agents are archived (their
// logs are kept), and what rowrow kept about the workspaces goes: turn baselines, snapshots,
// the pull request cache, Coach's permission to read it.
import type { Actor } from "../../shared/entries.ts";
import type { Workspace } from "../../shared/schemas.ts";
import { workspaceGroup } from "../../shared/workspaces.ts";
import type { AgentService } from "../agents/service.ts";
import type { GitOps } from "../api/router.ts";
import { UserError } from "../errors.ts";
import type { SettingsService } from "../settings.ts";
import { log } from "../telemetry/log.ts";
import type { Workspaces } from "./service.ts";

export interface LifecycleDeps {
  readonly workspaces: Workspaces;
  readonly agents: AgentService;
  readonly settings: SettingsService;
  readonly git: Pick<GitOps, "forget">;
}

export class WorkspaceLifecycle {
  private readonly deps: LifecycleDeps;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
  }

  /** Rename, archive or unarchive. Archiving stops the runs of the agents it hides. */
  async update(id: string, changes: { label?: string | null; archived?: boolean }): Promise<Workspace> {
    const { workspaces, agents } = this.deps;
    const before = workspaces.require(id);
    const ws = workspaces.update(id, changes);
    if (changes.archived === true && !before.archived) {
      const group = workspaceGroup(this.state(), id);
      await Promise.all(group.map(async (w) => agents.stopAllIn(w.id, "archived")));
      log.info("workspace.archived", { ws: id, worktrees: group.length - 1 });
    }
    return workspaces.get(id) ?? ws;
  }

  /**
   * Forget a workspace and the linked worktrees registered under it. Refused while one of their
   * agents is working, checked now rather than when you were asked to confirm.
   */
  async remove(id: string, by: Actor): Promise<{ removed: string[]; archived: string[] }> {
    const ws = this.deps.workspaces.require(id);
    const group = workspaceGroup(this.state(), id);
    const ids = new Set(group.map((w) => w.id));
    const working = this.deps.agents
      .list()
      .filter((a) => ids.has(a.summary.workspaceId) && a.summary.status.kind === "running");
    if (working.length > 0) {
      const names = working.map((a) => a.summary.title ?? a.id).join(", ");
      throw new UserError(
        working.length === 1
          ? `an agent is working in ${ws.label} (${names}): stop it or let it finish, then remove the workspace`
          : `${working.length} agents are working in ${ws.label} (${names}): stop them or let them finish, then remove the workspace`,
        "CONFLICT",
      );
    }
    // Gone at once, in the same tick as the check: no agent can start there from now on.
    const archived = await this.forget(group, by, `its workspace was removed from rowrow (${ws.path})`);
    log.info("workspace.removed", {
      ws: id,
      path: ws.path,
      worktrees: group.length - 1,
      agents: archived.length,
    });
    return { removed: group.map((w) => w.id), archived };
  }

  /** After its checkout was deleted (workspaces.removeWorktree): forget it and archive its agents. */
  async worktreeRemoved(id: string, by: Actor): Promise<void> {
    const ws = this.deps.workspaces.get(id);
    if (ws === undefined) return;
    await this.forget([ws], by, `its worktree was removed (${ws.path})`);
  }

  private async forget(group: readonly Workspace[], by: Actor, reason: string): Promise<string[]> {
    const { workspaces, agents, settings, git } = this.deps;
    const ids = new Set(group.map((w) => w.id));
    for (const w of group) workspaces.forget(w.id);
    const allowed = settings.get().coach.workspaces;
    if (allowed.some((w) => ids.has(w)))
      settings.update({ coach: { ...settings.get().coach, workspaces: allowed.filter((w) => !ids.has(w)) } });
    const archived: string[] = [];
    for (const agent of agents.list()) {
      if (!ids.has(agent.summary.workspaceId) || agent.summary.archived) continue;
      // A pinned agent is unpinned: a pin can't hold an agent whose workspace is gone.
      await agents.update(agent.id, { archived: true, pinned: false }, by, reason);
      archived.push(agent.id);
    }
    for (const w of group) await git.forget(w);
    return archived;
  }

  private state(): Record<string, Workspace> {
    return Object.fromEntries(this.deps.workspaces.list().map((w) => [w.id, w]));
  }
}
