// The composition root: the only place that constructs services and wires them together.
// `startServer` is what `rowrow serve` runs, and what integration tests start in-process.
import { REDACTION_RULES, redactRecord } from "@botiverse/oar/observe";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appName, DEFAULT_SETTINGS, type HostInfo } from "../shared/schemas.ts";
import { AgentLog } from "./agents/log.ts";
import { Runtimes } from "./agents/runtimes.ts";
import { AgentService } from "./agents/service.ts";
import { createRouter } from "./api/router.ts";
import { UsageService } from "./usage.ts";
import { startHttp } from "./api/server.ts";
import { pruneUploads } from "./api/uploads.ts";
import { Devices } from "./auth/devices.ts";
import { claudeSettingsFile } from "./coach/claude-settings.ts";
import { CoachService } from "./coach/service.ts";
import { CoachTasks } from "./coach/tasks.ts";
import { CoachTokens } from "./coach/tokens.ts";
import { commandEnv, Commands } from "./commands/service.ts";
import { COACH_ENV } from "./coach/tools.ts";
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
import { WorkspaceLifecycle } from "./workspaces/lifecycle.ts";
import { Workspaces } from "./workspaces/service.ts";
import { detectInstall, npmRegistry, UpdateChecker } from "./updates.ts";

export interface RunningServer {
  readonly url: string;
  /** What people open: `publicUrl` when set, else `url`. */
  readonly publicUrl: string;
  readonly dataDir: string;
  /** A fresh one-time sign-in link for a browser. */
  loginLink(name?: string): string;
  /** The credential the agents it runs get (ROWROW_TOKEN): tests act as an agent with it. */
  readonly agentToken: string;
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
/** Oar records are packed once they are this old (D-041): a live agent's newest stay rows. */
const PACK_AFTER_MS = 2 * 60_000;
const PACK_EVERY_MS = 5 * 60_000;

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
    coach: { chat: null, tasks: [] },
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
  const runtimes = new Runtimes({
    testRuntime: options.testRuntime,
    probe: options.probeRuntimes,
    ...(options.extraRuntimes === undefined ? {} : { extra: options.extraRuntimes }),
    changed: () => syncRuntimes(),
  });
  const syncRuntimes = (): void => {
    state.update("runtimes", (draft) => {
      draft.runtimes = Object.fromEntries(runtimes.list().map((info) => [info.id, info]));
    });
  };
  syncRuntimes();
  const usage = new UsageService({ db, readers: () => runtimes.usageReaders() });
  const workspaces = new Workspaces(db, state);
  workspaces.load();
  // Commands you run in a workspace (D-052): read at each start, like an agent's PATH.
  const commands = new Commands({ workspaces, env: () => commandEnv(process.env, options.profile) });
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
  // Coach's chats are agents (D-044); Coach needs them, they reach it only when a run starts.
  let coach: CoachService | null = null;
  const coachTokens = new CoachTokens();
  const agents = new AgentService({
    db,
    log: agentLog,
    state,
    runtimes,
    workspaces,
    idleTimeoutMs: options.idleTimeoutMs,
    ...(options.stopWaitMs === undefined ? {} : { stopWaitMs: options.stopWaitMs }),
    env: (agentId) =>
      agents.summary(agentId).role === "coach"
        ? {
            // Coach's runtime gets no credential of rowrow's: only its MCP server does, its run's own.
            PATH: prependPath(agentBin, process.env["PATH"]),
            ROWROW: "1",
            ROWROW_URL: "",
            ROWROW_TOKEN: "",
            ROWROW_PROFILE: options.profile,
            ...COACH_ENV[agents.summary(agentId).runtime],
          }
        : {
            // Read at each run's start: the login shell's PATH may have been added since boot.
            PATH: prependPath(agentBin, process.env["PATH"]),
            ROWROW: "1",
            ROWROW_URL: localUrl(),
            ROWROW_TOKEN: builtins.agentToken,
            ROWROW_AGENT_ID: agentId,
            ROWROW_WORKSPACE_ID: agents.summary(agentId).workspaceId,
            ROWROW_PROFILE: options.profile,
          },
    turnStarted: async (workspaceId, agentId) => git?.turnStarted(workspaceId, agentId),
    turnEnded: async (agentId) => git?.turnEnded(agentId),
    coachDir: paths.coach,
    runOptions: async (agentId, runId) => (await coach?.runOptions(agentId, runId)) ?? {},
    promptText: (agentId, inputId, text) => coach?.promptText(agentId, inputId, text) ?? text,
  });
  agents.load();
  git = createGitOps({
    db,
    workspaces,
    store: snapshots,
    worktreesRoot: paths.worktrees,
    // Before its checkout goes: its agents' runs and the commands running there.
    stopAgentsIn: async (workspaceId) => {
      await Promise.all([agents.stopAllIn(workspaceId), commands.stopAllIn(workspaceId)]);
    },
    agentTitle: (agentId) => (agents.has(agentId) ? agents.summary(agentId).title : null),
    agentWorking: (agentId) => agents.has(agentId) && agents.summary(agentId).status.kind === "running",
    ...(options.gh === undefined ? {} : { gh: options.gh }),
  });
  const lifecycle = new WorkspaceLifecycle({ workspaces, agents, commands, settings, git });
  coach = new CoachService({
    agents,
    log: agentLog,
    workspaces,
    settings,
    runtimes,
    git: () => {
      if (git === null) throw new Error("git operations are not ready");
      return git;
    },
    tokens: coachTokens,
    cli: path.join(agentBin, "rowrow"),
    url: () => localUrl(),
    claudeSettings: options.claudeSettings ?? claudeSettingsFile(),
  });
  coach.recover();
  // Housekeeping: turn snapshots and uploads older than a week go.
  const housekeeping = (): void => {
    void snapshots.prune(7 * 24 * 3600_000).catch(() => undefined);
    pruneUploads(paths.uploads, 7 * 24 * 3600_000);
  };
  housekeeping();
  const pruneTimer = setInterval(housekeeping, 6 * 3600_000);
  pruneTimer.unref();
  const notifier = new Notifier(agents, agentLog, workspaces, presence, push, apns, live);
  // Coach's scheduled tasks (D-050): after Coach's recover, which cancelled every preview a
  // run held, so a run the last server left open ends as it should.
  const tasks = new CoachTasks({
    db,
    state,
    agents,
    log: agentLog,
    settings,
    runner: coach,
    deliver: (notice) => {
      void notifier
        .taskNotice(notice)
        .catch((error: unknown) => log.error("notify.task_notice_failed", { err: serializeError(error) }));
    },
  });
  coach.attachTasks(tasks);
  tasks.recover();
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
    lifecycle,
    agents,
    coach,
    tasks,
    agentLog,
    runtimes,
    usage,
    devices,
    push,
    apns,
    live,
    notifier,
    badge: () => needingYou(agents, workspaces),
    presence,
    git,
    commands,
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
    coachTokens,
    host: options.host,
    port: options.port,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    ...(options.webDir === undefined ? {} : { webDir: options.webDir }),
    kitFile: options.kitFile ?? path.join(root, "dist/kit/kit.js"),
    appName: () => (settings.get().instanceName === "" ? null : appName(settings.get().instanceName)),
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
    try {
      if (options.probeRuntimes) await augmentPathFromLoginShell();
      await runtimes.refresh(syncRuntimes);
      // Usage needs to know who's installed and signed in.
      usage.start(0);
    } finally {
      // Coach's tasks run on a runtime: their timer starts once the runtimes are known.
      tasks.start();
    }
  })().catch((error: unknown) => log.error("runtime.refresh_failed", { err: serializeError(error) }));

  // Credentials oar recorded as they came before it redacted them (until oar 0.32.1, grok's MCP
  // notifications carried the env of the user's own MCP servers): rewrite the stored copies.
  // Then, and every few minutes after, pack older oar records (D-041): after the rewrite, so
  // nothing is packed between its reading a record and writing it back.
  let packTimer: NodeJS.Timeout | null = null;
  let packing = false;
  const packLog = async (): Promise<void> => {
    if (packing) return;
    packing = true;
    try {
      const started = Date.now();
      const packed = await agentLog.pack(Date.now() - PACK_AFTER_MS, REDACTION_RULES.version);
      if (packed > 0) log.info("agent_log.packed", { records: packed, ms: Date.now() - started });
    } catch (error) {
      log.error("agent_log.pack_failed", { err: serializeError(error) });
    } finally {
      packing = false;
    }
  };
  void (async (): Promise<void> => {
    const changed = await agentLog.rewriteRecords(REDACTION_RULES, redactRecord);
    if (changed > 0) log.info("agent_log.records_redacted", { changed });
    await packLog();
    packTimer = setInterval(() => void packLog(), PACK_EVERY_MS);
    packTimer.unref();
  })().catch((error: unknown) => log.error("agent_log.redact_failed", { err: serializeError(error) }));

  log.info("server.started", { url, publicUrl, ms: Date.now() - startedAt });

  let closing: Promise<void> | null = null;
  return {
    url,
    publicUrl,
    dataDir: paths.dir,
    loginLink: (name) => `${publicUrl}/auth/redeem?code=${devices.createLoginCode(name).code}`,
    agentToken: builtins.agentToken,
    close: () => {
      closing ??= (async () => {
        log.info("server.stopping", {});
        notifier.close();
        tasks.close();
        updates?.stop();
        usage.stop();
        apns.close();
        clearInterval(pruneTimer);
        if (packTimer !== null) clearInterval(packTimer);
        workspaces.close();
        await Promise.all([agents.shutdown(), commands.close()]);
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
