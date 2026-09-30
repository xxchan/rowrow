// How a copy of rowrow got onto this machine, told from where its package lives. It decides
// who updates it (npm, pnpm, a git pull, or the Mac app for a bundle, D-032), and the Mac app
// reads it from `rowrow service status --json` to know whether the service is its own to
// upgrade.
import fs from "node:fs";
import path from "node:path";
import type { Install, InstallKind } from "../shared/host.ts";
import { versionsDir } from "./config.ts";

export type { Install, InstallKind };

/**
 * The kind of the package at `root`, for a ROWROW_HOME at `home`: npm (anything in a
 * node_modules), pnpm, npx (npm's cache, cleared now and then), bundle (in <home>/versions,
 * put there by the Mac app), checkout (a git checkout running src/).
 */
export function installKind(root: string, home: string): InstallKind {
  const posix = root.split(path.sep).join("/");
  const versions = versionsDir(home).split(path.sep).join("/");
  if (path.dirname(posix) === versions) return "bundle";
  if (posix.includes("/_npx/")) return "npx";
  if (posix.includes("/node_modules/")) return posix.includes("/pnpm/") ? "pnpm" : "npm";
  if (fs.existsSync(path.join(root, "src", "cli", "main.ts"))) return "checkout";
  return "npm";
}

/** The version in a package's package.json, or null. */
export function packageVersion(root: string): string | null {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * What a service runs, from its command (node, the CLI's main, serve…): the CLI is
 * <root>/lib/cli/main.js in a package or bundle, <root>/src/cli/main.ts in a checkout.
 */
export function installOfCommand(command: readonly string[], home: string): Install | null {
  const main = command[1];
  if (main === undefined || !/[\\/](lib|src)[\\/]cli[\\/]main\.(js|ts)$/.test(main)) return null;
  const root = path.dirname(path.dirname(path.dirname(main)));
  return { kind: installKind(root, home), root, version: packageVersion(root) };
}
