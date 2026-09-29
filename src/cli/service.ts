// `rowrow service`: hand the server to the OS supervisor, so it starts at login, restarts if
// it crashes, and needs no terminal left open (you're steering from your phone, after all).
// launchd on macOS, systemd --user on Linux. The definitions are small files you can read;
// `rowrow service status` prints where they are.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { profilePaths, rowrowHome } from "../server/config.ts";
import type { ServerFile } from "../server/main.ts";

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

interface Platform {
  readonly file: string;
  install(spec: ServiceSpec): void;
  uninstall(): void;
  restart(): void;
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

function platform(profile: string): Platform {
  const { label, unit } = serviceNames(profile);
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${process.getuid?.() ?? 0}`;
    return {
      file,
      install(spec) {
        attempt("launchctl", ["bootout", `${domain}/${label}`]);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, launchdPlist(spec));
        run("launchctl", ["bootstrap", domain, file]);
      },
      uninstall() {
        attempt("launchctl", ["bootout", `${domain}/${label}`]);
        fs.rmSync(file, { force: true });
      },
      restart() {
        run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
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
      file,
      install(spec) {
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
      restart() {
        run("systemctl", ["--user", "restart", unit]);
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
  throw new Error(`rowrow service supports macOS (launchd) and Linux (systemd), not ${process.platform}`);
}

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

/** Waits for a server of this profile started after `since` (server.json is written once it listens). */
async function waitForServer(profile: string, since: number, timeoutMs = 30_000): Promise<ServerFile> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = readServer(profile);
    if (info !== null && info.startedAt >= since) return info;
    if (Date.now() > deadline) {
      const log = path.join(profilePaths(rowrowHome(), profile).dir, "service.log");
      throw new Error(
        `the service didn't come up within ${timeoutMs / 1000}s; see ${log} and: rowrow service status`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Whether `file` runs from npx's cache, which npm clears now and then. */
export function inNpxCache(file: string): boolean {
  return file.split(/[\\/]/).includes("_npx");
}

export async function installService(profile: string, serveArgs: readonly string[]): Promise<void> {
  if (inNpxCache(import.meta.filename)) {
    throw new Error(
      "rowrow is running from npx's cache, which npm clears now and then, so a service started from here would stop working. Install it first (npm install -g rowrow), then run: rowrow service install",
    );
  }
  const paths = profilePaths(rowrowHome(), profile);
  const target = platform(profile);
  const running = readServer(profile);
  if (running !== null && !fs.existsSync(target.file)) {
    throw new Error(
      `a rowrow server for profile "${profile}" is already running (pid ${running.pid}); stop it first (Ctrl-C in its terminal), then install the service`,
    );
  }
  const root = path.resolve(import.meta.dirname, "../..");
  if (!fs.existsSync(path.join(root, "dist", "web", "index.html"))) {
    throw new Error(`the web app isn't built yet: run \`pnpm build\` in ${root} first`);
  }
  fs.mkdirSync(paths.dir, { recursive: true });
  // The CLI next to this file: src/cli/main.ts in a checkout, lib/cli/main.js in the npm
  // package (docs/decisions.md, D-018).
  const cli = path.join(import.meta.dirname, `main${path.extname(import.meta.filename)}`);
  const spec: ServiceSpec = {
    profile,
    argv: [process.execPath, cli, "serve", ...serveArgs],
    env: {
      // What this shell can run, the service can run (a service manager's own PATH is bare).
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      ...(process.env["ROWROW_HOME"] === undefined ? {} : { ROWROW_HOME: process.env["ROWROW_HOME"] }),
    },
    workingDirectory: root,
    logFile: path.join(paths.dir, "service.log"),
  };
  const since = Date.now();
  target.install(spec);
  const info = await waitForServer(profile, since);
  const flag = profile === "default" ? "" : ` --profile ${profile}`;
  console.log(`rowrow runs as a service now: ${info.publicUrl}  (${target.describe()})
It starts when you log in and restarts if it crashes.

  rowrow open${flag}              sign this browser in
  rowrow service status${flag}    what the service manager says
  rowrow service restart${flag}   after ${cli.endsWith(".ts") ? "`git pull && pnpm build`" : "`npm install -g rowrow`"}
  rowrow logs${flag}              the server's log (startup output: ${spec.logFile})

Definition: ${target.file}
Runs: ${spec.argv.join(" ")}`);
  if (process.platform === "linux") {
    const linger = attempt("loginctl", ["show-user", os.userInfo().username, "--property=Linger"]);
    if (linger !== null && !linger.includes("Linger=yes")) {
      console.log(
        `\nOn Linux a user service stops when you log out. To keep it running: loginctl enable-linger ${os.userInfo().username}`,
      );
    }
  }
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

export function serviceStatus(profile: string): void {
  const target = platform(profile);
  if (!fs.existsSync(target.file)) {
    console.log(`not installed (would be ${target.file}); install with: rowrow service install`);
    return;
  }
  const info = readServer(profile);
  console.log(`installed: ${target.file}
service manager: ${target.describe()}
server: ${info === null ? "not running" : `${info.publicUrl} (pid ${info.pid}, since ${new Date(info.startedAt).toLocaleString()})`}
startup output: ${path.join(profilePaths(rowrowHome(), profile).dir, "service.log")}`);
}
