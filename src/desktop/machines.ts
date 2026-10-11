// The machines this app knows, as a machine's own page sees them through window.rowrowApp
// (src/shared/app-bridge.ts, D-059): shaped from the app's state, and the page's calls checked,
// here without electron so vitest covers both (ipc.ts wires them up). A page learns what the
// sidebar's switcher and Settings show about the other machines, nothing more: not where they are,
// nothing about their agents but how many need you.
import { z } from "zod";
import type { AppMachine, AppMachines } from "../shared/app-bridge.ts";
import type { ServerStatus, ServerView, ShellState } from "./api.ts";

/** A machine's status in words, as the app's machines page says it (ui/Servers.tsx). */
export function statusText(status: ServerStatus): string {
  switch (status.kind) {
    case "online":
      return "Connected";
    case "connecting":
      return status.detail ?? "Connecting…";
    case "setting-up":
      return status.step;
    case "offline":
    case "signed-out":
      return status.reason;
    case "error":
      return status.message;
  }
}

export function machineOf(server: ServerView): AppMachine {
  const upgrade = server.host?.upgrade ?? null;
  return {
    id: server.id,
    name: server.name,
    kind: server.kind,
    status: server.status.kind,
    statusText: statusText(server.status),
    needsYou: server.status.kind === "online" ? server.badge : null,
    version: server.version,
    upgrade:
      upgrade === null
        ? null
        : {
            version: upgrade.version,
            state: upgrade.state,
            waitingFor: upgrade.waitingFor.length,
            error: upgrade.error,
          },
  };
}

/** What a page in `current`'s window gets (current: null for a window that isn't a machine's). */
export function machinesFor(state: ShellState, current: string | null): AppMachines {
  return {
    current: state.servers.some((server) => server.id === current) ? current : null,
    machines: state.servers.map(machineOf),
  };
}

/** Whether a machine has an upgrade to restart into now: waiting for agents, or failed (try again). */
export function upgradeWaiting(state: ShellState, id: string): boolean {
  const upgrade = state.servers.find((server) => server.id === id)?.host?.upgrade ?? null;
  return upgrade !== null && upgrade.state !== "installing";
}

/** A call from a machine's page, its arguments checked. */
export type ServerPageCall =
  | { readonly method: "update" | "checkForUpdates" | "installUpdate" | "machines" }
  | { readonly method: "openMachine" | "removeMachine" | "upgradeMachine"; readonly id: string }
  | { readonly method: "showMachines"; readonly page: "add" | "manage" };

const id = z.string().min(1).max(100);
const page = z.enum(["add", "manage"]);

export function parseServerPageCall(method: unknown, args: readonly unknown[]): ServerPageCall {
  switch (method) {
    case "update":
    case "checkForUpdates":
    case "installUpdate":
    case "machines":
      return { method };
    case "openMachine":
    case "removeMachine":
    case "upgradeMachine":
      return { method, id: id.parse(args[0]) };
    case "showMachines":
      return { method, page: page.parse(args[0]) };
    default:
      throw new Error(`no method ${String(method)}`);
  }
}

/**
 * Who may call: only the top frame of a page of a machine this app opened (not a frame inside
 * it, not a page it was sent away to). `top` is the sender's main frame.
 */
export function fromServerPage(
  frame: { readonly url: string } | null,
  top: unknown,
  isServerPage: (url: string) => boolean,
): boolean {
  return frame !== null && frame === top && isServerPage(frame.url);
}
