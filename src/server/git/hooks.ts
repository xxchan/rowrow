// Repository-defined worktree lifecycle scripts (docs/git.md, "Hooks"). A repository says
// what to run in `rowrow.json` at a checkout's root. The same shape is read from
// `roamgate.json` and `paseo.json`, so a repository already set up for those tools works
// as is. This module finds the config and runs one hook; the caller decides when.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "../telemetry/log.ts";

export type HookEvent = "setup" | "opened" | "teardown" | "removed";

export interface WorktreeHooks {
  readonly setup?: string;
  readonly opened?: string;
  readonly teardown?: string;
  readonly removed?: string;
}

export interface HookConfig {
  /** The one file the hooks come from. */
  readonly path: string;
  /** Read from another tool's file (roamgate.json or paseo.json). */
  readonly legacy: boolean;
  readonly worktree: WorktreeHooks;
}

const FILES = ["rowrow.json", "roamgate.json", "paseo.json"] as const;

/**
 * The hook config for an operation on `target` (a worktree) that came from `source` (the
 * checkout it was made from): the first file that exists, trying each file name in the
 * target, then the source. One whole file wins; files are never merged, and a file without
 * a hook for an event means "nothing to run", not "look further". A file that exists but
 * can't be read or is malformed throws: running the wrong hooks silently is worse.
 */
export async function resolveHooks(input: {
  readonly target: string;
  readonly source: string;
}): Promise<HookConfig | null> {
  for (const name of FILES) {
    for (const dir of [input.target, input.source]) {
      const file = path.join(dir, name);
      const text = await readIfExists(file);
      if (text !== null) return parseHookConfig(file, text, name !== "rowrow.json");
    }
  }
  return null;
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The target is gone by the time `removed` runs; its files simply don't exist.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error(`cannot read ${file}: ${(error as Error).message}`, { cause: error });
  }
}

export function parseHookConfig(file: string, text: string, legacy: boolean): HookConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  if (!isObject(parsed)) throw new Error(`${file}: expected a JSON object`);
  const section = parsed["worktree"];
  if (section === undefined) return { path: file, legacy, worktree: {} };
  if (!isObject(section)) throw new Error(`${file}: "worktree" must be an object`);
  const worktree: { -readonly [K in HookEvent]?: string } = {};
  for (const [key, value] of Object.entries(section)) {
    if (!isHookEvent(key)) {
      // Other tools' files may define hooks rowrow doesn't have; in ours it is a typo.
      if (legacy) continue;
      throw new Error(
        `${file}: unknown hook "worktree.${key}" (expected setup, opened, teardown or removed)`,
      );
    }
    if (typeof value !== "string")
      throw new Error(`${file}: "worktree.${key}" must be a string (a shell command)`);
    if (value.trim() !== "") worktree[key] = value;
  }
  return { path: file, legacy, worktree };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookEvent(key: string): key is HookEvent {
  return key === "setup" || key === "opened" || key === "teardown" || key === "removed";
}

// ─── Running ─────────────────────────────────────────────────────────────────

const OUTPUT_CAP = 200 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** How long to wait for output after the shell exits, if something it started keeps the pipes open. */
const DRAIN_MS = 1000;

export interface HookRunInput {
  readonly event: HookEvent;
  readonly command: string;
  readonly cwd: string;
  /** The worktree the event is about (already gone when `removed` runs). */
  readonly worktreePath: string;
  /** The checkout the worktree was made from. */
  readonly sourcePath: string;
  /** Extra environment on top of the server's. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface HookRun {
  /** Exited 0 in time. */
  readonly ok: boolean;
  readonly code: number | null;
  readonly timedOut: boolean;
  /** stdout and stderr interleaved as they arrived; the last ~200 KB. */
  readonly output: string;
  readonly ms: number;
}

/** Run one hook with `sh -c` in its own process group; the whole group is killed on timeout. */
export function runHook(input: HookRunInput): Promise<HookRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const output = tailBuffer(OUTPUT_CAP);
    let timedOut = false;
    let settled = false;
    const child = spawn("sh", ["-c", input.command], {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
        ROWROW_HOOK_EVENT: input.event,
        ROWROW_WORKTREE_PATH: input.worktreePath,
        ROWROW_SOURCE_PATH: input.sourcePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const collect = (chunk: Buffer): void => {
      if (!settled) output.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: HookRun = {
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        output: output.text(),
        ms: Date.now() - started,
      };
      const fields = { event: input.event, cwd: input.cwd, ok: result.ok, code, timedOut, ms: result.ms };
      if (result.ok) log.info("git.hook.ran", fields);
      else log.warn("git.hook.ran", fields);
      resolve(result);
    };
    child.on("error", (error) => {
      output.push(Buffer.from(`rowrow: cannot run the hook: ${error.message}\n`));
      finish(null);
    });
    // A background process the hook started may hold stdout open long after the shell
    // exits; don't wait for it (or kill it) once the shell itself is done.
    child.on("exit", (code) => setTimeout(() => finish(code), DRAIN_MS).unref());
    child.on("close", (code) => finish(code));
  });
}

/** Keeps the last `cap` bytes: when a hook fails, the end of its output says why. */
function tailBuffer(cap: number): { push: (chunk: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let dropped = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      bytes += chunk.length;
      for (let first = chunks[0]; first !== undefined && bytes - first.length >= cap; first = chunks[0]) {
        chunks.shift();
        bytes -= first.length;
        dropped += first.length;
      }
    },
    text() {
      let all = Buffer.concat(chunks);
      let skipped = dropped;
      if (all.length > cap) {
        skipped += all.length - cap;
        all = all.subarray(all.length - cap);
      }
      return (skipped > 0 ? `[${skipped} earlier bytes of output dropped]\n` : "") + all.toString("utf8");
    },
  };
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    // ESRCH: the group already exited between the timer firing and the kill.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      log.error("git.hook.kill_failed", { pid, err: error });
  }
}
