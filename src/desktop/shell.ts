// The Mac app's state and everything you can do with it (docs/desktop.md): the servers, this
// Mac's rowrow, updates, the `rowrow` command. The app's pages call these through IPC, the menus
// and the tray directly; every change is pushed back as one ShellState.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, dialog, shell } from "electron";
import type { Notice } from "../shared/schemas.ts";
import type { DesktopApi, HostAction, LocalFound, ShellState } from "./api.ts";
import { redeemCode } from "./connection.ts";
import { deviceName, ServerController, type ControllerDeps } from "./controller.ts";
import { cliError, type Host } from "./hosts.ts";
import { serializeError } from "./log.ts";
import type { Notifications } from "./notifications.ts";
import { parsePairingLink, planHost } from "./plan.ts";
import { LOCAL_ID } from "./servers.ts";
import { isDestination } from "./ssh.ts";
import { ServiceStatus } from "../shared/host.ts";
import type { Updater } from "./updater.ts";

/** Where `Install the rowrow Command` puts it, as VS Code does with `code`. */
const COMMAND = "/usr/local/bin/rowrow";

export interface ShellDeps extends Omit<ControllerDeps, "changed" | "notice"> {
  readonly notifications: Notifications;
  readonly updater: () => Updater;
}

export class Shell implements Omit<DesktopApi, "onState" | "getState"> {
  private readonly d: ShellDeps;
  private readonly controllers = new Map<string, ServerController>();
  private readonly listeners = new Set<(state: ShellState) => void>();
  private localFound: LocalFound | null = null;
  private emitting = false;

  constructor(deps: ShellDeps) {
    this.d = deps;
  }

  private get deps(): ControllerDeps {
    return { ...this.d, changed: () => this.changed(), notice: (id, notice) => this.onNotice(id, notice) };
  }

  onState(listener: (state: ShellState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Coalesced: many changes in one tick become one push. */
  changed(): void {
    if (this.emitting) return;
    this.emitting = true;
    queueMicrotask(() => {
      this.emitting = false;
      const state = this.state();
      for (const listener of this.listeners) listener(state);
    });
  }

  state(): ShellState {
    return {
      version: this.d.config.version,
      servers: [...this.controllers.values()].map((c) => c.view()),
      update: this.d.updater().view,
      localFound: this.controllers.has(LOCAL_ID) ? null : this.localFound,
      localSupported: this.d.local !== null,
      commandInstalled: commandTarget() === localCommand(this.d.config.home),
      openAtLogin: app.getLoginItemSettings().openAtLogin,
    };
  }

  get servers(): readonly ServerController[] {
    return [...this.controllers.values()];
  }

  controller(id: string): ServerController {
    const controller = this.controllers.get(id);
    if (controller === undefined) throw new Error(`no server ${id}`);
    return controller;
  }

  /** Busy with a host (installing, upgrading): an update waits for it. */
  get busy(): boolean {
    return this.servers.some((c) => c.host?.busy === true);
  }

  start(): void {
    for (const record of this.d.store.list()) this.adopt(record.id).start();
    if (!this.controllers.has(LOCAL_ID)) void this.lookLocally();
    this.changed();
  }

  stop(): void {
    for (const controller of this.controllers.values()) controller.stop();
  }

  /** A controller for a stored server; connecting starts with `start()` (after any setup). */
  private adopt(id: string): ServerController {
    const controller = new ServerController(id, this.deps);
    this.controllers.set(id, controller);
    return controller;
  }

  /** What runs on this Mac already, before it's a server in the app: offered on the welcome page. */
  private async lookLocally(): Promise<void> {
    const local = this.d.local;
    if (local === null) return;
    try {
      await local.ensureBundle(this.d.config.version, () => undefined);
      const result = await local.run(this.d.config.version, [
        "service",
        "status",
        "--json",
        "--profile",
        this.d.config.profile,
      ]);
      if (result.code !== 0) throw new Error(cliError(result));
      const status = ServiceStatus.parse(JSON.parse(result.stdout));
      const plan = planHost(status, this.d.config.version);
      this.localFound =
        plan.owner === "none"
          ? null
          : { owner: plan.owner, version: plan.runningVersion, url: status.server?.url ?? null };
      this.changed();
    } catch (error) {
      this.d.log.warn("desktop.local.look_failed", { err: serializeError(error) });
    }
  }

  /** Whether this app has more than one server: then titles and notifications name the server. */
  get several(): boolean {
    return this.controllers.size > 1;
  }

  private onNotice(serverId: string, notice: Notice): void {
    const several = this.several;
    const name = several ? (this.d.store.get(serverId)?.name ?? null) : null;
    this.d.notifications.notice(serverId, name, notice);
    this.changed();
  }

  /** How many agents need you, over every server: the Dock's badge and the menu bar's count. */
  badge(): number {
    return this.servers.reduce(
      (sum, c) => sum + (c.connection.status.kind === "online" ? (c.connection.badge ?? 0) : 0),
      0,
    );
  }

  // ─── What you can do ──────────────────────────────────────────────────────

  async setUpLocal(): Promise<void> {
    if (this.d.local === null) throw new Error("this build of rowrow has no server for this Mac");
    const existing = this.d.store.get(LOCAL_ID);
    if (existing === null)
      this.d.store.add({
        id: LOCAL_ID,
        name: "This Mac",
        kind: "local",
        profile: this.d.config.profile,
        destination: null,
        url: null,
        localPort: null,
        background: false,
        token: null,
      });
    const controller = this.controllers.get(LOCAL_ID) ?? this.adopt(LOCAL_ID);
    this.changed();
    try {
      await controller.setUp();
    } finally {
      controller.start();
    }
    // Opened on the server itself rather than on "connecting" (it's usually a moment away).
    await controller.connection.whenOnline(15_000);
    await this.open(LOCAL_ID);
  }

  async addSsh(destination: string, name: string | null): Promise<{ id: string }> {
    const dest = destination.trim();
    if (!isDestination(dest))
      throw new Error(`"${dest}" isn't a host ssh takes: use a name from ~/.ssh/config, or user@host`);
    const duplicate = this.d.store.list().find((s) => s.kind === "ssh" && s.destination === dest);
    if (duplicate !== undefined) return { id: duplicate.id };
    const record = this.d.store.add({
      name: name?.trim() || dest,
      kind: "ssh",
      profile: this.d.config.profile,
      destination: dest,
      url: null,
      localPort: null,
      background: false,
      token: null,
    });
    const controller = this.adopt(record.id);
    this.changed();
    void (async () => {
      try {
        await controller.setUp();
        controller.start();
        await controller.connection.whenOnline(30_000);
        await this.open(record.id);
      } catch {
        // The error shows on the server's card, with Retry (which sets it up again).
        controller.start();
      }
    })();
    return { id: record.id };
  }

  async addLink(link: string, name: string | null): Promise<{ id: string }> {
    const parsed = parsePairingLink(link);
    if (parsed === null)
      throw new Error(
        "that isn't a sign-in link: copy one from `rowrow pair`, or from Settings → Pair a device",
      );
    const known = this.d.store.list().find((s) => s.kind === "url" && s.url === parsed.origin);
    const id = known?.id ?? `srv_${Date.now().toString(36)}`;
    const token =
      (await redeemCode(parsed.origin, parsed.code, deviceName())) ??
      (await this.d.windows.redeemInBrowser(id, parsed.origin, parsed.code));
    if (token === null) throw new Error("the server didn't sign this app in");
    let serverName = name?.trim() ?? "";
    if (serverName === "") {
      try {
        const info = (await (
          await fetch(`${parsed.origin}/api/app/info`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: "{}",
          })
        ).json()) as { name?: string };
        serverName = info.name?.replace(/\.local$/, "") ?? new URL(parsed.origin).hostname;
      } catch {
        serverName = new URL(parsed.origin).hostname;
      }
    }
    if (known !== undefined) {
      this.d.store.update(known.id, { token, name: serverName });
      this.controller(known.id).retry();
    } else {
      this.d.store.add({
        id,
        name: serverName,
        kind: "url",
        profile: "default",
        destination: null,
        url: parsed.origin,
        localPort: null,
        background: false,
        token,
      });
      this.adopt(id).start();
    }
    this.changed();
    await this.controller(id).connection.whenOnline(15_000);
    await this.open(id);
    return { id };
  }

  async open(serverId: string, route = "/"): Promise<void> {
    const controller = this.controller(serverId);
    await this.d.windows.openServer(controller.target(), route);
  }

  async remove(serverId: string): Promise<void> {
    const controller = this.controller(serverId);
    const record = controller.record;
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: `Remove ${record.name} from rowrow?`,
      detail:
        record.kind === "url"
          ? "This Mac forgets the server and its sign-in. The server and its agents stay as they are."
          : "This Mac forgets the server and its sign-in. The server keeps running there with its agents; `rowrow service uninstall` on that machine stops it for good.",
      buttons: ["Remove", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
    // Sign this device out there, so the server's list doesn't keep a credential nobody holds.
    const client = controller.connection.client;
    if (client !== null) {
      try {
        const me = await client.devices.whoami();
        await client.devices.revoke({ id: me.id });
      } catch {
        // Unreachable now: the server lists the device until someone revokes it.
      }
    }
    controller.stop();
    this.controllers.delete(serverId);
    this.d.notifications.clearServer(serverId);
    await this.d.windows.forget(serverId);
    this.d.store.remove(serverId);
    if (serverId === LOCAL_ID) void this.lookLocally();
    this.changed();
  }

  async rename(serverId: string, name: string): Promise<void> {
    if (name.trim() === "") return;
    this.d.store.update(serverId, { name: name.trim() });
    this.changed();
  }

  async retry(serverId: string): Promise<void> {
    const controller = this.controller(serverId);
    if (controller.view().status.kind === "error" && controller.host !== null) {
      await controller.setUp();
      return;
    }
    controller.retry();
  }

  async hostAction(serverId: string, action: HostAction): Promise<void> {
    await this.controller(serverId).hostAction(action);
    this.changed();
  }

  async checkForUpdates(): Promise<void> {
    await this.d.updater().check(true);
  }

  async installUpdate(): Promise<void> {
    await this.d.updater().install(false);
  }

  /**
   * /usr/local/bin/rowrow → ROWROW_HOME/bin/rowrow, which `rowrow service install` points at the
   * running bundle's CLI (so the command always matches this Mac's server). Asks for an
   * administrator's password when /usr/local/bin isn't yours, like VS Code's `code` command.
   */
  async installCommand(): Promise<void> {
    const target = localCommand(this.d.config.home);
    if (!fs.existsSync(target)) {
      // No service from a bundle yet: point it at the app's own CLI for now.
      const bundle = path.join(this.d.config.home, "versions", this.d.config.version, "bin", "rowrow");
      if (!fs.existsSync(bundle)) throw new Error("set this Mac up first (Run agents on this Mac)");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(target), bundle), target);
    }
    const current = commandTarget();
    if (current === target) return;
    if (current === null && fs.existsSync(COMMAND)) {
      const { response } = await dialog.showMessageBox({
        type: "question",
        message: `Replace ${COMMAND}?`,
        detail: `Another rowrow is installed there (from npm, perhaps). The command would run this Mac's server's CLI instead.`,
        buttons: ["Replace", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
    }
    try {
      fs.mkdirSync(path.dirname(COMMAND), { recursive: true });
      fs.rmSync(COMMAND, { force: true });
      fs.symlinkSync(target, COMMAND);
    } catch {
      const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
      const script = `mkdir -p /usr/local/bin && ln -sfn ${quoted(target)} ${quoted(COMMAND)}`;
      await new Promise<void>((resolve, reject) =>
        execFile(
          "/usr/bin/osascript",
          ["-e", `do shell script ${JSON.stringify(script)} with administrator privileges`],
          (error) => (error === null ? resolve() : reject(new Error("the rowrow command wasn't installed"))),
        ),
      );
    }
    this.d.log.info("desktop.command.installed", { path: COMMAND, target });
    this.changed();
  }

  async setOpenAtLogin(open: boolean): Promise<void> {
    app.setLoginItemSettings({ openAtLogin: open });
    this.changed();
  }

  async showLogs(serverId: string | null): Promise<void> {
    if (serverId === null || this.d.store.get(serverId)?.kind !== "local") {
      const file = this.d.log.file;
      if (file !== null) shell.showItemInFolder(file);
      return;
    }
    shell.showItemInFolder(path.join(this.d.config.home, this.d.config.profile, "logs", "rowrow.jsonl"));
  }
}

/** ROWROW_HOME/bin/rowrow. */
function localCommand(home: string): string {
  return path.join(home, "bin", "rowrow");
}

/** Where /usr/local/bin/rowrow points, when it's a link. */
function commandTarget(): string | null {
  try {
    return fs.readlinkSync(COMMAND);
  } catch {
    return null;
  }
}

export function macName(): string {
  return os.hostname().replace(/\.local$/, "");
}

export type { Host };
