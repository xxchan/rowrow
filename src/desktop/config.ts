// The Mac app's settings, from where it runs and a few environment variables (docs/desktop.md,
// "Development"). A packaged app needs none of them: it manages the `default` profile in
// ~/.rowrow with launchd, like `rowrow service install`, and updates from GitHub Releases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerSource } from "./hosts.ts";

export interface DesktopConfig {
  readonly version: string;
  /** ROWROW_HOME: shared with the CLI, so both see the same servers and data. */
  readonly home: string;
  /** The profile the app runs on this Mac and on SSH hosts. */
  readonly profile: string;
  readonly supervisor: "service" | "child";
  /** The server this app runs on this Mac; null in a build without one. */
  readonly source: ServerSource | null;
  /** Flags for a service the app installs (development: --test-runtime; a --port for other profiles). */
  readonly serveArgs: readonly string[];
  /** Directories with server bundles to upload to SSH hosts (development). */
  readonly bundleDirs: readonly string[];
  /** The ssh to run (tests: a wrapper with its own config); the system's otherwise. */
  readonly ssh: string;
  /** An update feed instead of GitHub Releases (testing updates). */
  readonly updateFeed: string | null;
  readonly updates: boolean;
  /** Offer to move the app to /Applications (it can update itself only there). */
  readonly offerMove: boolean;
  /** The app's data (servers.json, caches); Electron's userData unless given. */
  readonly dataDir: string | null;
  readonly packaged: boolean;
}

export function desktopConfig(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
  readonly packaged: boolean;
  /** The packaged app's Resources directory. */
  readonly resources: string;
}): DesktopConfig {
  const { env, packaged } = options;
  const home = env["ROWROW_HOME"] ?? path.join(os.homedir(), ".rowrow");
  const profile = env["ROWROW_DESKTOP_PROFILE"] ?? "default";
  const given = env["ROWROW_DESKTOP_SERVER"];
  const bundled = path.join(options.resources, "server");
  let source: ServerSource | null = null;
  if (given !== undefined && given !== "") {
    const dir = path.resolve(given);
    source = fs.existsSync(path.join(dir, "src", "cli", "main.ts"))
      ? { kind: "checkout", dir, node: env["ROWROW_DESKTOP_NODE"] ?? "node" }
      : { kind: "bundle", dir };
  } else if (packaged && fs.existsSync(path.join(bundled, "bin", "rowrow")))
    source = { kind: "bundle", dir: bundled };
  const port = env["ROWROW_DESKTOP_PORT"];
  const feed = env["ROWROW_DESKTOP_UPDATE_URL"] ?? null;
  return {
    version: options.version,
    home,
    profile,
    supervisor: env["ROWROW_DESKTOP_SUPERVISOR"] === "child" ? "child" : "service",
    source,
    serveArgs: [
      ...(port === undefined ? [] : ["--port", port]),
      ...(env["ROWROW_DESKTOP_TEST_RUNTIME"] === "1" ? ["--test-runtime"] : []),
    ],
    bundleDirs: (env["ROWROW_DESKTOP_BUNDLES"] ?? "").split(path.delimiter).filter((dir) => dir !== ""),
    ssh: env["ROWROW_DESKTOP_SSH"] ?? "ssh",
    updateFeed: feed,
    updates: packaged || feed !== null,
    offerMove: packaged && env["ROWROW_DESKTOP_NO_MOVE"] !== "1",
    dataDir: env["ROWROW_DESKTOP_USER_DATA"] ?? null,
    packaged,
  };
}
