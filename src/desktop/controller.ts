// One server in the Mac app: where it is (this Mac, an SSH host behind a tunnel, a URL), the
// host that runs it when the app manages that host, and the live connection. It also brings the
// host's server up to the app's version when the app updated, once no agent is mid-turn
// (docs/desktop.md, "Updates").
import os from "node:os";
import type { Notice } from "../shared/schemas.ts";
import type { HostAction, ServerView } from "./api.ts";
import type { DesktopConfig } from "./config.ts";
import { Connection } from "./connection.ts";
import { HostManager, SshHost, type BundleSource, type Host } from "./hosts.ts";
import { serializeError, type Logger } from "./log.ts";
import { portOf } from "./plan.ts";
import type { ServerRecord, ServerStore } from "./servers.ts";
import { freePort, portOpen, Tunnel } from "./ssh.ts";
import type { ServerWindowTarget, Windows } from "./windows.ts";

const RETRY_UPGRADE_MS = 60_000;

export interface ControllerDeps {
  readonly config: DesktopConfig;
  readonly store: ServerStore;
  readonly windows: Windows;
  readonly bundles: BundleSource;
  /** This Mac, when the app has a server to run here. */
  readonly local: Host | null;
  readonly log: Logger;
  readonly changed: () => void;
  readonly notice: (serverId: string, notice: Notice) => void;
}

/** What this app calls itself in a server's list of devices. */
export function deviceName(): string {
  return `rowrow for Mac (${os.hostname().replace(/\.local$/, "")})`;
}

export class ServerController {
  readonly id: string;
  readonly host: HostManager | null;
  readonly connection: Connection;
  private readonly d: ControllerDeps;
  private tunnel: Tunnel | null = null;
  private step: string | null = null;
  private failure: string | null = null;
  private upgradeTimer: NodeJS.Timeout | null = null;

  constructor(id: string, deps: ControllerDeps) {
    this.id = id;
    this.d = deps;
    const record = this.record;
    const host: Host | null =
      record.kind === "local"
        ? deps.local
        : record.kind === "ssh" && record.destination !== null
          ? new SshHost(record.destination, deps.bundles, deps.log, deps.config.ssh)
          : null;
    this.host =
      host === null
        ? null
        : new HostManager({
            host,
            profile: record.profile,
            appVersion: deps.config.version,
            serveArgs: deps.config.serveArgs,
            background: () => this.record.background,
            setBackground: (on) => {
              if (this.record.background !== on) deps.store.update(id, { background: on });
            },
            onChange: deps.changed,
            onStep: (text) => {
              this.step = text;
              deps.changed();
            },
            log: deps.log,
          });
    this.connection = new Connection({
      id,
      origin: () => this.origin(),
      token: () => this.record.token,
      saveToken: (token) => {
        deps.store.update(id, { token });
        void deps.windows.refresh(this.target(), true);
      },
      mintCode: this.host === null ? null : () => (this.host as HostManager).mintCode(deviceName()),
      redeemInBrowser: (origin, code) => deps.windows.redeemInBrowser(id, origin, code),
      deviceName: deviceName(),
      onStatus: () => deps.changed(),
      onNotice: (notice) => {
        deps.notice(id, notice);
        // An agent finished or was seen: a server upgrade waiting for it may go now.
        if (notice.kind !== "badge" && this.host?.view.upgrade?.state === "waiting") this.upgradeSoon(2_000);
      },
      onOnline: ({ restarted }) => {
        this.failure = null;
        void deps.windows.refresh(this.target(), restarted);
        deps.changed();
        // Not again after a failed upgrade (it rolled back): that waits for Try again, or the next start.
        if (this.host?.plan?.upgrade === true && this.host.view.upgrade?.state !== "failed")
          this.upgradeSoon(0);
      },
      log: deps.log,
    });
  }

  get record(): ServerRecord {
    const record = this.d.store.get(this.id);
    if (record === null) throw new Error(`no server ${this.id}`);
    return record;
  }

  start(): void {
    this.connection.start();
  }

  stop(): void {
    this.connection.stop();
    this.tunnel?.stop();
    this.tunnel = null;
    if (this.upgradeTimer !== null) clearTimeout(this.upgradeTimer);
  }

  retry(): void {
    this.failure = null;
    this.tunnel?.kick();
    this.connection.kick();
  }

  /** What a window needs: where the server is and this app's credential there (null while it's away). */
  target(): ServerWindowTarget {
    const record = this.record;
    return {
      id: this.id,
      name: record.name,
      origin: this.connection.status.kind === "online" ? this.connection.origin : null,
      token: record.token,
    };
  }

  /** Where the server is now: this Mac's from its server.json, an SSH host's through a tunnel. */
  private async origin(): Promise<string> {
    const record = this.record;
    if (record.kind === "url") {
      if (record.url === null) throw new Error("no URL");
      return record.url;
    }
    if (this.host === null)
      throw new Error(`rowrow can't run a server on ${record.kind === "local" ? "this Mac" : "that host"}`);
    const url = await this.host.serverUrl();
    if (record.kind === "local") return url.replace(/\/+$/, "");
    const remote = portOf(url);
    if (remote === null || record.destination === null) throw new Error(`can't tunnel to ${url}`);
    if (this.tunnel !== null && this.tunnel.remote !== remote) {
      this.tunnel.stop();
      this.tunnel = null;
    }
    if (this.tunnel === null) {
      // The same port on this Mac every time, while it's free: the web app keeps what it stores per origin.
      let local = record.localPort;
      if (local === null || (await portOpen(local, 300))) local = await freePort();
      if (local !== record.localPort) this.d.store.update(this.id, { localPort: local });
      this.tunnel = new Tunnel(record.destination, local, remote, this.d.config.ssh);
      this.tunnel.onChange((up, error) => {
        this.d.log.info(up ? "desktop.tunnel.up" : "desktop.tunnel.down", { server: this.id, error });
        if (!up) this.connection.kick();
      });
      this.tunnel.start();
    }
    await this.tunnel.ready();
    return `http://127.0.0.1:${this.tunnel.local}`;
  }

  /** Set the host up (its bundle and a server), then connect. */
  async setUp(): Promise<void> {
    if (this.host === null) return;
    this.failure = null;
    try {
      await this.host.setUp((text) => {
        this.step = text;
        this.d.changed();
      });
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.d.log.error("desktop.host.setup_failed", { server: this.id, err: serializeError(error) });
      throw error;
    } finally {
      this.step = null;
      this.d.changed();
    }
    this.connection.kick();
  }

  /** Agents mid-turn there, through this app's connection (null when it can't ask). */
  private async workingAgents(): Promise<string[] | null> {
    const client = this.connection.client;
    if (client === null) return null;
    try {
      const { state } = await client.state.get();
      return Object.values(state.agents)
        .filter((a) => a.attention === "working" && !a.summary.archived)
        .map((a) => a.summary.title ?? a.id);
    } catch {
      return null;
    }
  }

  private upgradeSoon(delayMs: number): void {
    if (this.upgradeTimer !== null) clearTimeout(this.upgradeTimer);
    this.upgradeTimer = setTimeout(() => {
      this.upgradeTimer = null;
      void this.upgrade(false);
    }, delayMs);
    this.upgradeTimer.unref();
  }

  /** Bring the host's server to the app's version: now, or when no agent is mid-turn. */
  async upgrade(now: boolean): Promise<void> {
    if (this.host === null) return;
    const outcome = await this.host.upgrade(now, () => this.workingAgents());
    if (outcome === "busy" && this.host.view.upgrade?.state !== "failed") this.upgradeSoon(RETRY_UPGRADE_MS);
    // The connection sees the new server by itself; nudge it only if it's waiting out a backoff.
    if (outcome === "done" && this.connection.status.kind !== "online") this.connection.kick();
  }

  async hostAction(action: HostAction): Promise<void> {
    if (this.host === null) return;
    if (action === "upgrade-now") await this.upgrade(true);
    else if (action === "adopt") {
      const outcome = await this.host.adopt();
      if (outcome === "busy") this.upgradeSoon(RETRY_UPGRADE_MS);
    } else if (action === "start" && this.host.plan?.owner === "none") await this.setUp();
    else await this.host.action(action);
    this.connection.kick();
  }

  view(): ServerView {
    const record = this.record;
    const status =
      this.step !== null
        ? { kind: "setting-up" as const, step: this.step }
        : this.failure !== null && this.connection.status.kind !== "online"
          ? { kind: "error" as const, message: this.failure }
          : this.connection.status;
    return {
      id: this.id,
      name: record.name,
      kind: record.kind,
      where:
        record.kind === "local"
          ? "This Mac"
          : record.kind === "ssh"
            ? (record.destination ?? "")
            : (record.url ?? ""),
      status,
      badge: this.connection.status.kind === "online" ? this.connection.badge : null,
      version: this.connection.version ?? this.host?.view.runningVersion ?? null,
      host: this.host?.view ?? null,
      notifications: this.connection.notifications,
    };
  }
}
