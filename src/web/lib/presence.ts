// Tell the server what this window shows and whether you are looking at it (visible and
// focused). The server holds back notifications for what you're looking at; the agent
// page uses the same "looking" signal to mark things seen (docs/decisions.md, D-008).
import { useEffect, useSyncExternalStore } from "react";
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
