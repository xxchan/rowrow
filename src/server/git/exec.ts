// Running git. Every call has a timeout that kills the whole process group, never uses
// the user's pager or prompts, and is logged when it fails or runs long.
import { spawn } from "node:child_process";
import { log } from "../telemetry/log.ts";

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Cap on stdout bytes; the rest is dropped and `truncated` reported by callers. */
  readonly maxBytes?: number;
  readonly input?: string;
}

const SLOW_MS = 2000;

export async function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const started = Date.now();
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "core.quotepath=off", "-c", "color.ui=false", ...args], {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes < maxBytes) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    if (options.input !== undefined) child.stdin?.end(options.input);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, options.timeoutMs ?? 20_000);
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      const result: GitResult = {
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8").trim(),
        timedOut,
      };
      const ms = Date.now() - started;
      if (timedOut || ms > SLOW_MS)
        log.warn("git.slow", { args: args.slice(0, 3), cwd: options.cwd, ms, timedOut });
      resolve(result);
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: error.message, timedOut: false });
    });
    child.on("close", finish);
  });
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

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // already gone
  }
}
