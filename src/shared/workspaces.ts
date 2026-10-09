// Archived workspaces (docs/decisions.md, D-047). Archiving a workspace hides it, the linked
// worktrees under it and the agents in all of them, without touching the agents' own archived
// flags: unarchiving brings back exactly what was there. Pure, for the server, the web app and
// the CLI alike.
import type { AgentState, Workspace } from "./schemas.ts";

type Workspaces = Readonly<Record<string, Workspace>>;

/** Archived itself, or a linked worktree of an archived repository: hidden, and nothing starts there. */
export function workspaceArchived(workspaces: Workspaces, id: string): boolean {
  const ws = workspaces[id];
  if (ws === undefined) return false;
  if (ws.archived) return true;
  return ws.parentId !== null && workspaces[ws.parentId]?.archived === true;
}

/** Shown in the agent lists: neither archived itself nor in an archived workspace. */
export function agentListed(workspaces: Workspaces, agent: AgentState): boolean {
  return !agent.summary.archived && !workspaceArchived(workspaces, agent.summary.workspaceId);
}

/** What to call an agent's workspace; one removed from rowrow (D-047) is gone from AppState. */
export function workspaceLabel(workspaces: Workspaces, id: string): string {
  return workspaces[id]?.label ?? "removed workspace";
}

/** A workspace and the linked worktrees registered under it: what removing it removes. */
export function workspaceGroup(workspaces: Workspaces, id: string): Workspace[] {
  const ws = workspaces[id];
  if (ws === undefined) return [];
  return [ws, ...Object.values(workspaces).filter((w) => w.parentId === id)];
}
