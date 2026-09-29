// What a new agent starts with, before you change anything: the workspace you're looking at
// and the setup you used there last (docs/decisions.md, D-023). Pure, so it runs in tests;
// the remembered choices are this browser's, read and written by NewAgentDialog.
import type { AppState, Workspace } from "../../shared/schemas.ts";

/** How to start an agent, apart from where and what to say. `null` is the runtime's default. */
export interface AgentSetup {
  readonly runtime: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Start it in a new worktree of the workspace (D-007). */
  readonly isolate: boolean;
}

/** What this browser remembers about starting agents. */
export interface NewAgentPrefs {
  readonly lastWorkspaceId: string | null;
  /** The setup last used in each workspace, keyed by the workspace (not the worktree). */
  readonly workspaces: Readonly<Record<string, AgentSetup>>;
  /** Before per-workspace setups, only the runtime was remembered. */
  readonly lastRuntime: string | null;
}

export const NO_PREFS: NewAgentPrefs = { lastWorkspaceId: null, workspaces: {}, lastRuntime: null };

/** Where the dialog was opened from. */
export type NewAgentContext =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "anywhere" };

export interface ResolvedSetup extends AgentSetup {
  readonly workspaceId: string | null;
}

function usable(state: AppState, id: string | null | undefined): Workspace | null {
  if (id === null || id === undefined) return null;
  const ws = state.workspaces[id];
  return ws === undefined || ws.archived ? null : ws;
}

/**
 * The workspace and setup a new agent starts with:
 * - from an agent: its workspace (the repository, with a new worktree, when it works in one)
 *   and its runtime, model and effort;
 * - from a workspace: that workspace;
 * - from anywhere else: the workspace you last started one in, else the first.
 * The runtime, model, effort and worktree choice come from the last agent you started in that
 * workspace. Anything no longer valid (an uninstalled runtime, a workspace that isn't a git
 * repository) falls back to the default.
 */
export function resolveSetup(state: AppState, context: NewAgentContext, prefs: NewAgentPrefs): ResolvedSetup {
  const installed = Object.values(state.runtimes).filter((r) => r.installed);
  const runtimeOk = (id: string | null | undefined): id is string =>
    id !== null && id !== undefined && installed.some((r) => r.id === id);
  const fallbackRuntime =
    (runtimeOk(prefs.lastRuntime) ? prefs.lastRuntime : null) ??
    installed.find((r) => r.id === "claude")?.id ??
    installed[0]?.id ??
    null;

  let ws: Workspace | null = null;
  let fromAgent: AgentSetup | null = null;
  if (context.kind === "agent") {
    const agent = state.agents[context.agentId];
    const own = usable(state, agent?.summary.workspaceId);
    const parent = usable(state, own?.parentId);
    ws = parent ?? own;
    if (agent !== undefined)
      fromAgent = {
        runtime: agent.summary.runtime,
        model: agent.summary.model,
        effort: agent.summary.effort,
        isolate: parent !== null,
      };
  } else if (context.kind === "workspace") ws = usable(state, context.workspaceId);
  ws ??=
    usable(state, prefs.lastWorkspaceId) ??
    Object.values(state.workspaces)
      .filter((w) => !w.archived && w.parentId === null)
      .sort((a, b) => a.label.localeCompare(b.label))[0] ??
    null;

  const remembered = ws === null ? undefined : prefs.workspaces[ws.id];
  const setup = fromAgent ?? remembered;
  const canIsolate = ws?.git !== null && ws?.git !== undefined;
  if (setup === undefined || !runtimeOk(setup.runtime))
    return {
      workspaceId: ws?.id ?? null,
      runtime: fallbackRuntime,
      model: null,
      effort: null,
      isolate: canIsolate && (setup?.isolate ?? false),
    };
  return {
    workspaceId: ws?.id ?? null,
    runtime: setup.runtime,
    model: setup.model,
    effort: setup.effort,
    isolate: canIsolate && setup.isolate,
  };
}

/** Remember what you just started, for the next agent in the same workspace. */
export function remember(prefs: NewAgentPrefs, workspaceId: string, setup: AgentSetup): NewAgentPrefs {
  return {
    lastWorkspaceId: workspaceId,
    workspaces: { ...prefs.workspaces, [workspaceId]: setup },
    lastRuntime: setup.runtime,
  };
}

/**
 * Read remembered choices from storage, skipping fields of the wrong shape. Throws on text
 * that isn't JSON (the caller reports it and starts over).
 */
export function parsePrefs(raw: string | null, legacyRuntime: string | null): NewAgentPrefs {
  const base: NewAgentPrefs = { ...NO_PREFS, lastRuntime: legacyRuntime };
  if (raw === null) return base;
  const value = JSON.parse(raw) as {
    lastWorkspaceId?: unknown;
    workspaces?: Record<string, Record<string, unknown> | null>;
    lastRuntime?: unknown;
  } | null;
  if (typeof value !== "object" || value === null) return base;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const workspaces: Record<string, AgentSetup> = {};
  for (const [id, s] of Object.entries(value.workspaces ?? {})) {
    if (typeof s !== "object" || s === null) continue;
    workspaces[id] = {
      runtime: str(s.runtime),
      model: str(s.model),
      effort: str(s.effort),
      isolate: s.isolate === true,
    };
  }
  return {
    lastWorkspaceId: str(value.lastWorkspaceId),
    workspaces,
    lastRuntime: str(value.lastRuntime) ?? legacyRuntime,
  };
}
