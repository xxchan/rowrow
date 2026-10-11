// rowrow for Mac, when this page runs inside it: `window.rowrowApp` (src/shared/app-bridge.ts),
// with the app's updater and the machines it knows (D-059). In a browser it isn't there, and an
// app older than this page may have the updater only.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { AppBridge, AppMachine, AppMachines } from "../../shared/app-bridge.ts";
import type { Tone } from "./format.ts";
import { report } from "./telemetry.ts";

export function appBridge(): AppBridge | null {
  return (globalThis as { rowrowApp?: AppBridge }).rowrowApp ?? null;
}

export type MachinesBridge = AppBridge &
  Required<
    Pick<
      AppBridge,
      "machines" | "onMachines" | "openMachine" | "showMachines" | "removeMachine" | "upgradeMachine"
    >
  >;

function hasMachines(bridge: AppBridge): bridge is MachinesBridge {
  return (
    typeof bridge.machines === "function" &&
    typeof bridge.onMachines === "function" &&
    typeof bridge.openMachine === "function" &&
    typeof bridge.showMachines === "function" &&
    typeof bridge.removeMachine === "function" &&
    typeof bridge.upgradeMachine === "function"
  );
}

export function machinesBridge(): MachinesBridge | null {
  const bridge = appBridge();
  return bridge !== null && hasMachines(bridge) ? bridge : null;
}

/** The machines the app knows, kept current; null outside the app (machines: null until they come). */
export function useMachines(): { bridge: MachinesBridge; list: AppMachines | null } | null {
  const bridge = machinesBridge();
  const [list, setList] = useState<AppMachines | null>(null);
  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    const off = bridge.onMachines((next) => live && setList(next));
    bridge
      .machines()
      .then((first) => live && setList((current) => current ?? first))
      .catch((error: unknown) => report("warn", "mac_app.machines_failed", error));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return bridge === null ? null : { bridge, list };
}

/** Ask the app; a failure becomes a toast saying what went wrong. */
export function askApp(what: string, action: () => Promise<void>): void {
  void action().catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    // Without Electron's "Error invoking remote method…" wrapping.
    toast.error(`${what} failed`, {
      description: text.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""),
    });
    report("warn", "mac_app.action_failed", error, { action: what });
  });
}

/** A machine's connection as a dot's tone (the app's machines page uses the same colors). */
export function machineTone(machine: AppMachine): Tone {
  switch (machine.status) {
    case "online":
      return "success";
    case "connecting":
      return "warning";
    case "setting-up":
      return "accent";
    case "offline":
      return "neutral";
    case "signed-out":
    case "error":
      return "error";
  }
}

/** "2 need you", or the status in words when there's nobody waiting there. */
export function machineWords(machine: AppMachine): string {
  if (machine.needsYou !== null && machine.needsYou > 0)
    return `${machine.needsYou} need${machine.needsYou === 1 ? "s" : ""} you`;
  return machine.statusText;
}
