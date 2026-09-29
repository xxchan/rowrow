// Where a profile keeps its data, and the server's options (docs/decisions.md, D-013).
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 7373;

export function rowrowHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["ROWROW_HOME"] ?? path.join(os.homedir(), ".rowrow");
}

export interface ProfilePaths {
  readonly dir: string;
  readonly db: string;
  readonly logs: string;
  readonly worktrees: string;
  readonly snapshots: string;
  readonly uploads: string;
  /** Written while the server runs: its address and a token for the local CLI (mode 0600). */
  readonly serverFile: string;
  readonly vapidFile: string;
}

export function profilePaths(home: string, profile: string): ProfilePaths {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(profile)) {
    throw new Error(`invalid profile name ${JSON.stringify(profile)}: use lowercase letters, digits and dashes`);
  }
  const dir = path.join(home, profile);
  return {
    dir,
    db: path.join(dir, "rowrow.db"),
    logs: path.join(dir, "logs"),
    worktrees: path.join(dir, "worktrees"),
    snapshots: path.join(dir, "snapshots"),
    uploads: path.join(dir, "uploads"),
    serverFile: path.join(dir, "server.json"),
    vapidFile: path.join(dir, "vapid.json"),
  };
}

export interface ServerOptions {
  readonly home: string;
  readonly profile: string;
  /** Interface to listen on. 127.0.0.1 unless you expose the server on purpose. */
  readonly host: string;
  /** 0 picks a free port (tests). */
  readonly port: number;
  readonly tls?: { readonly cert: string; readonly key: string };
  /** The URL people open, when it differs from where the server listens (a proxy, a tunnel, the Vite dev server). */
  readonly publicUrl?: string;
  /** Built web app to serve; nothing is served at / when absent. */
  readonly webDir?: string;
  /** Register the scripted test runtime (no model, no tokens). Never on in the user's profile. */
  readonly testRuntime: boolean;
  /** A live run with no activity for this long is stopped (its conversation resumes on the next input). */
  readonly idleTimeoutMs: number;
  /** Keep oar's installed-runtime probe out of the way (tests that need only the scripted runtime). */
  readonly probeRuntimes: boolean;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
