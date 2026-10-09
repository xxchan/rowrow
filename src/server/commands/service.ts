// Commands run in a workspace (docs/decisions.md, D-052): tests, `git status`, restarting a dev
// server, without an agent's tokens or a terminal. Each is the user's shell running `-c
// <command>` in the workspace's directory, in a process group of its own, with no input (stdin
// is /dev/null) and stdout and stderr interleaved as they arrive. Stop sends the group SIGTERM,
// then SIGKILL after a grace period; when the shell exits, whatever it left in its group is
// stopped the same way, so nothing it started runs on unseen. Runs live in memory, not in an
// agent's log: the newest RUNS_KEPT per workspace, each with the start and the end of its output,
// until the server stops, which stops them all.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  appendOutput,
  NO_OUTPUT,
  outputSince,
  RUNS_KEPT,
  STOP_GRACE_MS,
  type CommandOutput,
  type CommandRun,
  type OutputText,
} from "../../shared/commands.ts";
import type { Actor } from "../../shared/entries.ts";
import { newId } from "../../shared/ids.ts";
import { notFound, UserError } from "../errors.ts";
import { log, serializeError } from "../telemetry/log.ts";
import type { Workspaces } from "../workspaces/service.ts";

/** How long a run waits for output after its shell exits, from what it left holding the pipes. */
const DRAIN_MS = 500;

export interface CommandsDeps {
  readonly workspaces: Pick<Workspaces, "require" | "archived">;
  /** The environment a command gets, read at each start (commandEnv). */
  readonly env: () => NodeJS.ProcessEnv;
  readonly graceMs?: number;
  /** Runs kept per workspace. */
  readonly keep?: number;
  /** Output kept per run (tests make it small). */
  readonly limits?: { readonly head: number; readonly tail: number };
}

interface Live {
  run: CommandRun;
  output: OutputText;
  readonly followers: Set<(event: CommandOutput) => void>;
  /** The shell's pid, which is its process group's id. */
  pid: number | undefined;
  killTimer: NodeJS.Timeout | null;
  readonly ended: Promise<void>;
  end(): void;
}

/**
 * The server's environment for a command, without the credentials of a rowrow that started this
 * server (an agent's ROWROW_TOKEN, ROWROW_URL, ROWROW_AGENT_ID…): every ROWROW_ variable but
 * ROWROW_HOME goes, and ROWROW_PROFILE names this server's profile, so `rowrow` in a command
 * talks to this server as the CLI in your terminal would.
 */
export function commandEnv(base: NodeJS.ProcessEnv, profile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (!key.startsWith("ROWROW_") || key === "ROWROW_HOME") env[key] = value;
  env["ROWROW_PROFILE"] = profile;
  return env;
}

/** The user's shell when it is one we can run, else sh. */
function shellOf(env: NodeJS.ProcessEnv): string {
  const shell = env["SHELL"];
  return shell !== undefined && path.isAbsolute(shell) && fs.existsSync(shell) ? shell : "/bin/sh";
}

// Process groups of running commands, killed if this process exits without close() (an
// uncaught error, process.exit). A server killed with SIGKILL can't do even that (D-052).
const groups = new Set<number>();
let exitHooked = false;
function track(pid: number): void {
  groups.add(pid);
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const group of groups) signalGroup(group, "SIGKILL");
  });
}

/** Signal a whole process group; false when nothing is left in it. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      log.error("command.kill_failed", { pid, signal, err: serializeError(error) });
    return false;
  }
}

export class Commands {
  private readonly deps: CommandsDeps;
  /** Every kept run, oldest first. */
  private readonly runs = new Map<string, Live>();
  private readonly watchers = new Map<string, Set<(runs: CommandRun[]) => void>>();
  private closed = false;

  constructor(deps: CommandsDeps) {
    this.deps = deps;
  }

  /** Start a command in a workspace's directory. Refused in an archived or missing workspace. */
  start(input: { workspaceId: string; command: string; by: Actor }): CommandRun {
    const command = input.command.trim();
    if (command === "") throw new UserError("say which command to run");
    const ws = this.deps.workspaces.require(input.workspaceId);
    if (this.deps.workspaces.archived(ws.id))
      throw new UserError(
        `${ws.label} is archived: unarchive the workspace to run commands there`,
        "PRECONDITION_FAILED",
      );
    if (ws.missing || !fs.existsSync(ws.path))
      throw new UserError(`${ws.path} no longer exists, so nothing can run there`, "PRECONDITION_FAILED");
    if (this.closed) throw new UserError("the server is stopping", "PRECONDITION_FAILED");
    const keep = this.deps.keep ?? RUNS_KEPT;
    const running = this.inWorkspace(ws.id).filter((live) => live.run.status === "running").length;
    if (running >= keep)
      throw new UserError(
        `${running} commands are running in ${ws.label}: stop one, then run this`,
        "TOO_MANY_REQUESTS",
      );

    let end = (): void => undefined;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const live: Live = {
      run: {
        id: newId("cmd"),
        workspaceId: ws.id,
        command,
        cwd: ws.path,
        by: input.by,
        startedAt: Date.now(),
        endedAt: null,
        status: "running",
        exitCode: null,
        signal: null,
        stopping: false,
        error: null,
      },
      output: NO_OUTPUT,
      followers: new Set(),
      pid: undefined,
      killTimer: null,
      ended,
      end,
    };
    this.runs.set(live.run.id, live);
    this.spawn(live);
    this.prune(ws.id);
    this.changed(ws.id);
    log.info("command.started", { ws: ws.id, run: live.run.id, pid: live.pid, chars: command.length });
    return live.run;
  }

  get(runId: string): CommandRun {
    return this.require(runId).run;
  }

  /** Kept runs, newest first: one workspace's, or every workspace's. */
  list(workspaceId?: string): CommandRun[] {
    const all = [...this.runs.values()].map((live) => live.run);
    return (workspaceId === undefined ? all : all.filter((run) => run.workspaceId === workspaceId)).reverse();
  }

  /** A workspace's runs now, then again each time one starts, stops, ends or is forgotten. */
  watch(workspaceId: string, listener: (runs: CommandRun[]) => void): () => void {
    let set = this.watchers.get(workspaceId);
    if (set === undefined) {
      set = new Set();
      this.watchers.set(workspaceId, set);
    }
    set.add(listener);
    listener(this.list(workspaceId));
    return () => {
      set.delete(listener);
      if (set.size === 0) this.watchers.delete(workspaceId);
    };
  }

  /**
   * A run's kept output after a cursor, then what it prints as it prints it, then its end. A run
   * that already ended gets its end at once.
   */
  follow(runId: string, after: number, listener: (event: CommandOutput) => void): () => void {
    const live = this.require(runId);
    for (const piece of outputSince(live.output, after)) listener({ kind: "output", ...piece });
    if (live.run.status !== "running") {
      listener({ kind: "end", run: live.run });
      return () => undefined;
    }
    live.followers.add(listener);
    return () => live.followers.delete(listener);
  }

  /** Stop a run: SIGTERM to its process group, SIGKILL after the grace period. */
  stop(runId: string): CommandRun {
    const live = this.require(runId);
    if (live.run.status !== "running" || live.run.stopping) return live.run;
    live.run = { ...live.run, stopping: true };
    this.changed(live.run.workspaceId);
    log.info("command.stopping", { ws: live.run.workspaceId, run: runId });
    this.terminate(live);
    return live.run;
  }

  /** Stop every run in a workspace and wait for them to end (archiving it, removing its checkout). */
  async stopAllIn(workspaceId: string): Promise<void> {
    const running = this.inWorkspace(workspaceId).filter((live) => live.run.status === "running");
    for (const live of running) this.stop(live.run.id);
    await Promise.all(running.map(async (live) => live.ended));
  }

  /** A workspace rowrow forgot: stop its runs, then drop them. */
  async forget(workspaceId: string): Promise<void> {
    await this.stopAllIn(workspaceId);
    for (const live of this.inWorkspace(workspaceId)) this.runs.delete(live.run.id);
    this.changed(workspaceId);
  }

  /** The server is stopping: stop every run, and kill what hasn't ended by the end of the grace period. */
  async close(): Promise<void> {
    this.closed = true;
    const running = [...this.runs.values()].filter((live) => live.run.status === "running");
    for (const live of running) this.stop(live.run.id);
    const grace = (this.deps.graceMs ?? STOP_GRACE_MS) + 1000;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(running.map(async (live) => live.ended)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, grace);
      }),
    ]);
    clearTimeout(timer);
    for (const live of running) {
      if (live.killTimer !== null) clearTimeout(live.killTimer);
      if (live.pid !== undefined) {
        signalGroup(live.pid, "SIGKILL");
        groups.delete(live.pid);
      }
    }
  }

  private spawn(live: Live): void {
    const env = this.deps.env();
    const child = spawn(shellOf(env), ["-c", live.run.command], {
      cwd: live.run.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    live.pid = child.pid;
    if (child.pid !== undefined) track(child.pid);
    let exit: { code: number | null; signal: NodeJS.Signals | null; at: number } | null = null;
    let finished = false;
    const out = new StringDecoder("utf8");
    const err = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => this.write(live, out.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => this.write(live, err.write(chunk)));

    const finish = (error: Error | null): void => {
      if (finished) return;
      finished = true;
      this.write(live, out.end() + err.end());
      if (live.pid !== undefined) groups.delete(live.pid);
      const stopped = live.run.stopping;
      live.run = {
        ...live.run,
        endedAt: exit?.at ?? Date.now(),
        status: error !== null ? "failed" : stopped ? "stopped" : "exited",
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        stopping: false,
        error: error === null ? null : error.message,
      };
      const fields = {
        ws: live.run.workspaceId,
        run: live.run.id,
        status: live.run.status,
        code: live.run.exitCode,
        signal: live.run.signal,
        ms: (live.run.endedAt ?? 0) - live.run.startedAt,
        chars: live.output.cursor,
      };
      if (error === null) log.info("command.ended", fields);
      else log.warn("command.ended", { ...fields, err: serializeError(error) });
      for (const follower of live.followers) follower({ kind: "end", run: live.run });
      live.followers.clear();
      live.end();
      this.prune(live.run.workspaceId);
      this.changed(live.run.workspaceId);
    };

    // spawn reports a shell or directory it can't use here, not by throwing.
    child.on("error", (error) => {
      if (exit === null) finish(error);
      else log.error("command.child_error", { run: live.run.id, err: serializeError(error) });
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal, at: Date.now() };
      // What the shell left running in its group goes with it (D-052).
      this.terminate(live);
      setTimeout(() => finish(null), DRAIN_MS).unref();
    });
    child.on("close", () => {
      if (exit !== null) finish(null);
    });
  }

  /** SIGTERM to the run's process group, and SIGKILL after the grace period if anything is left. */
  private terminate(live: Live): void {
    if (live.pid === undefined || live.killTimer !== null) return;
    const pid = live.pid;
    if (!signalGroup(pid, "SIGTERM")) return;
    live.killTimer = setTimeout(() => {
      if (signalGroup(pid, "SIGKILL")) log.warn("command.killed", { run: live.run.id, pid });
      groups.delete(pid);
    }, this.deps.graceMs ?? STOP_GRACE_MS);
    live.killTimer.unref();
  }

  private write(live: Live, text: string): void {
    if (text === "") return;
    const at = live.output.cursor;
    live.output = appendOutput(live.output, at, text, this.deps.limits);
    for (const follower of live.followers) follower({ kind: "output", at, text });
  }

  /** Forget a workspace's oldest finished runs beyond what it keeps. */
  private prune(workspaceId: string): void {
    const keep = this.deps.keep ?? RUNS_KEPT;
    const runs = this.inWorkspace(workspaceId);
    let excess = runs.length - keep;
    for (const live of runs) {
      if (excess <= 0) break;
      if (live.run.status === "running") continue;
      this.runs.delete(live.run.id);
      excess--;
    }
  }

  private inWorkspace(workspaceId: string): Live[] {
    return [...this.runs.values()].filter((live) => live.run.workspaceId === workspaceId);
  }

  private changed(workspaceId: string): void {
    const set = this.watchers.get(workspaceId);
    if (set === undefined) return;
    const runs = this.list(workspaceId);
    for (const listener of set) listener(runs);
  }

  private require(runId: string): Live {
    const live = this.runs.get(runId);
    if (live === undefined) throw notFound(`command run ${runId}`);
    return live;
  }
}
