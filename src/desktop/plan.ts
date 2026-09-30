// How the Mac app reads a host (D-032): given what the host's `rowrow service status --json`
// says, who runs the server there, and what the app may do about it. Pure, so the rules are
// tested without a service manager.
//
// The rules: one service per profile, whoever installed it last. The app upgrades only a
// service that runs one of its bundles; one installed from npm, pnpm or a checkout is yours
// (the app connects to it and says whose it is); a server in a terminal is left alone. The
// app never downgrades: a newer server than its own is simply used.
import type { HostOwner } from "./api.ts";
import type { ServiceStatus } from "../shared/host.ts";
import { compareVersions, isVersion } from "../shared/versions.ts";

export interface HostPlan {
  readonly owner: HostOwner;
  /** The version of the server that runs now (or of what the service would run). */
  readonly runningVersion: string | null;
  /** The app's version should replace what the service runs. */
  readonly upgrade: boolean;
  /** A server is up: the app can connect. */
  readonly running: boolean;
}

export function planHost(status: ServiceStatus, appVersion: string, background = false): HostPlan {
  const owner: HostOwner =
    status.install?.kind === "bundle"
      ? "app"
      : status.installed
        ? "cli"
        : status.server !== null
          ? background
            ? "background"
            : "terminal"
          : "none";
  const runningVersion = status.server?.version ?? status.install?.version ?? null;
  // What would run after a restart: the service's bundle, or what the app started in the background.
  const ours =
    owner === "app" ? (status.install?.version ?? null) : owner === "background" ? runningVersion : null;
  return {
    owner,
    runningVersion,
    upgrade: ours !== null && isVersion(ours) && compareVersions(ours, appVersion) < 0,
    running: status.server !== null,
  };
}

/**
 * Which bundles in ROWROW_HOME/versions to keep: the app's, the one the service runs, and the
 * newest one older than both (to go back to). Anything not named like a version is not ours.
 */
export function versionsToKeep(
  installed: readonly string[],
  appVersion: string,
  running: string | null,
): Set<string> {
  const keep = new Set([appVersion, ...(running === null ? [] : [running])]);
  const oldest = [...keep].sort(compareVersions)[0] ?? appVersion;
  const previous = installed
    .filter((v) => isVersion(v) && compareVersions(v, oldest) < 0)
    .sort(compareVersions)
    .at(-1);
  if (previous !== undefined) keep.add(previous);
  for (const v of installed) if (!isVersion(v)) keep.add(v);
  return keep;
}

/** The port a server's URL listens on (a tunnel forwards to it). */
export function portOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * A sign-in link (`rowrow pair`, Pair a device): the server's origin and the one-time code.
 * Also takes the iOS app's rowrow://pair?link=… form.
 */
export function parsePairingLink(text: string): { origin: string; code: string } | null {
  let value = text.trim();
  try {
    const wrapped = new URL(value);
    if (wrapped.protocol === "rowrow:") value = wrapped.searchParams.get("link") ?? "";
    const url = new URL(value);
    const code = url.searchParams.get("code");
    if ((url.protocol !== "http:" && url.protocol !== "https:") || code === null || code === "") return null;
    if (url.pathname.replace(/\/+$/, "") !== "/auth/redeem") return null;
    return { origin: url.origin, code };
  } catch {
    return null;
  }
}
