// What the new-agent dialog starts with (D-023): the place you opened it from, and the setup
// you last used there.
import { describe, expect, test } from "vitest";
import type { AppState, Workspace } from "../src/shared/schemas.ts";
import { NO_PREFS, parsePrefs, remember, resolveSetup } from "../src/shared/new-agent-setup.ts";

const git = { branch: "main" } as unknown as Workspace["git"];

function workspace(id: string, label: string, extra: Partial<Workspace> = {}): Workspace {
  return {
    id,
    path: `/src/${label}`,
    label,
    customLabel: null,
    parentId: null,
    createdAt: 0,
    archived: false,
    missing: false,
    git,
    ...extra,
  };
}

function state(): AppState {
  const runtime = (id: string, installed = true) => ({
    id,
    name: id,
    installed,
    version: null,
    reason: null,
    test: false,
  });
  const agent = (id: string, workspaceId: string, setup: Record<string, unknown>) => ({
    id,
    seenSeq: 0,
    attention: "idle",
    summary: { workspaceId, archived: false, ...setup },
  });
  return {
    workspaces: {
      ws_web: workspace("ws_web", "web", { git: null }),
      ws_api: workspace("ws_api", "api"),
      ws_tree: workspace("ws_tree", "api-fix", { parentId: "ws_api" }),
      ws_old: workspace("ws_old", "aaa-archived", { archived: true }),
    },
    agents: {
      ag_api: agent("ag_api", "ws_api", {
        runtime: "codex",
        model: "gpt-5",
        effort: "high",
        serviceTier: "priority",
      }),
      ag_tree: agent("ag_tree", "ws_tree", {
        runtime: "claude",
        model: "opus",
        effort: null,
        serviceTier: null,
      }),
    },
    runtimes: { claude: runtime("claude"), codex: runtime("codex"), kimi: runtime("kimi", false) },
  } as unknown as AppState;
}

describe("resolveSetup", () => {
  test("from an agent: its workspace, runtime, model, effort and Fast mode", () => {
    expect(resolveSetup(state(), { kind: "agent", agentId: "ag_api" }, NO_PREFS)).toEqual({
      workspaceId: "ws_api",
      runtime: "codex",
      model: "gpt-5",
      effort: "high",
      serviceTier: "priority",
      isolate: false,
    });
  });

  test("from an agent in a worktree: the repository, in a new worktree", () => {
    expect(resolveSetup(state(), { kind: "agent", agentId: "ag_tree" }, NO_PREFS)).toMatchObject({
      workspaceId: "ws_api",
      runtime: "claude",
      model: "opus",
      isolate: true,
    });
  });

  test("from a workspace: the setup last used there", () => {
    const prefs = remember(NO_PREFS, "ws_api", {
      runtime: "codex",
      model: "o3",
      effort: "low",
      serviceTier: "default",
      isolate: true,
    });
    expect(resolveSetup(state(), { kind: "workspace", workspaceId: "ws_api" }, prefs)).toEqual({
      workspaceId: "ws_api",
      runtime: "codex",
      model: "o3",
      effort: "low",
      serviceTier: "default",
      isolate: true,
    });
  });

  test("from anywhere: the workspace last used, else the first one by name", () => {
    const prefs = remember(NO_PREFS, "ws_web", {
      runtime: "codex",
      model: null,
      effort: null,
      serviceTier: null,
      isolate: false,
    });
    expect(resolveSetup(state(), { kind: "anywhere" }, prefs).workspaceId).toBe("ws_web");
    expect(resolveSetup(state(), { kind: "anywhere" }, NO_PREFS)).toEqual({
      workspaceId: "ws_api",
      runtime: "claude",
      model: null,
      effort: null,
      serviceTier: null,
      isolate: false,
    });
  });

  test("a workspace with no setup yet gets the last runtime used anywhere, with default model", () => {
    const prefs = remember(NO_PREFS, "ws_web", {
      runtime: "codex",
      model: "o3",
      effort: "low",
      serviceTier: "priority",
      isolate: false,
    });
    expect(resolveSetup(state(), { kind: "workspace", workspaceId: "ws_api" }, prefs)).toMatchObject({
      runtime: "codex",
      model: null,
      effort: null,
      serviceTier: null,
    });
  });

  test("what no longer applies falls back to the default", () => {
    // An uninstalled runtime, and a worktree remembered for a directory that isn't a git repository.
    const prefs = {
      ...remember(NO_PREFS, "ws_web", {
        runtime: "kimi",
        model: "k2",
        effort: null,
        serviceTier: null,
        isolate: true,
      }),
      lastRuntime: "kimi",
    };
    expect(resolveSetup(state(), { kind: "workspace", workspaceId: "ws_web" }, prefs)).toEqual({
      workspaceId: "ws_web",
      runtime: "claude",
      model: null,
      effort: null,
      serviceTier: null,
      isolate: false,
    });
    // An archived workspace, or one that's gone, isn't offered.
    expect(resolveSetup(state(), { kind: "workspace", workspaceId: "ws_old" }, NO_PREFS).workspaceId).toBe(
      "ws_api",
    );
    expect(resolveSetup(state(), { kind: "agent", agentId: "ag_gone" }, NO_PREFS).workspaceId).toBe("ws_api");
    // Nor a worktree of an archived repository (D-047).
    const shelved = state();
    const workspaces = { ...shelved.workspaces, ws_api: { ...workspace("ws_api", "api"), archived: true } };
    expect(
      resolveSetup({ ...shelved, workspaces }, { kind: "workspace", workspaceId: "ws_tree" }, NO_PREFS)
        .workspaceId,
    ).toBe("ws_web");
  });

  test("no workspaces and no runtimes: nothing to pick", () => {
    const empty = { workspaces: {}, agents: {}, runtimes: {} } as unknown as AppState;
    expect(resolveSetup(empty, { kind: "anywhere" }, NO_PREFS)).toEqual({
      workspaceId: null,
      runtime: null,
      model: null,
      effort: null,
      serviceTier: null,
      isolate: false,
    });
  });
});

describe("parsePrefs", () => {
  test("round-trips what remember wrote, and keeps the old last-runtime key as a fallback", () => {
    const prefs = remember(NO_PREFS, "ws_api", {
      runtime: "codex",
      model: "o3",
      effort: null,
      serviceTier: "priority",
      isolate: true,
    });
    expect(parsePrefs(JSON.stringify(prefs), "claude")).toEqual(prefs);
    expect(parsePrefs(null, "claude")).toEqual({ ...NO_PREFS, lastRuntime: "claude" });
  });

  test("skips fields of the wrong shape", () => {
    const raw = JSON.stringify({
      lastWorkspaceId: 3,
      workspaces: { a: "x", b: { runtime: 1, isolate: "yes" } },
    });
    expect(parsePrefs(raw, null)).toEqual({
      lastWorkspaceId: null,
      workspaces: { b: { runtime: null, model: null, effort: null, serviceTier: null, isolate: false } },
      lastRuntime: null,
    });
  });

  test("text that isn't JSON throws, for the caller to report", () => {
    expect(() => parsePrefs("{nope", null)).toThrow();
  });
});
