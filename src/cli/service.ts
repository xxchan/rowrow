// `rowrow service`: hand the server to the OS supervisor, so it starts at login, restarts if
// it crashes, and needs no terminal left open (you're steering from your phone, after all).
// launchd on macOS, systemd --user on Linux. The definitions are small files you can read;
// `rowrow service status` prints where they are.
//
// One service per profile, whoever installs it: the npm package, a checkout, or a server
// bundle the Mac app put in ROWROW_HOME/versions (D-032). The last install wins, and the data
// (the profile's directory) is the same whichever runs it. The Mac app drives these same
// commands, with --json, on this machine and over SSH.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { binDir, profilePaths, rowrowHome } from "../server/config.ts";
import { installOfCommand } from "../server/install.ts";
import type { InstallOutcome, RunningServer, ServiceStatus } from "../shared/host.ts";
import type { ServerFile } from "../server/main.ts";
import { connect, resolveTarget } from "./client.ts";

export interface ServiceSpec {
  readonly profile: string;
  /** node, this CLI, `serve`, and the serve flags. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  /** stdout and stderr (launchd; systemd keeps them in the journal). */
  readonly logFile: string;
}

export function serviceNames(profile: string): { label: string; unit: string } {
  return { label: `dev.rowrow.${profile}`, unit: `rowrow-${profile}.service` };
}

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export function launchdPlist(spec: ServiceSpec): string {
  const strings = (values: readonly string[]): string =>
    values.map((v) => `\n    <string>${xml(v)}</string>`).join("");
  const env = Object.entries(spec.env)
    .map(([k, v]) => `\n    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(serviceNames(spec.profile).label)}</string>
  <key>ProgramArguments</key>
  <array>${strings(spec.argv)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logFile)}</string>
</dict>
</plist>
`;
}

/** A quoted systemd value: `\\`, `"` and specifiers (`%`) escaped. */
const quoted = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
/** A word of ExecStart=, where `$` would also expand a variable. */
const word = (value: string): string => quoted(value.replaceAll("$", "$$$$"));

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${quoted(`${k}=${v}`)}\n`)
    .join("");
  return `[Unit]
Description=rowrow (profile ${spec.profile}): coding agents you steer from any browser

[Service]
Type=simple
WorkingDirectory=${spec.workingDirectory.replaceAll("%", "%%")}
${env}ExecStart=${spec.argv.map(word).join(" ")}
Restart=on-failure
RestartSec=2
# The server stops its agents itself on SIGTERM; only what's left after that is killed.
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

/** The command a plist written by launchdPlist runs (its ProgramArguments), or null. */
export function plistCommand(plist: string): string[] | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (array === undefined) return null;
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(([, value = ""]) =>
    value
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&"),
  );
}

/** The command a unit written by systemdUnit runs (the words of ExecStart=), or null. */
export function unitCommand(unit: string): string[] | null {
  const line = /^ExecStart=(.*)$/m.exec(unit)?.[1];
  if (line === undefined) return null;
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(([, inQuotes, bare = ""]) =>
    (inQuotes === undefined ? bare : inQuotes.replaceAll(/\\(.)/g, "$1"))
      .replaceAll("%%", "%")
      .replaceAll("$$", "$"),
  );
}

interface Platform {
  readonly manager: "launchd" | "systemd";
  readonly file: string;
  render(spec: ServiceSpec): string;
  /** What a definition in this platform's format runs. */
  command(definition: string): string[] | null;
  install(spec: ServiceSpec): Promise<void>;
  uninstall(): void;
  start(): Promise<void>;
  stop(): void;
  restart(): void;
  /** Known to the service manager right now (launchd has it loaded; systemd has it active). */
  loaded(): boolean;
  /** What the service manager says, in its own words. */
  describe(): string;
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function attempt(command: string, args: string[]): string | null {
  try {
    return run(command, args);
  } catch {
    return null;
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `launchctl bootstrap`, once launchd has let go of the job: `bootout` returns while it's still
 * stopping it, and a bootstrap then fails ("5: Input/output error"), leaving no service at all.
 */
async function bootstrap(domain: string, label: string, file: string): Promise<void> {
  const deadline = Date.now() + 35_000;
  while (attempt("launchctl", ["print", `${domain}/${label}`]) !== null && Date.now() < deadline)
    await pause(200);
  for (let tries = 1; ; tries++) {
    try {
      run("launchctl", ["bootstrap", domain, file]);
      return;
    } catch (error) {
      if (tries >= 10) throw error;
      await pause(500);
    }
  }
}

function platformOf(profile: string): Platform | null {
  const { label, unit } = serviceNames(profile);
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${process.getuid?.() ?? 0}`;
    return {
      manager: "launchd",
      file,
      render: launchdPlist,
      command: plistCommand,
      async install(spec) {
        attempt("launchctl", ["bootout", `${domain}/${label}`]);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, launchdPlist(spec));
        await bootstrap(domain, label, file);
      },
      uninstall() {
        attempt("launchctl", ["bootout", `${domain}/${label}`]);
        fs.rmSync(file, { force: true });
      },
      async start() {
        if (attempt("launchctl", ["print", `${domain}/${label}`]) === null)
          await bootstrap(domain, label, file);
        else run("launchctl", ["kickstart", `${domain}/${label}`]);
      },
      stop() {
        // Unloaded until the next login (or `rowrow service start`): launchd loads what's in
        // ~/Library/LaunchAgents when you log in, as systemd starts an enabled unit.
        attempt("launchctl", ["bootout", `${domain}/${label}`]);
      },
      restart() {
        run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
      },
      loaded() {
        return attempt("launchctl", ["print", `${domain}/${label}`]) !== null;
      },
      describe() {
        const printed = attempt("launchctl", ["print", `${domain}/${label}`]);
        if (printed === null) return "not loaded";
        const field = (name: string): string | undefined =>
          new RegExp(`^\\s*${name} = (.+)$`, "m").exec(printed)?.[1];
        return [field("state"), field("pid") === undefined ? null : `pid ${field("pid")}`]
          .filter((part) => part !== null && part !== undefined)
          .join(", ");
      },
    };
  }
  if (process.platform === "linux") {
    const file = path.join(
      process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"),
      "systemd",
      "user",
      unit,
    );
    return {
      manager: "systemd",
      file,
      render: systemdUnit,
      command: unitCommand,
      async install(spec) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, systemdUnit(spec));
        run("systemctl", ["--user", "daemon-reload"]);
        run("systemctl", ["--user", "enable", unit]);
        run("systemctl", ["--user", "restart", unit]);
      },
      uninstall() {
        attempt("systemctl", ["--user", "disable", "--now", unit]);
        fs.rmSync(file, { force: true });
        attempt("systemctl", ["--user", "daemon-reload"]);
      },
      async start() {
        run("systemctl", ["--user", "start", unit]);
      },
      stop() {
        run("systemctl", ["--user", "stop", unit]);
      },
      restart() {
        run("systemctl", ["--user", "restart", unit]);
      },
      loaded() {
        return attempt("systemctl", ["--user", "is-active", "--quiet", unit]) !== null;
      },
      describe() {
        const shown = attempt("systemctl", [
          "--user",
          "show",
          unit,
          "--property=ActiveState,SubState,MainPID",
        ]);
        if (shown === null) return "unknown to systemd";
        const field = (name: string): string | undefined =>
          new RegExp(`^${name}=(.*)$`, "m").exec(shown)?.[1];
        const pid = field("MainPID");
        return [
          `${field("ActiveState")} (${field("SubState")})`,
          pid === undefined || pid === "0" ? null : `pid ${pid}`,
        ]
          .filter((part) => part !== null)
          .join(", ");
      },
    };
  }
  return null;
}

function platform(profile: string): Platform {
  const found = platformOf(profile);
  if (found === null)
    throw new Error(`rowrow service supports macOS (launchd) and Linux (systemd), not ${process.platform}`);
  return found;
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The running server of a profile: a service's, or one started in a terminal. */
export type RunningInfo = RunningServer;

function readServer(profile: string): ServerFile | null {
  try {
    const info = JSON.parse(
      fs.readFileSync(profilePaths(rowrowHome(), profile).serverFile, "utf8"),
    ) as ServerFile;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

const summarize = (info: ServerFile): RunningInfo => ({
  url: info.url,
  publicUrl: info.publicUrl,
  pid: info.pid,
  version: info.version,
  startedAt: info.startedAt,
});
const running = (info: ServerFile | null): RunningInfo | null => (info === null ? null : summarize(info));

/** Waits for a server of this profile started after `since` (server.json is written once it listens). */
async function waitForServer(profile: string, since: number, timeoutMs = 30_000): Promise<ServerFile> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = readServer(profile);
    if (info !== null && info.startedAt >= since) return info;
    if (Date.now() > deadline) {
      const log = path.join(profilePaths(rowrowHome(), profile).dir, "service.log");
      const said = lastError(log);
      throw new Error(
        `the service didn't come up within ${timeoutMs / 1000}s${said === null ? "" : ` (it said: ${said})`}; see ${log} and: rowrow service status`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The server's last `rowrow: …` line in its startup output (a port in use, a bad flag). */
function lastError(log: string): string | null {
  const text = readFile(log);
  if (text === null) return null;
  const lines = text
    .slice(-20_000)
    .split("\n")
    .filter((line) => line.startsWith("rowrow: "));
  return lines.at(-1)?.slice("rowrow: ".length) ?? null;
}

/** Whether `file` runs from npx's cache, which npm clears now and then. */
export function inNpxCache(file: string): boolean {
  return file.split(/[\\/]/).includes("_npx");
}

export function getServiceStatus(profile: string): ServiceStatus {
  const target = platformOf(profile);
  const definition = target === null ? null : readFile(target.file);
  const command = target === null || definition === null ? null : target.command(definition);
  return {
    profile,
    manager: target?.manager ?? null,
    installed: definition !== null,
    file: target?.file ?? null,
    state: target === null || definition === null ? null : target.describe(),
    command,
    install: command === null ? null : installOfCommand(command, rowrowHome()),
    server: running(readServer(profile)),
  };
}

/** Agents in the middle of a turn on this profile's running server: a restart would cut them off. */
async function workingAgents(profile: string): Promise<{ id: string; title: string | null }[]> {
  const { client } = connect(resolveTarget({ profile }));
  const { state } = await client.state.get();
  return Object.values(state.agents)
    .filter((agent) => agent.attention === "working" && !agent.summary.archived)
    .map((agent) => ({ id: agent.id, title: agent.summary.title }));
}

/** ROWROW_HOME/bin/rowrow, pointing at the CLI of the bundle at `root`; replaced in one step. */
function linkBin(root: string): string {
  const dir = binDir(rowrowHome());
  fs.mkdirSync(dir, { recursive: true });
  const link = path.join(dir, "rowrow");
  const tmp = `${link}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.relative(dir, path.join(root, "bin", "rowrow")), tmp);
  fs.renameSync(tmp, link);
  return link;
}

/** Exit code for `service install --if-idle` when agents are working (sysexits' EX_TEMPFAIL: try again later). */
export const BUSY_EXIT = 75;

export async function installService(
  profile: string,
  serveArgs: readonly string[],
  options: { readonly ifIdle?: boolean; readonly json?: boolean } = {},
): Promise<InstallOutcome> {
  if (inNpxCache(import.meta.filename)) {
    throw new Error(
      "rowrow is running from npx's cache, which npm clears now and then, so a service started from here would stop working. Install it first (npm install -g rowrow), then run: rowrow service install",
    );
  }
  const paths = profilePaths(rowrowHome(), profile);
  const target = platform(profile);
  const existing = readFile(target.file);
  const before = readServer(profile);
  if (before !== null && existing === null) {
    throw new Error(
      `a rowrow server for profile "${profile}" is already running (pid ${before.pid}); stop it first (Ctrl-C in its terminal), then install the service`,
    );
  }
  const root = path.resolve(import.meta.dirname, "../..");
  if (!fs.existsSync(path.join(root, "dist", "web", "index.html"))) {
    throw new Error(`the web app isn't built yet: run \`pnpm build\` in ${root} first`);
  }
  fs.mkdirSync(paths.dir, { recursive: true });
  // The CLI next to this file: src/cli/main.ts in a checkout, lib/cli/main.js in the npm
  // package and in a bundle (docs/decisions.md, D-018).
  const cli = path.join(import.meta.dirname, `main${path.extname(import.meta.filename)}`);
  const spec: ServiceSpec = {
    profile,
    argv: [process.execPath, cli, "serve", ...serveArgs],
    env: {
      // What this shell can run, the service can run (a service manager's own PATH is bare).
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      // The server says `rowrow service restart` after an update (src/server/updates.ts).
      ROWROW_SERVICE: "1",
      ...(process.env["ROWROW_HOME"] === undefined ? {} : { ROWROW_HOME: process.env["ROWROW_HOME"] }),
    },
    workingDirectory: root,
    logFile: path.join(paths.dir, "service.log"),
  };
  const install = installOfCommand(spec.argv, rowrowHome());
  const say = (text: string): void => {
    if (options.json !== true) console.log(text);
  };

  // Already what runs: nothing to do (`rowrow service restart` restarts it).
  if (existing === target.render(spec) && before !== null && target.loaded()) {
    say(`rowrow ${before.version} already runs as this service: ${before.publicUrl} (${target.describe()})`);
    return { outcome: "unchanged", file: target.file, server: summarize(before) };
  }
  // Replacing a running server ends its runs; a turn in progress would be cut off.
  if (options.ifIdle === true && before !== null) {
    const working = await workingAgents(profile);
    if (working.length > 0) {
      say(
        `${working.length === 1 ? "An agent is" : `${working.length} agents are`} working (${working.map((a) => a.title ?? a.id).join(", ")}); try again when ${working.length === 1 ? "it finishes" : "they finish"}.`,
      );
      return { outcome: "busy", file: target.file, server: running(before), working };
    }
  }

  const since = Date.now();
  try {
    await target.install(spec);
  } catch (error) {
    // The service manager refused it (no systemd user session, say): leave no definition behind
    // that says a service exists.
    target.uninstall();
    throw error;
  }
  const info = await waitForServer(profile, since);
  const bin = install?.kind === "bundle" && profile === "default" ? linkBin(install.root) : null;
  const flag = profile === "default" ? "" : ` --profile ${profile}`;
  say(`rowrow runs as a service now: ${info.publicUrl}  (${target.describe()})
It starts when you log in and restarts if it crashes.

  rowrow open${flag}              sign this browser in
  rowrow service status${flag}    what the service manager says
  rowrow service restart${flag}   after ${cli.endsWith(".ts") ? "`git pull && pnpm build`" : install?.kind === "bundle" ? "the rowrow app installs a newer server" : "`npm install -g rowrow`"}
  rowrow logs${flag}              the server's log (startup output: ${spec.logFile})

Definition: ${target.file}
Runs: ${spec.argv.join(" ")}${bin === null ? "" : `\nThe rowrow command for your PATH: ${bin}`}`);
  if (process.platform === "linux" && options.json !== true) {
    const linger = attempt("loginctl", ["show-user", os.userInfo().username, "--property=Linger"]);
    if (linger !== null && !linger.includes("Linger=yes")) {
      console.log(
        `\nOn Linux a user service stops when you log out. To keep it running: loginctl enable-linger ${os.userInfo().username}`,
      );
    }
  }
  return { outcome: "installed", file: target.file, server: summarize(info) };
}

export function uninstallService(profile: string): void {
  const target = platform(profile);
  if (!fs.existsSync(target.file)) {
    console.log(`no rowrow service is installed for profile "${profile}" (${target.file})`);
    return;
  }
  target.uninstall();
  console.log(`removed the rowrow service for profile "${profile}"; the server is stopped`);
}

export async function restartService(profile: string): Promise<void> {
  const target = platform(profile);
  if (!fs.existsSync(target.file)) throw new Error(`no rowrow service is installed for profile "${profile}"`);
  const since = Date.now();
  target.restart();
  const info = await waitForServer(profile, since);
  console.log(`restarted: ${info.publicUrl} (pid ${info.pid})`);
}

export async function startService(profile: string): Promise<void> {
  const target = platform(profile);
  if (!fs.existsSync(target.file)) throw new Error(`no rowrow service is installed for profile "${profile}"`);
  const already = readServer(profile);
  if (already !== null) {
    console.log(`already running: ${already.publicUrl} (pid ${already.pid})`);
    return;
  }
  const since = Date.now();
  await target.start();
  const info = await waitForServer(profile, since);
  console.log(`started: ${info.publicUrl} (pid ${info.pid})`);
}

export async function stopService(profile: string): Promise<void> {
  const target = platform(profile);
  if (!fs.existsSync(target.file)) throw new Error(`no rowrow service is installed for profile "${profile}"`);
  target.stop();
  // The server removes server.json once it has stopped its agents.
  const deadline = Date.now() + 35_000;
  while (readServer(profile) !== null && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 250));
  console.log(
    `stopped; it starts again when you log in, or with: rowrow service start${profile === "default" ? "" : ` --profile ${profile}`}`,
  );
}

export function serviceStatus(profile: string, json = false): void {
  const status = getServiceStatus(profile);
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const { server } = status;
  const serverLine = `server: ${server === null ? "not running" : `${server.publicUrl} (pid ${server.pid}, rowrow ${server.version}, since ${new Date(server.startedAt).toLocaleString()})`}`;
  if (!status.installed) {
    console.log(
      `not installed (would be ${status.file ?? `unsupported on ${process.platform}`}); install with: rowrow service install\n${serverLine}`,
    );
    return;
  }
  const runs =
    status.install === null
      ? (status.command?.join(" ") ?? "?")
      : `rowrow ${status.install.version ?? "?"} (${status.install.kind === "bundle" ? "a bundle, managed by the rowrow app" : status.install.kind}) from ${status.install.root}`;
  console.log(`installed: ${status.file}
service manager: ${status.state}
runs: ${runs}
${serverLine}
startup output: ${path.join(profilePaths(rowrowHome(), profile).dir, "service.log")}`);
}
