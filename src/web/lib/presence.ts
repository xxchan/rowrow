// Tell the server what this window shows and whether you are looking at it (visible and
// focused). The server holds back notifications for what you're looking at; the agent
// page uses the same "looking" signal to mark things seen (docs/decisions.md, D-008).
import { useEffect, useSyncExternalStore } from "react";
import type { AgentState, AppState } from "../../shared/schemas.ts";
import type { Route } from "./router.ts";
import { useClient } from "./store.ts";
import { report } from "./telemetry.ts";

function subscribeLooking(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

function lookingNow(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** True while this page is visible in a focused window. */
export function useLooking(): boolean {
  return useSyncExternalStore(subscribeLooking, lookingNow);
}

/**
 * The agent this window shows while you look at it, or null. Its page marks what it shows seen
 * (D-008), but only once the entries arrive and the server answers, so a turn that ends in front
 * of you reads `done` for that moment: in the side nav it popped into Needs you, sliding the
 * workspaces down, then left again. Shown through `seenHere`, it is seen at once.
 */
export function useLookingAt(route: Route): string | null {
  const looking = useLooking();
  return looking && route.name === "agent" ? route.agentId : null;
}

/** An agent as the window looking at it shows it: what it finished is seen. */
export function seen(agent: AgentState): AgentState {
  return agent.attention === "done" ? { ...agent, attention: "idle" } : agent;
}

/** `state` with the agent you're looking at (`useLookingAt`) seen; the same object when that changes nothing. */
export function seenHere(state: AppState, agentId: string | null): AppState {
  const agent = agentId === null ? undefined : state.agents[agentId];
  if (agent === undefined || agent.attention !== "done") return state;
  return { ...state, agents: { ...state.agents, [agent.id]: seen(agent) } };
}

export function usePresence(route: Route): void {
  const client = useClient();
  const looking = useLooking();
  const visible = useSyncExternalStore(subscribeLooking, () => document.visibilityState === "visible");
  const agentId = route.name === "agent" ? route.agentId : null;
  useEffect(() => {
    if (client === null) return;
    client.presence
      .update({ route: location.pathname, agentId, visible, focused: looking })
      .catch((error: unknown) => report("warn", "presence.failed", error));
  }, [client, agentId, visible, looking]);
}
