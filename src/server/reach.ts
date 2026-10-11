// This machine's side of src/shared/reach.ts (D-060): its network interfaces and what Tailscale
// says about it, for `rowrow up` to print and for sign-in links that other devices can open.
import { execFile } from "node:child_process";
import os from "node:os";
import {
  parseTailscaleStatus,
  reachableAddresses,
  TAILSCALE_COMMANDS,
  type Address,
  type Tailnet,
} from "../shared/reach.ts";

/** `tailscale status --json`, from the first Tailscale CLI that answers; null when there's none or it's down. */
export async function tailnetStatus(timeoutMs = 3000): Promise<Tailnet | null> {
  for (const command of TAILSCALE_COMMANDS) {
    const stdout = await new Promise<string | null>((resolve) =>
      execFile(
        command,
        ["status", "--json"],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, out) =>
          // Not installed (ENOENT), or it said no (stopped, logged out: a nonzero exit with JSON or not).
          resolve(error === null || out !== "" ? out : null),
      ),
    );
    if (stdout === null) continue;
    try {
      return parseTailscaleStatus(JSON.parse(stdout));
    } catch {
      return null;
    }
  }
  return null;
}

/** Where other devices can reach a server here on `port`: Tailscale first, then the LAN. */
export async function findAddresses(port: number, https: boolean): Promise<Address[]> {
  return reachableAddresses({
    port,
    https,
    interfaces: os.networkInterfaces(),
    tailnet: await tailnetStatus(),
  });
}

/** The machine's name for people: its hostname without a domain (devbox, not devbox.local). */
export function machineName(): string {
  return os.hostname().split(".")[0] || os.hostname();
}
