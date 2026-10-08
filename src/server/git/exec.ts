// Running git (and the few other tools the git features use, like `gh`). Every call has a
// timeout that kills the whole process group, never uses the user's pager or prompts, and
// is logged when it fails or runs long.
import { spawn } from "node:child_process";
import { log } from "../telemetry/log.ts";

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** stdout passed `maxBytes`: what is here is its start. */
  readonly capped: boolean;
  /** stdout as bytes (an archive, a binary file), cut like `stdout`. */
  readonly bytes?: Buffer;
  /** The process couldn't start (e.g. `ENOENT`: not installed). */
  readonly spawnError?: string;
}

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Cap on stdout bytes; the rest is dropped and `truncated` reported by callers. */
  readonly maxBytes?: number;
  /** Kill the process as soon as stdout passes `maxBytes` (a search that has enough), instead of letting it finish. */
  readonly stopAtMax?: boolean;
  readonly input?: string;
}

const SLOW_MS = 2000;

export async function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  return spawnCollect(
    "git",
    ["-c", "core.quotepath=off", "-c", "color.ui=false", ...args],
    { ...options, env: { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", ...options.env } },
    args,
  );
}

/** git, throwing a readable error unless it exits 0. */
export async function gitOk(args: readonly string[], options: GitOptions): Promise<string> {
  const result = await git(args, options);
  if (result.code !== 0) {
    const reason = result.timedOut ? "timed out" : result.stderr || `exit code ${result.code}`;
    throw new Error(`git ${args[0] ?? ""} failed: ${reason}`);
  }
  return result.stdout;
}

/** Run a program (never through a shell) with the same timeout, cap and logging as git. */
export async function run(command: string, args: readonly string[], options: GitOptions): Promise<GitResult> {
  return spawnCollect(command, args, options, args);
}

async function spawnCollect(
  command: string,
  args: readonly string[],
  options: GitOptions,
  /** What the caller asked for, for the log (without the flags `git()` adds). */
  logged: readonly string[],
): Promise<GitResult> {
  const started = Date.now();
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let timedOut = false;
    let capped = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes < maxBytes) out.push(chunk);
      outBytes += chunk.length;
      if (outBytes > maxBytes && !capped) {
        capped = true;
        if (options.stopAtMax === true) killGroup(child.pid);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    // A child that exits before reading its input makes the write fail with EPIPE; the exit code says what happened.
    child.stdin?.on("error", () => undefined);
    if (options.input !== undefined) child.stdin?.end(options.input);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, options.timeoutMs ?? 20_000);
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      const all = Buffer.concat(out);
      const bytes = capped ? all.subarray(0, maxBytes) : all;
      const result: GitResult = {
        code,
        stdout: bytes.toString("utf8"),
        bytes,
        stderr: Buffer.concat(err).toString("utf8").trim(),
        timedOut,
        capped,
      };
      const ms = Date.now() - started;
      if (timedOut || ms > SLOW_MS)
        log.warn(command === "git" ? "git.slow" : "exec.slow", {
          ...(command === "git" ? {} : { command }),
          args: logged.slice(0, 3),
          cwd: options.cwd,
          ms,
          timedOut,
        });
      resolve(result);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout: "",
        stderr: error.message,
        timedOut: false,
        capped: false,
        ...(error.code === undefined ? {} : { spawnError: error.code }),
      });
    });
    child.on("close", finish);
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // already gone
  }
}
