// The composition root: the only place that constructs services and wires them together.
// `startServer` is what `rowrow serve` runs, and what integration tests start in-process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS, type HostInfo } from "../shared/schemas.ts";
import { AgentLog } from "./agents/log.ts";
import { Runtimes } from "./agents/runtimes.ts";
import { AgentService } from "./agents/service.ts";
import { createRouter } from "./api/router.ts";
import { startHttp } from "./api/server.ts";
import { pruneUploads } from "./api/uploads.ts";
import { Devices } from "./auth/devices.ts";
import { isLoopback, profilePaths, type ServerOptions } from "./config.ts";
import { prependPath, writeCliLauncher } from "./cli-launcher.ts";
import { Apns } from "./notify/apns.ts";
import { LiveNotices } from "./notify/live.ts";
import { needingYou, Notifier } from "./notify/notifier.ts";
import { Presence } from "./notify/presence.ts";
import { Push } from "./notify/push.ts";
import { augmentPathFromLoginShell } from "./shell-env.ts";
import { SettingsService } from "./settings.ts";
import { StateStore } from "./state/store.ts";
import { Db } from "./store/db.ts";
import { closeLog, log, logFile, serializeError, setupLog } from "./telemetry/log.ts";
import { SnapshotStore } from "./git/snapshots.ts";
import { createGitOps } from "./workspaces/git-ops.ts";
import { Workspaces } from "./workspaces/service.ts";
import { detectInstall, npmRegistry, UpdateChecker } from "./updates.ts";

export interface RunningServer {
  readonly url: string;
  /** What people open: `publicUrl` when set, else `url`. */
  readonly publicUrl: string;
  readonly dataDir: string;
  /** A fresh one-time sign-in link for a browser. */
  loginLink(name?: string): string;
  close(): Promise<void>;
}

export interface ServerFile {
  readonly url: string;
  readonly publicUrl: string;
  readonly pid: number;
  readonly token: string;
  readonly version: string;
  readonly profile: string;
  readonly startedAt: number;
  readonly log: string | null;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function readVersion(): string {
  return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string })
    .version;
}

function oarVersion(): string {
  try {
    const entry = import.meta.resolve("@botiverse/oar");
    let dir = path.dirname(fileURLToPath(entry));
    while (!fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
    return (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string })
      .version;
  } catch {
    return "unknown";
  }
}

export async function startServer(
  options: ServerOptions,
  logConsole: "pretty" | "json" | "off" = "pretty",
): Promise<RunningServer> {
  const paths = profilePaths(options.home, options.profile);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  setupLog({ dir: paths.logs, consoleFormat: logConsole });
  const version = readVersion();
  const startedAt = Date.now();
  log.info("server.starting", {
    version,
    profile: options.profile,
    dataDir: paths.dir,
    pid: process.pid,
    node: process.version,
  });

  const db = new Db(paths.db);
  const devices = new Devices(db);
  const builtins = devices.rotateBuiltins();
  const push = new Push(db, paths.vapidFile);
  const apns = new Apns(db, paths.apnsFile, options.apnsOrigin);
  const live = new LiveNotices();
  const presence = new Presence();
  let url = "";
  let publicUrl = "";
  let updates: UpdateChecker | null = null;
  const install = detectInstall(root, options.profile);
  const host = (): HostInfo => ({
    name: os.hostname(),
    version,
    profile: options.profile,
    pid: process.pid,
    startedAt,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    oar: oarVersion(),
    dataDir: paths.dir,
    url: publicUrl,
    exposed: !isLoopback(options.host),
    pushKey: push.publicKey,
    update: updates?.current ?? null,
    apns: apns.configured,
    updateCheck: {
      via: updates !== null ? "npm" : install.kind === "bundle" ? "mac" : "git",
      ...(updates?.status ?? { checkedAt: null, error: null }),
    },
  });

  const state = new StateStore({
    host: host(),
    workspaces: {},
    agents: {},
    runtimes: {},
    settings: DEFAULT_SETTINGS,
  });
  const settings = new SettingsService(db, state);
  settings.load();
  // A checkout (tests, pnpm dev) runs .ts and updates through git, and a bundle is upgraded by
  // the Mac app that put it there (D-032): they ask only when told where.
  const updateRegistry =
    options.updateRegistry === undefined
      ? import.meta.filename.endsWith(".ts") || install.kind === "bundle"
        ? null
        : npmRegistry()
      : options.updateRegistry;
  if (updateRegistry !== null) {
    const checker = new UpdateChecker({
      current: version,
      install,
      registry: updateRegistry,
      enabled: () => settings.get().checkForUpdates,
      changed: () =>
        state.update("host.update", (draft) => {
          draft.host = host();
        }),
    });
    settings.onChange((keys) => {
      if (keys.includes("checkForUpdates")) void checker.check();
    });
    checker.start();
    updates = checker;
  }
  const runtimes = new Runtimes({ testRuntime: options.testRuntime, probe: options.probeRuntimes });
  const syncRuntimes = (): void => {
    state.update("runtimes", (draft) => {
      draft.runtimes = Object.fromEntries(runtimes.list().map((info) => [info.id, info]));
    });
  };
  syncRuntimes();
  const workspaces = new Workspaces(db, state);
  workspaces.load();
  const agentLog = new AgentLog(db);
  // The agents' `rowrow` is this server's own CLI, whatever else is on the PATH.
  const agentBin = writeCliLauncher(
    paths.bin,
    process.execPath,
    path.join(root, import.meta.filename.endsWith(".ts") ? "src/cli/main.ts" : "lib/cli/main.js"),
  );
  const snapshots = new SnapshotStore(paths.snapshots);
  // Created after the agents, which it needs; the agents reach it only once turns start.
  let git: ReturnType<typeof createGitOps> | null = null;
  const agents = new AgentService({
    db,
    log: agentLog,
    state,
    runtimes,
    workspaces,
    idleTimeoutMs: options.idleTimeoutMs,
    env: (agentId) => ({
      // Read at each run's start: the login shell's PATH may have been added since boot.
      PATH: prependPath(agentBin, process.env["PATH"]),
      ROWROW: "1",
      ROWROW_URL: localUrl(),
      ROWROW_TOKEN: builtins.agentToken,
      ROWROW_AGENT_ID: agentId,
      ROWROW_WORKSPACE_ID: agents.summary(agentId).workspaceId,
      ROWROW_PROFILE: options.profile,
    }),
    turnStarted: async (workspaceId, agentId) => git?.turnStarted(workspaceId, agentId),
    turnEnded: async (agentId) => git?.turnEnded(agentId),
  });
  agents.load();
  git = createGitOps({
    db,
    workspaces,
    store: snapshots,
    worktreesRoot: paths.worktrees,
    stopAgentsIn: async (workspaceId) => agents.stopAllIn(workspaceId),
    agentTitle: (agentId) => (agents.has(agentId) ? agents.summary(agentId).title : null),
    ...(options.gh === undefined ? {} : { gh: options.gh }),
  });
  // Housekeeping: turn snapshots and uploads older than a week go.
  const housekeeping = (): void => {
    void snapshots.prune(7 * 24 * 3600_000).catch(() => undefined);
    pruneUploads(paths.uploads, 7 * 24 * 3600_000);
  };
  housekeeping();
  const pruneTimer = setInterval(housekeeping, 6 * 3600_000);
  pruneTimer.unref();
  const notifier = new Notifier(agents, workspaces, presence, push, apns, live);
  apns.onChange = () =>
    state.update("host", (draft) => {
      draft.host = host();
    });

  const router = createRouter({
    host,
    updates: () => updates,
    state,
    settings,
    workspaces,
    agents,
    agentLog,
    runtimes,
    devices,
    push,
    apns,
    live,
    badge: () => needingYou(agents),
    presence,
    git,
    uploadsDir: paths.uploads,
    loginUrl: (code) => `${publicUrl}/auth/redeem?code=${code}`,
    refreshRuntimes: async () => {
      await runtimes.refresh(syncRuntimes);
    },
  });

  const http = await startHttp({
    router,
    devices,
    presence,
    agentDeviceId: builtins.agentDevice.id,
    host: options.host,
    port: options.port,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    ...(options.webDir === undefined ? {} : { webDir: options.webDir }),
    kitFile: options.kitFile ?? path.join(root, "dist/kit/kit.js"),
    version,
  });
  url = http.url;
  publicUrl = (options.publicUrl ?? url).replace(/\/$/, "");
  const localUrl = (): string => url.replace(/\/\/(0\.0\.0\.0|\[::\])/, "//127.0.0.1");
  state.update("host", (draft) => {
    draft.host = host();
  });

  const serverFile: ServerFile = {
    url: localUrl(),
    publicUrl,
    pid: process.pid,
    token: builtins.cliToken,
    version,
    profile: options.profile,
    startedAt,
    log: logFile(),
  };
  const tmp = `${paths.serverFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serverFile, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, paths.serverFile);

  // Probing runtimes runs each CLI; don't hold up the server for it.
  void (async (): Promise<void> => {
    if (options.probeRuntimes) await augmentPathFromLoginShell();
    await runtimes.refresh(syncRuntimes);
  })().catch((error: unknown) => log.error("runtime.refresh_failed", { err: serializeError(error) }));

  log.info("server.started", { url, publicUrl, ms: Date.now() - startedAt });

  let closing: Promise<void> | null = null;
  return {
    url,
    publicUrl,
    dataDir: paths.dir,
    loginLink: (name) => `${publicUrl}/auth/redeem?code=${devices.createLoginCode(name).code}`,
    close: () => {
      closing ??= (async () => {
        log.info("server.stopping", {});
        notifier.close();
        updates?.stop();
        apns.close();
        clearInterval(pruneTimer);
        workspaces.close();
        await agents.shutdown();
        await http.close();
        try {
          const current = JSON.parse(fs.readFileSync(paths.serverFile, "utf8")) as ServerFile;
          if (current.pid === process.pid) fs.unlinkSync(paths.serverFile);
        } catch {
          // already gone
        }
        db.close();
        log.info("server.stopped", {});
        closeLog();
      })();
      return closing;
    },
  };
}
