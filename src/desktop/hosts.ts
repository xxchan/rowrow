// The machines the Mac app runs a rowrow server on (docs/desktop.md, D-032): this Mac, and
// hosts over SSH. The app installs a server bundle there (ROWROW_HOME/versions/<version>) and
// then does everything through that bundle's own CLI, exactly the commands you would type:
// `rowrow service status|install|start|stop|restart`, `rowrow pair`. So the app and the CLI
// agree on one service per profile by construction, on this Mac and over SSH alike.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { InstallOutcome, ServiceStatus, type RunningServer } from "../shared/host.ts";
import { compareVersions, isVersion } from "../shared/versions.ts";
import type { HostAction, HostView } from "./api.ts";
import { serializeError, type Logger } from "./log.ts";
import { planHost, versionsToKeep, type HostPlan } from "./plan.ts";
import {
  backgroundScript,
  cliScript,
  explainSshFailure,
  parseProbe,
  placeBundleScript,
  prepareUploadScript,
  PROBE,
  removeVersionsScript,
  runProcess,
  scriptArgs,
  targetOf,
  untarArgs,
  type BundleTarget,
  type Probe,
  type Run,
} from "./ssh.ts";

/** A machine the app runs rowrow's CLI on. */
export interface Host {
  /** For messages: "this Mac", or the SSH destination. */
  readonly label: string;
  /** Make sure the bundle of `version` is installed there. */
  ensureBundle(version: string, step: (text: string) => void): Promise<void>;
  /** The CLI of `version` there, with `args`. */
  run(version: string, args: readonly string[], timeoutMs?: number): Promise<Run>;
  /** Start `rowrow serve` without a service manager (the host has none). */
  startBackground(version: string, profile: string, serveArgs: readonly string[]): Promise<void>;
  /** Stop a process (a server started in the background). */
  kill(pid: number): Promise<void>;
  /** Bundles installed there, by version. */
  versions(): Promise<string[]>;
  removeVersions(versions: readonly string[]): Promise<void>;
}

const execFileAsync = (file: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) =>
    execFile(file, args, (error) => (error === null ? resolve() : reject(error))),
  );

/** The app's own server: a bundle (the packaged app's Resources/server), or a checkout while developing. */
export type ServerSource =
  | { readonly kind: "bundle"; readonly dir: string }
  | { readonly kind: "checkout"; readonly dir: string; readonly node: string };

// ─── This Mac ────────────────────────────────────────────────────────────────

export interface LocalHostOptions {
  /** ROWROW_HOME. */
  readonly home: string;
  readonly source: ServerSource;
  /**
   * service: launchd, through the CLI. child: `rowrow serve` as the app's own child process,
   * for development and tests, so nothing touches this Mac's launchd or your real service.
   */
  readonly supervisor: "service" | "child";
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
}

export class LocalHost implements Host {
  readonly label = "this Mac";
  private readonly options: LocalHostOptions;
  private child: { process: ChildProcess; version: string; profile: string } | null = null;
  /** Installs under way, by version: two callers wait for the same one. */
  private readonly installing = new Map<string, Promise<void>>();

  constructor(options: LocalHostOptions) {
    this.options = options;
  }

  private get versionsDir(): string {
    return path.join(this.options.home, "versions");
  }

  async ensureBundle(version: string, step: (text: string) => void): Promise<void> {
    const { source } = this.options;
    if (source.kind === "checkout") return;
    if (fs.existsSync(path.join(this.versionsDir, version, "bin", "rowrow"))) return;
    const running = this.installing.get(version);
    if (running !== undefined) return running;
    step(`Installing rowrow ${version}'s server on this Mac`);
    const install = this.install(source.dir, version).finally(() => this.installing.delete(version));
    this.installing.set(version, install);
    return install;
  }

  private async install(dir: string, version: string): Promise<void> {
    const { log } = this.options;
    const target = path.join(this.versionsDir, version);
    const started = Date.now();
    fs.mkdirSync(this.versionsDir, { recursive: true });
    const tmp = path.join(this.versionsDir, `.install.${process.pid}.${Date.now()}`);
    // A clone on APFS: instant, and no extra space. The app bundle is never run from, because an
    // update replaces it while the service keeps running (D-032).
    try {
      await execFileAsync("/bin/cp", ["-cR", dir, tmp]);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true });
      await execFileAsync("/bin/cp", ["-R", dir, tmp]);
    }
    // Copied from a downloaded app: nothing here should be treated as freshly downloaded.
    await execFileAsync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", tmp]).catch(() => undefined);
    try {
      fs.renameSync(tmp, target);
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!fs.existsSync(path.join(target, "bin", "rowrow"))) throw error;
    }
    log.info("desktop.bundle.installed", { version, dir: target, ms: Date.now() - started });
  }

  async run(version: string, args: readonly string[], timeoutMs = 60_000): Promise<Run> {
    if (this.options.supervisor === "child" && args[0] === "service")
      return this.childService(version, args.slice(1));
    const { source, env } = this.options;
    return source.kind === "checkout"
      ? runProcess(source.node, [path.join(source.dir, "src", "cli", "main.ts"), ...args], { env, timeoutMs })
      : runProcess(path.join(this.versionsDir, version, "bin", "rowrow"), args, { env, timeoutMs });
  }

  async startBackground(version: string, profile: string, serveArgs: readonly string[]): Promise<void> {
    await this.spawnChild(version, profile, serveArgs);
  }

  async kill(pid: number): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }

  async versions(): Promise<string[]> {
    try {
      return fs
        .readdirSync(this.versionsDir)
        .filter(
          (name) =>
            !name.startsWith(".") && fs.existsSync(path.join(this.versionsDir, name, "bin", "rowrow")),
        );
    } catch {
      return [];
    }
  }

  async removeVersions(versions: readonly string[]): Promise<void> {
    for (const version of versions) {
      if (!/^[0-9A-Za-z.+-]+$/.test(version)) continue;
      fs.rmSync(path.join(this.versionsDir, version), { recursive: true, force: true });
      this.options.log.info("desktop.bundle.removed", { version });
    }
  }

  /** The development server, if the app started one; stopped when the app quits. */
  stopChild(): void {
    this.child?.process.kill("SIGTERM");
    this.child = null;
  }

  private serverFile(profile: string): RunningServer | null {
    try {
      const info = JSON.parse(
        fs.readFileSync(path.join(this.options.home, profile, "server.json"), "utf8"),
      ) as RunningServer;
      process.kill(info.pid, 0);
      return info;
    } catch {
      return null;
    }
  }

  private async spawnChild(
    version: string,
    profile: string,
    serveArgs: readonly string[],
  ): Promise<RunningServer> {
    const { source, env, log } = this.options;
    const args = ["serve", "--profile", profile, ...serveArgs];
    const since = Date.now();
    const child =
      source.kind === "checkout"
        ? spawn(source.node, [path.join(source.dir, "src", "cli", "main.ts"), ...args], {
            env,
            stdio: ["ignore", "ignore", "pipe"],
          })
        : spawn(path.join(this.versionsDir, version, "bin", "rowrow"), args, {
            env,
            stdio: ["ignore", "ignore", "pipe"],
          });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    child.on("exit", (code) => {
      log.info("desktop.child.exited", { code, stderr: stderr.slice(-500) });
      if (this.child?.process === child) this.child = null;
    });
    this.child = { process: child, version, profile };
    const deadline = Date.now() + 30_000;
    for (;;) {
      const info = this.serverFile(profile);
      if (info !== null && info.startedAt >= since) return info;
      if (child.exitCode !== null) throw new Error(`rowrow serve exited: ${stderr.slice(-500)}`);
      if (Date.now() > deadline) throw new Error("rowrow serve didn't start within 30s");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** `rowrow service …` for the child supervisor: the same answers, from a child process. */
  private async childService(version: string, args: readonly string[]): Promise<Run> {
    const [action = "status"] = args;
    const profile = args[args.indexOf("--profile") + 1] ?? "default";
    const flags = serveFlags(["serve", ...args.slice(1)]);
    const json = (value: unknown): Run => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    const stop = async (): Promise<void> => {
      const running = this.child;
      if (running === null) return;
      running.process.kill("SIGTERM");
      this.child = null;
      const deadline = Date.now() + 30_000;
      while (this.serverFile(profile) !== null && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
    };
    switch (action) {
      case "status": {
        const server = this.serverFile(profile);
        const status: ServiceStatus = {
          profile,
          manager: null,
          installed: this.child !== null,
          file: null,
          state: this.child === null ? null : `a child of the app, pid ${this.child.process.pid ?? "?"}`,
          command: null,
          install:
            this.child === null
              ? null
              : { kind: "bundle", root: this.options.source.dir, version: this.child.version },
          server,
        };
        return json(status);
      }
      case "install": {
        const running = this.serverFile(profile);
        if (this.child !== null && this.child.version === version && running !== null)
          return json({ outcome: "unchanged", file: "", server: running });
        if (this.child === null && running !== null)
          return {
            code: 1,
            stdout: "",
            stderr: `rowrow: a rowrow server for profile "${profile}" is already running (pid ${running.pid})`,
          };
        await stop();
        return json({
          outcome: "installed",
          file: "",
          server: await this.spawnChild(version, profile, flags),
        });
      }
      case "stop":
        await stop();
        return json({});
      case "start":
      case "restart": {
        const current = this.child;
        await stop();
        await this.spawnChild(current?.version ?? version, profile, flags);
        return json({});
      }
      default:
        return { code: 1, stdout: "", stderr: `rowrow: the development supervisor can't ${action}` };
    }
  }
}

// ─── A host over SSH ─────────────────────────────────────────────────────────

/** Where the app gets a server bundle to upload: see bundles.ts. */
export interface BundleSource {
  tarball(version: string, target: BundleTarget, step: (text: string) => void): Promise<string>;
}

export class SshHost implements Host {
  readonly label: string;
  /** Bundles known to be on the host this session: no probe each time. */
  private readonly present = new Set<string>();
  private readonly destination: string;
  private readonly ssh: string;
  private readonly bundles: BundleSource;
  private readonly log: Logger;

  constructor(destination: string, bundles: BundleSource, log: Logger, ssh = "ssh") {
    this.label = destination;
    this.destination = destination;
    this.bundles = bundles;
    this.log = log;
    this.ssh = ssh;
  }

  /** A script on the host's sh; a failure to reach it becomes words for a person. */
  private async script(text: string, timeoutMs = 60_000): Promise<Run> {
    const result = await runProcess(this.ssh, scriptArgs(this.destination), { stdin: text, timeoutMs });
    if (result.code === 255) throw new Error(explainSshFailure(this.destination, result));
    return result;
  }

  async probe(): Promise<Probe> {
    const result = await this.script(PROBE, 30_000);
    if (result.code !== 0)
      throw new Error(`${this.destination}: ${result.stderr.trim() || "the probe failed"}`);
    return parseProbe(result.stdout);
  }

  async ensureBundle(version: string, step: (text: string) => void): Promise<void> {
    if (this.present.has(version)) return;
    step(`Looking at ${this.destination}`);
    const probe = await this.probe();
    for (const v of probe.versions) this.present.add(v);
    if (probe.versions.includes(version)) return;
    const target = targetOf(probe.os, probe.arch, probe.libc);
    if (target === null)
      throw new Error(
        `rowrow has no server for ${probe.os} ${probe.arch}${probe.libc === null ? "" : ` (${probe.libc})`} yet: it runs on Linux (x64, arm64, glibc) and Apple silicon Macs`,
      );
    const tarball = await this.bundles.tarball(version, target, step);
    step(`Uploading rowrow ${version} to ${this.destination}`);
    const prepared = await this.script(prepareUploadScript());
    const tmp = prepared.stdout.trim().split("\n").at(-1) ?? "";
    if (prepared.code !== 0 || !tmp.startsWith("/"))
      throw new Error(`${this.destination}: ${prepared.stderr.trim()}`);
    const upload = await runProcess(this.ssh, untarArgs(this.destination, tmp), {
      stdin: fs.createReadStream(tarball),
      timeoutMs: 15 * 60_000,
    });
    if (upload.code !== 0)
      throw new Error(`uploading to ${this.destination}: ${explainSshFailure(this.destination, upload)}`);
    step(`Installing rowrow ${version} on ${this.destination}`);
    const placed = await this.script(placeBundleScript(tmp, version));
    if (placed.code !== 0)
      throw new Error(`${this.destination}: ${placed.stderr.trim() || "installing the bundle failed"}`);
    this.present.add(version);
    this.log.info("desktop.bundle.uploaded", { host: this.destination, version, target });
  }

  async run(version: string, args: readonly string[], timeoutMs = 90_000): Promise<Run> {
    const result = await this.script(cliScript(version, args), timeoutMs);
    // Gone since we looked (someone removed it): look again next time.
    if (result.code === 127) this.present.delete(version);
    return result;
  }

  async startBackground(version: string, profile: string, serveArgs: readonly string[]): Promise<void> {
    const result = await this.script(backgroundScript(version, profile, serveArgs));
    if (result.code !== 0) throw new Error(`${this.destination}: ${result.stderr.trim()}`);
  }

  async kill(pid: number): Promise<void> {
    await this.script(`kill -TERM ${Math.trunc(pid)} 2>/dev/null; exit 0\n`);
  }

  async versions(): Promise<string[]> {
    return [...(await this.probe()).versions];
  }

  async removeVersions(versions: readonly string[]): Promise<void> {
    if (versions.length === 0) return;
    await this.script(removeVersionsScript(versions));
    for (const version of versions) this.present.delete(version);
  }
}

// ─── Managing a host's server ────────────────────────────────────────────────

/** A server's flags from a service's command: what comes after `serve`, without --profile. */
export function serveFlags(command: readonly string[] | null): string[] {
  if (command === null) return [];
  const at = command.indexOf("serve");
  const flags = at === -1 ? [] : command.slice(at + 1);
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] ?? "";
    if (flag === "--profile") i += 1;
    else if (flag !== "--json" && flag !== "--if-idle") out.push(flag);
  }
  return out;
}

/** What a failed CLI call said, for a person: its `rowrow: …` line, else its last words. */
export function cliError(result: Run): string {
  const said = result.stderr.trim().split("\n").filter(Boolean);
  return (
    said.find((line) => line.startsWith("rowrow: ")) ??
    said.at(-1) ??
    `exit code ${result.code}`
  ).replace(/^rowrow: /, "");
}

export interface HostManagerOptions {
  readonly host: Host;
  readonly profile: string;
  readonly appVersion: string;
  /** Flags for a new service's `serve` (development: --test-runtime, a --port). */
  readonly serveArgs: readonly string[];
  /** The app started this host's server in the background (no service manager there). */
  readonly background: () => boolean;
  readonly setBackground: (on: boolean) => void;
  readonly onChange: () => void;
  /** What the host is busy with, when it takes a while (installing a bundle); null when done. */
  readonly onStep?: (text: string | null) => void;
  readonly log: Logger;
}

export class HostManager {
  private readonly o: HostManagerOptions;
  private status: ServiceStatus | null = null;
  private upgradeState: HostView["upgrade"] = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(options: HostManagerOptions) {
    this.o = options;
  }

  get plan(): HostPlan | null {
    return this.status === null ? null : planHost(this.status, this.o.appVersion, this.o.background());
  }

  /** Operations in flight: the updater waits for them before it quits the app. */
  get busy(): boolean {
    return this.pending > 0;
  }

  get view(): HostView {
    const plan = this.plan;
    return {
      owner: plan?.owner ?? "none",
      installKind: this.status?.install?.kind ?? null,
      runningVersion: plan?.runningVersion ?? null,
      service: this.status?.state ?? null,
      upgrade: this.upgradeState,
      logFile: null,
    };
  }

  /** One host operation at a time: two service installs must never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const next = this.queue.then(fn, fn).finally(() => {
      this.pending -= 1;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The CLI of the app's version on the host, installing its bundle first when it isn't there. */
  private async cli(args: readonly string[], timeoutMs?: number): Promise<Run> {
    await this.o.host.ensureBundle(this.o.appVersion, (text) => this.o.onStep?.(text));
    this.o.onStep?.(null);
    return this.o.host.run(this.o.appVersion, args, timeoutMs);
  }

  /**
   * For questions (status, a sign-in code): the app's CLI, or, when its bundle can't be put there
   * (an SSH host while GitHub is out of reach), the newest one the host has, which answers the
   * same questions. Right after the app updates, the old server is still reachable either way.
   */
  private async ask(args: readonly string[], timeoutMs?: number): Promise<Run> {
    try {
      return await this.cli(args, timeoutMs);
    } catch (error) {
      this.o.onStep?.(null);
      const installed = await this.o.host.versions().catch(() => [] as string[]);
      const newest = installed
        .filter((v) => v !== this.o.appVersion && isVersion(v))
        .sort(compareVersions)
        .at(-1);
      if (newest === undefined) throw error;
      this.o.log.warn("desktop.host.older_cli", {
        host: this.o.host.label,
        version: newest,
        err: serializeError(error),
      });
      return this.o.host.run(newest, args, timeoutMs);
    }
  }

  private profileArgs(): string[] {
    return ["--profile", this.o.profile];
  }

  /** What runs on the host now, from its CLI. */
  async refresh(): Promise<ServiceStatus> {
    const result = await this.ask(["service", "status", "--json", ...this.profileArgs()], 30_000);
    if (result.code !== 0) throw new Error(`${this.o.host.label}: ${cliError(result)}`);
    const status = ServiceStatus.parse(JSON.parse(result.stdout));
    // Once a service runs the profile, nothing runs in the background any more. (A background
    // server that stopped reads as nothing running either way; one that's starting has no
    // server.json yet, so that can't clear it.)
    if (this.o.background() && status.installed) this.o.setBackground(false);
    this.status = status;
    if (this.upgradeState !== null && !(this.plan?.upgrade ?? false) && this.plan?.owner !== "cli")
      this.upgradeState = null;
    this.o.onChange();
    return status;
  }

  /** The URL the host's server listens on (its own loopback), or why there is none. */
  async serverUrl(): Promise<string> {
    const status = await this.refresh();
    if (status.server === null) {
      const owner = this.plan?.owner ?? "none";
      throw new Error(
        owner === "none"
          ? `rowrow isn't running on ${this.o.host.label}`
          : `rowrow's server on ${this.o.host.label} isn't running${status.state === null ? "" : ` (${status.state})`}`,
      );
    }
    return status.server.url;
  }

  /**
   * Set the host up for this app: its bundle, then a server. Nothing runs: a service from the
   * bundle (or, on a host with no service manager, a server in the background). A server
   * that runs already is used as it is, whoever runs it.
   */
  setUp(step: (text: string) => void): Promise<void> {
    return this.exclusive(async () => {
      await this.o.host.ensureBundle(this.o.appVersion, step);
      step(`Looking for rowrow on ${this.o.host.label}`);
      const status = await this.refresh();
      if (status.server !== null || status.installed) return;
      step(`Starting rowrow's server on ${this.o.host.label}`);
      const installed = await this.cli(
        ["service", "install", "--json", ...this.profileArgs(), ...this.o.serveArgs],
        120_000,
      );
      if (installed.code !== 0) {
        const reason = cliError(installed);
        // A host with no user service manager (a container, WSL, systemd without a user session):
        // run it in the background, and say it won't come back after a reboot.
        if (status.manager === null || /systemctl|bus|systemd|launchctl|Domain/i.test(installed.stderr)) {
          this.o.log.warn("desktop.host.no_service_manager", { host: this.o.host.label, reason });
          await this.o.host.startBackground(this.o.appVersion, this.o.profile, this.o.serveArgs);
          this.o.setBackground(true);
          await this.waitForServer();
          return;
        }
        throw new Error(`${this.o.host.label}: ${reason}`);
      }
      InstallOutcome.parse(JSON.parse(installed.stdout));
      this.o.log.info("desktop.host.service_installed", {
        host: this.o.host.label,
        version: this.o.appVersion,
      });
      await this.refresh();
    });
  }

  private async waitForServer(timeoutMs = 30_000): Promise<RunningServer> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.refresh();
      if (status.server !== null) return status.server;
      if (Date.now() > deadline) throw new Error(`rowrow's server on ${this.o.host.label} didn't start`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** A one-time sign-in code for this app, minted by the host's CLI (it holds the local token). */
  async mintCode(deviceName: string): Promise<string> {
    const result = await this.ask(["pair", deviceName, "--json", ...this.profileArgs()], 30_000);
    if (result.code !== 0) throw new Error(`${this.o.host.label}: ${cliError(result)}`);
    const { url } = JSON.parse(result.stdout) as { url: string };
    const code = new URL(url).searchParams.get("code");
    if (code === null) throw new Error(`${this.o.host.label}: rowrow pair gave no code`);
    return code;
  }

  /**
   * Replace the running server with the app's version: now, or only when no agent is mid-turn
   * (a restart ends every run; the conversations resume on the next message, a turn would be cut
   * off). "busy" means some are working; try again when they finish.
   */
  upgrade(now: boolean, workingAgents: () => Promise<string[] | null>): Promise<"done" | "busy" | "nothing"> {
    return this.exclusive(async () => {
      const status = await this.refresh();
      const plan = this.plan;
      if (plan === null || !plan.upgrade) {
        this.upgradeState = null;
        return "nothing";
      }
      const running = status.server?.version ?? null;
      if (running !== null && compareVersions(running, this.o.appVersion) > 0) {
        this.upgradeState = null;
        return "nothing";
      }
      this.upgradeState = { version: this.o.appVersion, state: "installing", waitingFor: [], error: null };
      this.o.onChange();
      try {
        await this.o.host.ensureBundle(this.o.appVersion, () => undefined);
        if (plan.owner === "background") {
          const working = now ? [] : ((await workingAgents()) ?? []);
          if (working.length > 0) return this.waiting(working);
          if (status.server !== null) await this.o.host.kill(status.server.pid);
          await this.o.host.startBackground(this.o.appVersion, this.o.profile, this.o.serveArgs);
          await this.waitForServer();
          this.upgradeState = null;
          return "done";
        }
        const result = await this.cli(
          [
            "service",
            "install",
            "--json",
            ...this.profileArgs(),
            ...serveFlags(status.command),
            ...(now ? [] : ["--if-idle"]),
          ],
          120_000,
        );
        if (result.code !== 0 && result.code !== 75) throw new Error(cliError(result));
        const outcome = InstallOutcome.parse(JSON.parse(result.stdout));
        if (outcome.outcome === "busy") return this.waiting(outcome.working.map((a) => a.title ?? a.id));
        this.o.log.info("desktop.host.upgraded", {
          host: this.o.host.label,
          from: running,
          to: this.o.appVersion,
          outcome: outcome.outcome,
        });
        this.upgradeState = null;
        await this.refresh();
        await this.collectGarbage();
        return "done";
      } catch (error) {
        this.o.log.error("desktop.host.upgrade_failed", {
          host: this.o.host.label,
          err: serializeError(error),
        });
        await this.rollBack(status);
        this.upgradeState = {
          version: this.o.appVersion,
          state: "failed",
          waitingFor: [],
          error: error instanceof Error ? error.message : String(error),
        };
        return "busy";
      } finally {
        this.o.onChange();
      }
    });
  }

  /**
   * After an upgrade failed: the service the host ran before, from its own bundle, if what
   * runs now isn't a server (a failed upgrade must not leave the host without one).
   */
  private async rollBack(before: ServiceStatus): Promise<void> {
    const previous = before.install?.kind === "bundle" ? before.install.version : null;
    if (previous === null || previous === this.o.appVersion) return;
    try {
      const now = await this.refresh();
      if (now.server !== null) return;
      const result = await this.o.host.run(
        previous,
        ["service", "install", "--json", ...this.profileArgs(), ...serveFlags(before.command)],
        120_000,
      );
      this.o.log.warn("desktop.host.rolled_back", {
        host: this.o.host.label,
        to: previous,
        ok: result.code === 0,
        err: result.code === 0 ? undefined : cliError(result),
      });
      await this.refresh();
    } catch (error) {
      this.o.log.error("desktop.host.roll_back_failed", {
        host: this.o.host.label,
        err: serializeError(error),
      });
    }
  }

  private waiting(working: readonly string[]): "busy" {
    this.o.log.info("desktop.host.upgrade_waiting", {
      host: this.o.host.label,
      version: this.o.appVersion,
      working,
    });
    this.upgradeState = { version: this.o.appVersion, state: "waiting", waitingFor: working, error: null };
    return "busy";
  }

  /**
   * Hand a service someone else installed (npm, pnpm, a checkout) to the app, keeping its
   * flags; never onto an older server than the one that runs (its database may be newer).
   */
  async adopt(): Promise<"done" | "busy"> {
    const status = await this.refresh();
    const running = status.server?.version ?? status.install?.version ?? null;
    if (running !== null && compareVersions(running, this.o.appVersion) > 0)
      throw new Error(
        `${this.o.host.label} runs rowrow ${running}, newer than this app's ${this.o.appVersion}: update the app first`,
      );
    return this.exclusive(async () => {
      const result = await this.cli(
        ["service", "install", "--json", ...this.profileArgs(), ...serveFlags(status.command), "--if-idle"],
        120_000,
      );
      if (result.code !== 0 && result.code !== 75) throw new Error(cliError(result));
      const outcome = InstallOutcome.parse(JSON.parse(result.stdout));
      await this.refresh();
      if (outcome.outcome === "busy") return this.waiting(outcome.working.map((a) => a.title ?? a.id));
      this.upgradeState = null;
      return "done";
    });
  }

  action(action: Exclude<HostAction, "upgrade-now" | "adopt">): Promise<void> {
    return this.exclusive(async () => {
      const status = await this.refresh();
      if (this.plan?.owner === "background") {
        if (status.server !== null && action !== "start") await this.o.host.kill(status.server.pid);
        if (action !== "stop") {
          await this.o.host.startBackground(this.o.appVersion, this.o.profile, this.o.serveArgs);
          this.o.setBackground(true);
          await this.waitForServer();
        }
        await this.refresh();
        return;
      }
      const result = await this.cli(["service", action, ...this.profileArgs()], 90_000);
      if (result.code !== 0) throw new Error(`${this.o.host.label}: ${cliError(result)}`);
      this.o.log.info("desktop.host.action", { host: this.o.host.label, action });
      await this.refresh();
    });
  }

  /** Bundles nothing runs and nothing will go back to (plan.ts, versionsToKeep). */
  async collectGarbage(): Promise<void> {
    try {
      const installed = await this.o.host.versions();
      const keep = versionsToKeep(
        installed,
        this.o.appVersion,
        this.status?.install?.version ?? this.status?.server?.version ?? null,
      );
      await this.o.host.removeVersions(installed.filter((v) => !keep.has(v)));
    } catch (error) {
      this.o.log.warn("desktop.bundle.gc_failed", { host: this.o.host.label, err: serializeError(error) });
    }
  }
}

/** The sha256 of a file, hex. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}
