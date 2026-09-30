// The Mac app updates itself from GitHub Releases (electron-updater, D-031). What decides whether
// an update actually installs is the app's lifecycle, so the rules live here and in main.ts:
//
// - Squirrel.Mac installs only once the app has quit, and it quits only when every window has
//   closed: a window that hides instead of closing, or a page whose beforeunload says "stay",
//   would hold it up forever. So quitting is a flag set on before-quit and on Squirrel's own
//   before-quit-for-update (which comes first on this path), and pages can't cancel it.
// - Nothing the app starts runs from inside the app bundle after the app quits: this Mac's
//   server runs from ROWROW_HOME/versions (D-032), SSH tunnels are /usr/bin/ssh and die with
//   the app. Squirrel swaps the bundle while none of it is in use.
// - A host operation (installing a service, upgrading a server) is never cut off halfway: the
//   update waits for it.
// - A menu-bar app hardly ever quits, so a downloaded update installs by itself when no window
//   is visible and the Mac has been idle, and the app comes back as it was (hidden). Otherwise it
//   waits for "Restart to Update", or installs whenever the app quits.
// - The app must run from /Applications (main.ts offers to move it): Squirrel can't replace an
//   app on a disk image or one macOS translocated.
import { autoUpdater as squirrel, powerMonitor } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateView } from "./api.ts";
import { serializeError, type Logger } from "./log.ts";

const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 4 * 3600_000;
const IDLE_S = 10 * 60;

export interface UpdaterOptions {
  readonly version: string;
  /** A feed to use instead of GitHub Releases (testing updates: a folder with latest-mac.yml). */
  readonly feed: string | null;
  readonly enabled: boolean;
  readonly log: Logger;
  readonly onChange: (view: UpdateView) => void;
  /** Wait for host operations, stop tunnels, remember which windows to bring back. */
  readonly beforeInstall: (silent: boolean) => Promise<void>;
  readonly anyWindowVisible: () => boolean;
  readonly setQuitting: () => void;
}

/** Errors that mean "no update for this Mac here", not that something broke. */
function isNothingToGet(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" ||
    code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" ||
    code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"
  );
}

/** What went wrong, and what to do about it. */
export function explainUpdateError(message: string): string {
  if (/read-only volume|translocat/i.test(message))
    return "rowrow can't update itself where it runs from: move it to the Applications folder, then open it from there.";
  if (/code signature|did not pass validation|not signed/i.test(message))
    return `this build can't update itself (${message}); download the new version from GitHub Releases.`;
  if (/permission|not permitted|EACCES/i.test(message))
    return `rowrow can't replace itself in Applications (${message}): install the new version by hand, or ask whoever installed it.`;
  return message;
}

export class Updater {
  private readonly o: UpdaterOptions;
  private installing = false;
  view: UpdateView;

  constructor(options: UpdaterOptions) {
    this.o = options;
    this.view = {
      current: options.version,
      state: options.enabled ? "idle" : "disabled",
      version: null,
      progress: null,
      error: null,
      checkedAt: null,
    };
  }

  private set(changes: Partial<UpdateView>): void {
    this.view = { ...this.view, ...changes };
    this.o.onChange(this.view);
  }

  start(): void {
    if (!this.o.enabled) return;
    const { log } = this.o;
    autoUpdater.logger = {
      info: (message: unknown) => log.info("desktop.update.updater", { msg: String(message) }),
      warn: (message: unknown) => log.warn("desktop.update.updater", { msg: String(message) }),
      error: (message: unknown) => log.error("desktop.update.updater", { msg: String(message) }),
      debug: (message: unknown) => log.debug("desktop.update.updater", { msg: String(message) }),
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    // A prerelease app follows prereleases (electron-updater sets this from the version, D-025's rule).
    if (this.o.feed !== null) autoUpdater.setFeedURL({ provider: "generic", url: this.o.feed });
    else autoUpdater.setFeedURL({ provider: "github", owner: "xxchan", repo: "rowrow" });

    autoUpdater.on("checking-for-update", () => this.set({ state: "checking", error: null }));
    autoUpdater.on("update-available", (info) => {
      log.info("desktop.update.available", { version: info.version });
      this.set({ state: "downloading", version: info.version, progress: 0 });
    });
    autoUpdater.on("download-progress", (progress) => this.set({ progress: progress.percent / 100 }));
    autoUpdater.on("update-not-available", () =>
      this.set({ state: "idle", version: null, progress: null, checkedAt: Date.now() }),
    );
    // electron-updater has the zip; Squirrel still has to take it (from a local proxy) and check
    // its signature against this app's. Ready is when Squirrel says so.
    autoUpdater.on("update-downloaded", (info) => {
      log.info("desktop.update.downloaded", { version: info.version });
      this.set({ state: "downloading", version: info.version, progress: 1 });
    });
    squirrel.on("update-downloaded", () => {
      log.info("desktop.update.ready", { version: this.view.version });
      this.set({ state: "ready", progress: null, checkedAt: Date.now() });
    });
    autoUpdater.on("error", (error) => {
      if (isNothingToGet(error)) {
        log.info("desktop.update.none", { err: serializeError(error) });
        this.set({ state: "idle", checkedAt: Date.now() });
        return;
      }
      // A failed download is tried again at the next check. Squirrel refusing the update (its
      // signature doesn't match this app's) is said too, instead of a Restart that can't work.
      log.warn("desktop.update.failed", { err: serializeError(error) });
      this.set({ state: "error", error: explainUpdateError(error.message), progress: null });
    });
    // Squirrel's own quit (Restart to Update) closes the windows before before-quit.
    squirrel.on("before-quit-for-update", () => this.o.setQuitting());

    setTimeout(() => void this.check(false), FIRST_CHECK_MS).unref();
    setInterval(() => void this.check(false), EVERY_MS).unref();
    powerMonitor.on("resume", () => {
      if (Date.now() - (this.view.checkedAt ?? 0) > EVERY_MS) void this.check(false);
    });
    // Nobody's looking and the Mac is idle: install now, and come back hidden.
    setInterval(() => {
      if (
        this.view.state === "ready" &&
        !this.o.anyWindowVisible() &&
        powerMonitor.getSystemIdleTime() >= IDLE_S
      )
        void this.install(true);
    }, 5 * 60_000).unref();
  }

  async check(manual: boolean): Promise<void> {
    if (!this.o.enabled || this.view.state === "downloading" || this.view.state === "ready") return;
    this.o.log.info("desktop.update.check", { manual });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // Reported through the error event too; this only keeps a rejected promise quiet.
      this.o.log.debug("desktop.update.check_failed", { err: serializeError(error) });
    }
  }

  /** Quit, install and relaunch; `silent` brings the app back without its windows. */
  async install(silent = false): Promise<void> {
    if (this.view.state !== "ready" || this.installing) return;
    this.installing = true;
    this.o.log.info("desktop.update.installing", { version: this.view.version, silent });
    try {
      await this.o.beforeInstall(silent);
      this.o.setQuitting();
      autoUpdater.quitAndInstall(true, true);
      // Still here a minute later: something kept the app from quitting. Say so in the log.
      setTimeout(() => {
        this.o.log.error("desktop.update.quit_blocked", { version: this.view.version });
        this.installing = false;
      }, 60_000).unref();
    } catch (error) {
      this.installing = false;
      this.o.log.error("desktop.update.install_failed", { err: serializeError(error) });
      this.set({
        state: "error",
        error: explainUpdateError(error instanceof Error ? error.message : String(error)),
      });
    }
  }
}
