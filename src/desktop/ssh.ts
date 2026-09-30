// Reaching a machine over SSH, the way VS Code's Remote-SSH does (docs/desktop.md, D-033): the
// system's ssh, so your ~/.ssh/config, keys, agent, ProxyJump and ControlMaster all apply.
// Scripts go to the remote `sh -s` on stdin, so your login shell (bash, zsh, fish…) never
// parses them; the only command lines it sees are `sh -s` and `tar -xzf - -C <dir>`.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

/** A destination ssh takes: `host`, `user@host`, `user@host:port` is not one (use ~/.ssh/config). */
export function isDestination(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._@%+-]*$/.test(value) && !value.includes("..");
}

/** Never ask: no passwords or host-key prompts in a GUI app's child (connect once in a terminal). */
const BASE = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

/** Run a script with the remote's sh: `ssh … dest sh -s`, the script on stdin. */
export function scriptArgs(destination: string): string[] {
  return [...BASE, "-T", "--", destination, "sh", "-s"];
}

/** Unpack a .tar.gz from stdin into `dir` on the remote. */
export function untarArgs(destination: string, dir: string): string[] {
  if (!/^\/[A-Za-z0-9._/@+-]+$/.test(dir)) throw new Error(`unsafe remote directory: ${dir}`);
  return [...BASE, "-T", "--", destination, "tar", "-xzf", "-", "-C", dir];
}

/**
 * Forward 127.0.0.1:<local> on this Mac to 127.0.0.1:<remote> on the host. Its own
 * connection (no ControlMaster): a forward added to a shared master outlives this process.
 */
export function tunnelArgs(destination: string, local: number, remote: number): string[] {
  return [
    ...BASE,
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-L",
    `127.0.0.1:${local}:127.0.0.1:${remote}`,
    "--",
    destination,
  ];
}

/** A word for sh, single-quoted. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type BundleTarget = "darwin-arm64" | "linux-x64" | "linux-arm64";

/** The server bundle for `uname -s` and `uname -m`, or null when there is none. */
export function targetOf(os: string, arch: string, libc: string | null): BundleTarget | null {
  const cpu = /^(x86_64|amd64)$/i.test(arch) ? "x64" : /^(aarch64|arm64)$/i.test(arch) ? "arm64" : null;
  if (os === "Darwin" && cpu === "arm64") return "darwin-arm64";
  // Node's Linux builds need glibc: Alpine (musl) has no bundle.
  if (os === "Linux" && cpu !== null && libc !== "musl") return `linux-${cpu}`;
  return null;
}

/** ROWROW_HOME on the remote, as sh sees it. */
const HOME = `rh="\${ROWROW_HOME:-$HOME/.rowrow}"`;

/** What a host is: its platform, ROWROW_HOME, and the bundles installed there. */
export const PROBE = `${HOME}
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "home=$rh"
if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then echo "libc=musl"; fi
if [ -d "$rh/versions" ]; then
  for d in "$rh"/versions/*/; do
    [ -x "\${d}bin/rowrow" ] && echo "version=$(basename "$d")"
  done
fi
exit 0
`;

export interface Probe {
  readonly os: string;
  readonly arch: string;
  readonly home: string;
  readonly libc: string | null;
  readonly versions: readonly string[];
}

export function parseProbe(stdout: string): Probe {
  const fields = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const match = /^(os|arch|home|libc|version)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) fields.set(match[1], [...(fields.get(match[1]) ?? []), match[2] ?? ""]);
  }
  const one = (key: string): string | null => fields.get(key)?.[0] ?? null;
  const os = one("os");
  const home = one("home");
  if (os === null || home === null)
    throw new Error(`the host didn't describe itself: ${stdout.slice(0, 300)}`);
  return { os, arch: one("arch") ?? "", home, libc: one("libc"), versions: fields.get("version") ?? [] };
}

const VERSION = /^[0-9A-Za-z.+-]+$/;

function version(value: string): string {
  if (!VERSION.test(value)) throw new Error(`not a version: ${value}`);
  return value;
}

/** Make an empty directory for an upload, next to where it will go; prints its path. */
export function prepareUploadScript(): string {
  return `set -e
${HOME}
mkdir -p "$rh/versions"
mktemp -d "$rh/versions/.upload.XXXXXX"
`;
}

/** Move an unpacked bundle (the one directory in `tmp`) to versions/<version>, unless one is there. */
export function placeBundleScript(tmp: string, bundleVersion: string): string {
  const v = version(bundleVersion);
  return `set -e
${HOME}
tmp=${shQuote(tmp)}
target="$rh/versions/${v}"
set -- "$tmp"/*/
if [ ! -x "$target/bin/rowrow" ]; then
  rm -rf "$target"
  mv "$1" "$target"
fi
rm -rf "$tmp"
"$target/bin/rowrow" version --json
`;
}

/** Run the CLI of `bundleVersion` on the host with `args`. */
export function cliScript(bundleVersion: string, args: readonly string[]): string {
  return `${HOME}
exec "$rh/versions/${version(bundleVersion)}/bin/rowrow" ${args.map(shQuote).join(" ")}
`;
}

/**
 * Start `rowrow serve` without a service manager (a container, a host without systemd --user):
 * it survives the SSH session, but not a crash or a reboot.
 */
export function backgroundScript(
  bundleVersion: string,
  profile: string,
  serveArgs: readonly string[],
): string {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(profile)) throw new Error(`not a profile: ${profile}`);
  return `set -e
${HOME}
mkdir -p "$rh/${profile}"
nohup "$rh/versions/${version(bundleVersion)}/bin/rowrow" serve ${serveArgs.map(shQuote).join(" ")} >>"$rh/${profile}/service.log" 2>&1 </dev/null &
echo "pid=$!"
`;
}

/** Remove bundles by version (never the directory itself, never anything that isn't a version). */
export function removeVersionsScript(versions: readonly string[]): string {
  return `${HOME}
${versions.map((v) => `rm -rf "$rh/versions/${version(v)}"`).join("\n")}
exit 0
`;
}

export interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn a process, feed it stdin (a string, or a file stream), and collect what it says. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly stdin?: string | NodeJS.ReadableStream;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill("SIGTERM");
            stderr += `\n(timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s)`;
          }, options.timeoutMs);
    child.on("error", (error) => {
      if (timer !== null) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ code: code ?? (signal === null ? 1 : 128), stdout, stderr });
    });
    // A remote that exits before reading all of stdin closes the pipe: that's its answer, not ours.
    child.stdin.on("error", () => undefined);
    if (typeof options.stdin === "string") child.stdin.end(options.stdin);
    else if (options.stdin !== undefined) options.stdin.pipe(child.stdin);
    else child.stdin.end();
  });
}

/** What ssh said when it failed, in words for a person. */
export function explainSshFailure(destination: string, run: Run): string {
  const said = run.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit code ${run.code}`;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(run.stderr))
    return `${destination}'s host key isn't trusted yet: run \`ssh ${destination}\` once in a terminal and accept it (${said})`;
  if (/Permission denied/i.test(run.stderr))
    return `${destination} refused the key: rowrow signs in with your SSH keys or agent, not a password (${said})`;
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(run.stderr))
    return `no host called ${destination} (check ~/.ssh/config): ${said}`;
  if (run.code === 255) return `ssh couldn't reach ${destination}: ${said}`;
  return said;
}

/** A free port on this Mac's loopback. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null ? resolve(address.port) : reject(),
      );
    });
  });
}

/** Whether something accepts connections on 127.0.0.1:port. */
export function portOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * One port forward, kept up: `ssh -N -L`, restarted with backoff when it drops (Wi-Fi, sleep,
 * the host rebooting). `ready()` resolves once the local port answers.
 */
export class Tunnel {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private lastError = "";
  private readonly listeners = new Set<(up: boolean, error: string) => void>();
  readonly destination: string;
  readonly local: number;
  readonly remote: number;
  private readonly ssh: string;

  constructor(destination: string, local: number, remote: number, ssh = "ssh") {
    this.destination = destination;
    this.local = local;
    this.remote = remote;
    this.ssh = ssh;
  }

  /** Called with true when the forward is up, false (and why) when it went down. */
  onChange(listener: (up: boolean, error: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.stopped = false;
    if (this.child === null && this.timer === null) this.spawn();
  }

  /** Reconnect now (the Mac woke up, or someone pressed Retry). */
  kick(): void {
    if (this.stopped) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempt = 0;
    if (this.child === null) this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  get running(): boolean {
    return this.child !== null;
  }

  async ready(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child !== null && (await portOpen(this.local, 500))) return;
      if (this.stopped) throw new Error("the tunnel was stopped");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`the tunnel to ${this.destination} didn't come up: ${this.lastError || "no answer"}`);
  }

  private spawn(): void {
    const child = spawn(this.ssh, tunnelArgs(this.destination, this.local, this.remote), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    void (async () => {
      for (let i = 0; i < 100 && this.child === child; i++) {
        if (await portOpen(this.local, 300)) {
          this.attempt = 0;
          for (const listener of this.listeners) listener(true, "");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();
    child.on("error", (error) => (stderr += error.message));
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.lastError = explainSshFailure(this.destination, {
        code: child.exitCode ?? 255,
        stdout: "",
        stderr,
      });
      for (const listener of this.listeners) listener(false, this.lastError);
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
      this.attempt += 1;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.stopped) this.spawn();
      }, delay);
      this.timer.unref();
    });
  }
}
