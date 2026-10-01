// rowrow for Mac: the composition root (docs/desktop.md). The app is a window onto rowrow
// servers (this Mac's, SSH hosts', any you can reach) and the manager of the servers it runs
// (D-030, D-032). It keeps running in the menu bar when its windows are closed, for
// notifications; agents run in the servers, so quitting the app stops none of them.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, net, powerMonitor, protocol, safeStorage } from "electron";
import { createBundleSource } from "./bundles.ts";
import { desktopConfig } from "./config.ts";
import { LocalHost } from "./hosts.ts";
import { registerIpc } from "./ipc.ts";
import { createLogger, serializeError } from "./log.ts";
import { appMenu, MenuBar, type MenuActions } from "./menu.ts";
import { Notifications } from "./notifications.ts";
import { LOCAL_ID, ServerStore, type Sealer } from "./servers.ts";
import { Shell } from "./shell.ts";
import { checkOutcome } from "./update-words.ts";
import { Updater } from "./updater.ts";
import { APP_SCHEME, Windows } from "./windows.ts";

process.setSourceMapsEnabled(true);

const config = desktopConfig({
  env: process.env,
  version: app.getVersion(),
  packaged: app.isPackaged,
  resources: process.resourcesPath,
});
if (config.dataDir !== null) {
  app.setPath("userData", config.dataDir);
  app.setAppLogsPath(path.join(config.dataDir, "logs"));
  // Tests of a packaged app, on their own data directory: a keychain of Chromium's that isn't
  // the login keychain, so a test never adds items or prompts there.
  if (process.env["ROWROW_DESKTOP_MOCK_KEYCHAIN"] === "1") app.commandLine.appendSwitch("use-mock-keychain");
}

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// One app at a time: two would both manage this Mac's server and both update themselves.
if (!app.requestSingleInstanceLock()) app.quit();
else void main();

/** What to bring back after the app restarted to update. */
interface Relaunch {
  readonly silent: boolean;
  readonly servers: readonly string[];
}

async function main(): Promise<void> {
  await app.whenReady();
  const log = createLogger(path.join(app.getPath("logs"), "desktop.jsonl"), !app.isPackaged);
  log.info("desktop.starting", {
    version: config.version,
    packaged: config.packaged,
    home: config.home,
    profile: config.profile,
    supervisor: config.supervisor,
    source: config.source?.kind ?? null,
  });
  process.on("uncaughtException", (error) => log.error("desktop.uncaught", { err: serializeError(error) }));
  process.on("unhandledRejection", (error) => log.error("desktop.unhandled", { err: serializeError(error) }));

  // Squirrel replaces the app where it is, and can't on a disk image or a translocated copy.
  if (config.offerMove && !app.isInApplicationsFolder()) {
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: "Move rowrow to the Applications folder?",
      detail: "rowrow keeps itself up to date, which it can do only from the Applications folder.",
      buttons: ["Move to Applications", "Not Now"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      try {
        if (app.moveToApplicationsFolder()) return;
      } catch (error) {
        log.error("desktop.move_failed", { err: serializeError(error) });
      }
    }
  }

  const root = app.getAppPath();
  const uiDir = path.join(root, "ui");
  const appPages = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const file = path.resolve(uiDir, `.${decodeURIComponent(url.pathname)}`);
    if (url.host !== "ui" || !file.startsWith(`${uiDir}${path.sep}`))
      return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  };
  protocol.handle(APP_SCHEME, appPages);

  const plain = !config.packaged && process.env["ROWROW_DESKTOP_PLAIN_TOKENS"] === "1";
  const sealer: Sealer =
    !plain && safeStorage.isEncryptionAvailable()
      ? {
          seal: (text) => safeStorage.encryptString(text).toString("base64"),
          open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, "base64")),
        }
      : { seal: (text) => text, open: (sealed) => sealed };
  const store = new ServerStore(path.join(app.getPath("userData"), "servers.json"), sealer);

  const local =
    config.source === null
      ? null
      : new LocalHost({
          home: config.home,
          source: config.source,
          supervisor: config.supervisor,
          env: {
            ...process.env,
            ...(process.env["ROWROW_HOME"] === undefined ? {} : { ROWROW_HOME: config.home }),
          },
          log,
        });
  const bundles = createBundleSource({
    cacheDir: path.join(app.getPath("userData"), "bundles"),
    localDirs: config.bundleDirs,
    own:
      config.source?.kind === "bundle"
        ? { dir: config.source.dir, target: "darwin-arm64", version: config.version }
        : null,
    releases: "https://github.com/xxchan/rowrow/releases/download",
    fetch: (url) => net.fetch(url),
    log,
  });
  const windows = new Windows({
    preload: path.join(root, "preload.cjs"),
    log,
    version: config.version,
    appPages,
  });
  let shell: Shell | null = null;
  const current = (): Shell => {
    if (shell === null) throw new Error("not started");
    return shell;
  };
  const notifications = new Notifications(
    {
      open: (serverId, url) => void current().open(serverId, url),
      reply: async (serverId, agentId, text) => {
        const client = current().controller(serverId).connection.client;
        if (client === null) throw new Error("not connected");
        await client.agents.send({ agentId, inputId: crypto.randomUUID(), text, mode: "auto" });
      },
      markSeen: async (serverId, agentId, seq) => {
        await current().controller(serverId).connection.client?.agents.markSeen({ agentId, seq });
      },
    },
    log,
  );
  const relaunchFile = path.join(app.getPath("userData"), "relaunch.json");
  let quitting = false;
  const setQuitting = (): void => {
    quitting = true;
    windows.quitting = true;
  };
  const updater = new Updater({
    version: config.version,
    feed: config.updateFeed,
    enabled: config.updates,
    log,
    onChange: () => shell?.changed(),
    beforeInstall: async (silent) => {
      // A host operation cut off halfway could leave a server without its service.
      const deadline = Date.now() + 120_000;
      const busy = (): boolean => shell?.busy === true;
      while (busy() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
      const relaunch: Relaunch = { silent, servers: windows.openServers() };
      fs.writeFileSync(relaunchFile, JSON.stringify(relaunch));
    },
    anyWindowVisible: () => windows.anyVisible(),
    setQuitting,
  });
  shell = new Shell({ config, store, windows, bundles, local, log, notifications, updater: () => updater });
  registerIpc(shell, log, (url) => windows.isServerPage(url));

  const actions: MenuActions = {
    openServer: (id) => void current().open(id),
    newWindow: () => {
      const id = windows.openServers()[0];
      if (id === undefined) void windows.openHosts("/");
      else void windows.openServer(current().controller(id).target(), "/", true);
    },
    openHosts: (route) => void windows.openHosts(route),
    // Asked from the menu: say what the check found, even "nothing newer".
    checkForUpdates: () =>
      void (async () => {
        await updater.check(true);
        const outcome = checkOutcome(updater.view);
        if (outcome !== null) await dialog.showMessageBox({ type: "info", ...outcome });
      })(),
    installUpdate: () => void updater.install(false),
    installCommand: () =>
      void current()
        .installCommand()
        .catch((error: unknown) =>
          dialog.showErrorBox("rowrow", error instanceof Error ? error.message : String(error)),
        ),
    showLogs: () => void current().showLogs(null),
  };
  const menuBar = new MenuBar(path.join(root, "trayTemplate.png"));
  let drawn = "";
  const redraw = (): void => {
    const state = current().state();
    const badge = current().badge();
    // Rebuilt only when what the menus say changed (a download reports progress many times a second).
    const { update } = state;
    const key = JSON.stringify([
      badge,
      state.servers.map((s) => [s.id, s.name, s.status.kind, s.badge]),
      update.state,
      update.version,
      Math.round((update.progress ?? 0) * 20),
    ]);
    if (key === drawn) return;
    drawn = key;
    Menu.setApplicationMenu(appMenu(state, actions));
    menuBar.update(state, badge, actions);
    app.dock?.setBadge(badge > 0 ? String(badge) : "");
  };
  shell.onState(redraw);

  /** A window to show: the servers' first (this Mac's), or the app's own when there are none. */
  const showSomething = (): void => {
    if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible())) return;
    const first = current().servers.find((c) => c.id === LOCAL_ID) ?? current().servers[0];
    if (first === undefined) void windows.openHosts("/");
    else void current().open(first.id);
  };
  app.on("activate", showSomething);
  app.on("second-instance", showSomething);
  // Closed windows leave the app in the menu bar, for notifications.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", setQuitting);
  app.on("will-quit", () => {
    // Nothing of the app's outlives it: tunnels and a development server stop here.
    current().stop();
    local?.stopChild();
    log.info("desktop.quit", { updating: quitting && updater.view.state === "ready" });
  });
  powerMonitor.on("resume", () => {
    for (const controller of current().servers) controller.retry();
  });

  shell.start();
  redraw();
  updater.start();

  let relaunch: Relaunch | null = null;
  try {
    relaunch = JSON.parse(fs.readFileSync(relaunchFile, "utf8")) as Relaunch;
    fs.rmSync(relaunchFile, { force: true });
  } catch {
    // an ordinary start
  }
  if (relaunch?.silent === true || app.getLoginItemSettings().wasOpenedAtLogin) return;
  const again = (relaunch?.servers ?? []).filter((id) => store.get(id) !== null);
  if (again.length > 0) for (const id of again) void current().open(id);
  else showSomething();
}
