// One actor per agent (docs/architecture.md, "Agents at runtime"): every operation on the
// agent goes through its serial queue, and it is the only writer of the agent's log. It
// owns the live run: an oar Session whose records it appends verbatim, started lazily on
// input (resuming the runtime's own conversation) and stopped after an idle timeout. It
// holds input sent while a turn runs and sends it, one per turn, when the turn ends (D-035).
import {
  awaitIdle,
  SessionNotFoundError,
  UnsupportedOptionError,
  type ControlOutcome,
  type InputOrigin,
  type Session,
  type SessionOptions,
} from "@botiverse/oar";
import type { CoachMention } from "../../shared/coach-mentions.ts";
import type {
  Actor,
  Attachment,
  EntryBody,
  InputMode,
  QueuePauseReason,
  RunEndReason,
} from "../../shared/entries.ts";
import { newId } from "../../shared/ids.ts";
import type { SendResult } from "../../shared/schemas.ts";
import type { AgentSummary, QueuedInput } from "../../shared/summary.ts";
import { UserError } from "../errors.ts";
import { log, serializeError, withContext } from "../telemetry/log.ts";
import { runtimeImages, runtimeText } from "./input.ts";
import type { AgentLog } from "./log.ts";
import type { Runtimes } from "./runtimes.ts";

export interface ActorDeps {
  readonly log: AgentLog;
  readonly runtimes: Runtimes;
  /** The agent's current summary (kept by the service from the log). */
  readonly summary: (agentId: string) => AgentSummary;
  /** Where the agent works: its workspace's directory, or null when the workspace is gone. */
  readonly cwd: (agentId: string) => string | null;
  /** Environment for the agent's runs (ROWROW_* so the agent can use the rowrow CLI). */
  readonly env: (agentId: string) => Record<string, string>;
  readonly idleTimeoutMs: number;
  /** How long a stop waits behind other work before it ends the process itself (STOP_WAIT_MS). */
  readonly stopWaitMs?: number;
  /** Called before an input starts a new turn (the "last turn" diff baseline). */
  readonly beforeTurn?: (agentId: string) => Promise<void>;
  /**
   * More options for a run about to start (Coach's prompt, tools, MCP server and flags, D-044).
   * Its `env` goes under the agent's own: a name in both keeps `env`'s value.
   */
  readonly runOptions?: (
    agentId: string,
    runId: string,
  ) => Promise<
    Pick<SessionOptions, "systemPrompt" | "disallowedTools" | "mcpServers" | "launchArgs" | "env">
  >;
  /** The text the runtime reads for an input, from the text with its attachments listed (Coach frames it with the turn's scope). */
  readonly promptText?: (agentId: string, inputId: string, text: string) => string;
}

interface LiveRun {
  readonly runId: string;
  readonly session: Session;
  unsubscribe: () => void;
  stopping: boolean;
  /** Its dispose, once asked for: it settles when the process has exited. */
  disposed: Promise<void> | null;
  /** Its process exited (the code it exited with); the session takes nothing more. */
  exited: { readonly code: number | null } | null;
}

export interface SendInput {
  readonly inputId: string;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly mode: InputMode;
  readonly by: Actor;
  readonly trace?: string;
  /** Coach: the workspaces its tools may read in this turn (D-044). */
  readonly scope?: readonly string[];
  /** Coach, with Full access: its proposals in this turn execute (D-045). */
  readonly fullAccess?: true;
  /** Coach: the workspaces and agents the message references (checked against `scope`). */
  readonly mentions?: readonly CoachMention[];
}

/** How rowrow passed an input to the runtime, as oar answered. */
interface Delivery {
  readonly landed: SendResult["landed"];
  readonly runId?: string;
  readonly code?: string;
  readonly reason?: string;
  /** rowrow holds it until the turn ends (D-035). */
  readonly held?: true;
}

const ALREADY_SENT = "Already sent: the turn ended and it went to the agent before you edited it.";

/**
 * A stop waits its turn in the queue, but not forever: a task can be stuck on a runtime that
 * never answers (a Codex that doesn't reply to turn/start can't be interrupted either). After
 * this long the stop ends the process from outside the queue, which settles the stuck call.
 */
const STOP_WAIT_MS = 10_000;

export class AgentActor {
  private queue: Promise<unknown> = Promise.resolve();
  private run: LiveRun | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** A settle task is queued. */
  private settling = false;

  readonly id: string;
  private readonly deps: ActorDeps;

  constructor(id: string, deps: ActorDeps) {
    this.id = id;
    this.deps = deps;
  }

  get liveRun(): { runId: string; sessionId: string } | null {
    return this.run === null ? null : { runId: this.run.runId, sessionId: this.run.session.id };
  }

  private append(body: EntryBody): void {
    this.deps.log.append(this.id, body);
  }

  /** Run `task` after everything queued before it; failures are the caller's, not the queue's. */
  private enqueue<T>(name: string, task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => withContext({ agent: this.id }, task));
    this.queue = result.catch((error: unknown) => {
      if (error instanceof UserError) return; // the caller's to show
      log.error("agent.task_failed", { agent: this.id, task: name, err: serializeError(error) });
    });
    return result;
  }

  // ─── Input ────────────────────────────────────────────────────────────────

  send(input: SendInput): Promise<SendResult> {
    return this.enqueue("send", async () => {
      const existing = this.deps.log.findInput(this.id, input.inputId);
      if (existing.input !== undefined) {
        // A retry of an input we already took. Its first outcome stands; without one (the
        // server died in between) the outcome is unknown, and we never deliver twice.
        const result = existing.result;
        return result?.kind === "input.result"
          ? {
              inputId: input.inputId,
              landed: result.landed,
              ...(result.code === undefined ? {} : { code: result.code }),
              ...(result.reason === undefined ? {} : { reason: result.reason }),
              seq: existing.input.seq,
            }
          : {
              inputId: input.inputId,
              landed: "failed",
              code: "uncertain",
              reason: "an earlier attempt was cut off; check the transcript before resending",
              seq: existing.input.seq,
            };
      }
      const entry = this.deps.log.append(this.id, {
        kind: "input",
        inputId: input.inputId,
        text: input.text,
        ...(input.attachments === undefined || input.attachments.length === 0
          ? {}
          : { attachments: input.attachments }),
        mode: input.mode,
        by: input.by,
        ...(input.trace === undefined ? {} : { trace: input.trace }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.fullAccess === undefined ? {} : { fullAccess: input.fullAccess }),
        ...(input.mentions === undefined || input.mentions.length === 0 ? {} : { mentions: input.mentions }),
      });
      const result = await this.deliver(input);
      this.append({
        kind: "input.result",
        inputId: input.inputId,
        landed: result.landed,
        ...(result.runId === undefined ? {} : { runId: result.runId }),
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.held === undefined ? {} : { held: result.held }),
      });
      log.info("agent.input", {
        inputId: input.inputId,
        mode: input.mode,
        landed: result.landed,
        code: result.code,
      });
      return {
        inputId: input.inputId,
        landed: result.landed,
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        seq: entry.seq,
      };
    });
  }

  private async deliver(input: SendInput): Promise<Delivery> {
    const summary = this.deps.summary(this.id);
    const busy = this.busy();
    // Behind a running turn, or behind inputs still waiting for theirs: one per turn, in order.
    if ((input.mode === "queue" || input.mode === "auto") && (busy || waiting(summary)))
      return { landed: "queued", held: true };
    if (input.mode === "steer" && busy && !this.canSteer())
      return {
        landed: "queued",
        held: true,
        code: "steer_unsupported",
        reason: `${summary.runtime} can't take input in the middle of a turn; it goes after this one`,
      };
    const how = !busy ? "prompt" : input.mode === "interrupt" ? "interrupt" : "steer";
    return this.dispatch(input.inputId, input.text, input.attachments ?? [], how, input.by);
  }

  /** Whether the live run is in a turn. */
  private busy(): boolean {
    return this.run !== null && this.run.session.status().value.kind === "running";
  }

  /**
   * Give an input to the runtime: as a new turn, steered into the running one (a new turn
   * if that turn ended meanwhile), or as a new turn after aborting the running one.
   */
  private async dispatch(
    inputId: string,
    body: string,
    attachments: readonly Attachment[],
    how: "prompt" | "steer" | "interrupt",
    by: Actor,
  ): Promise<Delivery> {
    let run: LiveRun;
    try {
      run = await this.ensureRun();
    } catch (error) {
      return {
        landed: "failed",
        code: "run_failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const { session, runId } = run;
    const listed = runtimeText(body, attachments);
    const text = this.deps.promptText?.(this.id, inputId, listed) ?? listed;
    // A runtime without image input still gets every image's path in the text.
    const images = session.capabilities.images ? runtimeImages(attachments) : [];
    const options = { inputId, origin: originOf(by), ...(images.length === 0 ? {} : { images }) };
    if (session.status().value.kind === "running") {
      if (how === "steer") {
        // Callers check canSteer first; a session without steer never gets here steering.
        if (session.steer === undefined)
          return { runId, landed: "rejected", code: "steer_unsupported", reason: "this runtime can't steer" };
        const outcome = await session.steer(text, options);
        if (outcome.kind === "accepted") return { runId, landed: "steered" };
        // Most often the turn ended as it came: then it starts the next one.
        await awaitIdleFor(session, 2_000);
        if (session.status().value.kind === "running")
          return { runId, landed: "rejected", code: outcome.code, reason: outcome.reason };
      } else if (how === "interrupt") {
        await session.abort();
        await awaitIdleFor(session, 30_000);
        // A runtime that doesn't stop in time is ended (oar 0.36: Claude Code and Codex after
        // 10 s): end this run, and the input goes to the conversation resumed.
        if (run.exited !== null) {
          await this.finishRun(run, "exited", run.exited.code);
          return this.dispatch(inputId, body, attachments, "prompt", by);
        }
      }
    }
    await this.deps.beforeTurn?.(this.id);
    return { runId, ...landing("prompted", await session.prompt(text, options)) };
  }

  // ─── Held inputs (D-035) ──────────────────────────────────────────────────

  /** Take a held input back, to edit or drop it. Fails once it went to the agent. */
  withdraw(inputId: string, by: Actor): Promise<{ text: string; attachments: readonly Attachment[] }> {
    return this.enqueue("withdraw", async () => {
      const summary = this.deps.summary(this.id);
      const item =
        summary.queued.find((q) => q.inputId === inputId) ??
        summary.unread.find((q) => q.inputId === inputId);
      if (item === undefined) throw new UserError(ALREADY_SENT, "CONFLICT");
      this.append({ kind: "input.withdrawn", inputId, by });
      log.info("agent.input.withdrawn", { inputId });
      return { text: item.text, attachments: item.attachments };
    });
  }

  /** The live session can take input mid-turn (oar 0.17: a session that can't has no `steer`). */
  private canSteer(): boolean {
    return this.run === null || this.run.session.steer !== undefined;
  }

  /** Send a held input now, out of turn: steered into the running turn, or as the next one. */
  sendNow(inputId: string): Promise<SendResult> {
    return this.enqueue("send_now", async () => {
      const summary = this.deps.summary(this.id);
      const item = summary.queued.find((q) => q.inputId === inputId);
      if (item === undefined) throw new UserError(ALREADY_SENT, "CONFLICT");
      const busy = this.busy();
      // It can't go into this turn: it stays where it is, going after it, and the answer says so
      // (the same as a steer to it).
      if (busy && !this.canSteer())
        return {
          inputId,
          landed: "queued",
          code: "steer_unsupported",
          reason: `${summary.runtime} can't take input in the middle of a turn; it goes after this one`,
          seq: this.deps.log.findInput(this.id, inputId).input?.seq ?? -1,
        };
      const result = await this.sendHeld(item, busy ? "steer" : "prompt");
      return {
        inputId,
        landed: result.landed,
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        seq: this.deps.log.findInput(this.id, inputId).input?.seq ?? -1,
      };
    });
  }

  /** Send held inputs again after a pause, starting with the next one now. */
  resume(by: Actor): Promise<void> {
    return this.enqueue("resume", async () => {
      if (this.deps.summary(this.id).queuePaused !== null) this.append({ kind: "queue.resumed", by });
      // Not through settle: it would pause again on the turn that paused it.
      const next = this.deps.summary(this.id).queued[0];
      if (next !== undefined && !this.busy()) await this.sendHead(next);
    });
  }

  private async sendHeld(item: QueuedInput, how: "prompt" | "steer"): Promise<Delivery> {
    const result = await this.dispatch(item.inputId, item.text, item.attachments, how, item.by);
    const landed = result.landed === "queued" ? "rejected" : result.landed; // dispatch never queues
    this.append({
      kind: "input.sent",
      inputId: item.inputId,
      landed,
      ...(result.runId === undefined ? {} : { runId: result.runId }),
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    });
    log.info("agent.input.sent", { inputId: item.inputId, landed, code: result.code });
    return { ...result, landed };
  }

  /** The next held input starts a turn; if it can't, the rest wait for you. */
  private async sendHead(item: QueuedInput): Promise<void> {
    const result = await this.sendHeld(item, "prompt");
    if (result.landed !== "prompted") this.pause("failed");
  }

  private pause(reason: QueuePauseReason): void {
    const summary = this.deps.summary(this.id);
    if (summary.queued.length === 0 || summary.queuePaused !== null) return;
    this.append({ kind: "queue.paused", reason });
    log.info("agent.queue.paused", { reason, queued: summary.queued.length });
  }

  private settleSoon(): void {
    if (this.settling) return;
    this.settling = true;
    void this.enqueue("settle", async () => {
      this.settling = false;
      await this.settle();
    });
  }

  /** The agent went idle with inputs held: send the next, unless the turn didn't end well. */
  private async settle(): Promise<void> {
    if (this.closed || this.run?.stopping === true || this.busy()) return;
    const summary = this.deps.summary(this.id);
    if (!waiting(summary) || summary.status.kind !== "idle") return;
    const outcome = summary.status.lastTurnOutcome;
    if (outcome?.kind === "aborted") this.pause("stopped");
    else if (outcome?.kind === "failed")
      this.pause(outcome.failure === "runtime_exited" ? "exited" : "failed");
    else if (summary.queued[0] !== undefined) await this.sendHead(summary.queued[0]);
  }

  // ─── Runs ─────────────────────────────────────────────────────────────────

  private async ensureRun(): Promise<LiveRun> {
    if (this.run !== null) return this.run;
    const summary = this.deps.summary(this.id);
    const cwd = this.deps.cwd(this.id);
    const runId = newId("run");
    if (cwd === null) {
      const error = "the agent's workspace no longer exists";
      this.append({ kind: "run.failed", runId, error });
      throw new Error(error);
    }
    const more = (await this.deps.runOptions?.(this.id, runId)) ?? {};
    const base: SessionOptions = {
      cwd,
      ...more,
      env: { ...more.env, ...this.deps.env(this.id) },
      ...(summary.model === null ? {} : { model: summary.model }),
      ...(summary.effort === null ? {} : { effort: summary.effort }),
      ...(summary.serviceTier === null ? {} : { serviceTier: summary.serviceTier }),
    };
    let session: Session;
    let resumed: string | undefined;
    const started = Date.now();
    try {
      if (summary.sessionId !== null) {
        try {
          session = await this.deps.runtimes.start(summary.runtime, { ...base, resume: summary.sessionId });
          resumed = summary.sessionId;
        } catch (error) {
          // Only when the runtime says the conversation is gone, or lives in another folder it
          // won't resume from here (kimi, opencode: `cwd`), does a new one start (D-056); the log
          // keeps the history, and says what happened. Any other failure (a login, the network,
          // the process, an option the runtime refuses, which a new one would refuse too) fails
          // the run, so sending again retries the resume instead of quietly dropping what the
          // agent knew.
          const lost =
            error instanceof SessionNotFoundError ||
            (error instanceof UnsupportedOptionError && error.option === "cwd");
          if (!lost) throw error;
          const message = error instanceof Error ? error.message : String(error);
          log.warn("agent.resume_failed", {
            runtime: summary.runtime,
            sessionId: summary.sessionId,
            err: serializeError(error),
          });
          this.append({
            kind: "host.error",
            code: "resume_failed",
            message: `could not resume the conversation, starting a new one: ${message}`,
          });
          session = await this.deps.runtimes.start(summary.runtime, base);
        }
      } else {
        session = await this.deps.runtimes.start(summary.runtime, base);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("agent.run_failed", { runtime: summary.runtime, run: runId, err: serializeError(error) });
      this.append({ kind: "run.failed", runId, error: message });
      throw error;
    }
    this.append({
      kind: "run.started",
      runId,
      runtime: summary.runtime,
      cwd,
      sessionId: session.id,
      ...(summary.model === null ? {} : { model: summary.model }),
      ...(summary.effort === null ? {} : { effort: summary.effort }),
      ...(summary.serviceTier === null ? {} : { serviceTier: summary.serviceTier }),
      ...(resumed === undefined ? {} : { resume: resumed }),
    });
    log.info("agent.run.started", {
      run: runId,
      runtime: summary.runtime,
      resumed: resumed !== undefined,
      ms: Date.now() - started,
    });
    const run: LiveRun = {
      runId,
      session,
      stopping: false,
      disposed: null,
      exited: null,
      unsubscribe: () => undefined,
    };
    // From seq -1: records the runtime produced while starting are replayed, not lost.
    run.unsubscribe = session.rawEvents(
      (record) => {
        this.append({ kind: "oar", runId, record });
        if (record.kind === "response" && record.body.kind === "exited" && !run.stopping) {
          const code = record.body.code;
          run.exited = { code };
          void this.enqueue("exited", async () => this.finishRun(run, "exited", code));
        }
      },
      { sessionId: session.id, afterSeq: -1 },
    );
    this.run = run;
    return run;
  }

  /** Stop the live run, if any. The conversation stays; the next input resumes it. */
  stop(reason: RunEndReason): Promise<void> {
    const waitMs = this.deps.stopWaitMs ?? STOP_WAIT_MS;
    const stuck = setTimeout(() => {
      const run = this.run;
      if (run === null || run.stopping) return;
      log.warn("agent.stop_forced", { run: run.runId, waitedMs: waitMs });
      void this.dispose(run);
    }, waitMs);
    stuck.unref();
    return this.enqueue("stop", async () => {
      clearTimeout(stuck);
      const run = this.run;
      if (run === null) return;
      // Done only once the process is gone, also when the timer above began ending it.
      await this.dispose(run);
      await this.finishRun(run, reason, null);
    });
  }

  /** End the run's process, once; resolves when it has exited. */
  private dispose(run: LiveRun): Promise<void> {
    run.stopping = true;
    run.disposed ??= run.session.dispose().catch((error: unknown) => {
      log.error("agent.dispose_failed", { run: run.runId, err: serializeError(error) });
    });
    return run.disposed;
  }

  private async finishRun(run: LiveRun, reason: RunEndReason, code: number | null): Promise<void> {
    if (this.run !== run) return; // already finished
    if (reason === "exited") {
      // The process died on its own; dispose releases what oar still holds.
      run.stopping = true;
      await run.session.dispose().catch(() => undefined);
    }
    run.unsubscribe();
    this.run = null;
    this.clearIdle();
    // Held inputs don't start a new run by themselves when you ended this one.
    // An exit that ended a turn you stopped is that stop.
    if (reason === "exited") this.pause(this.deps.summary(this.id).stopping ? "stopped" : "exited");
    else if (reason === "stopped" || reason === "archived" || reason === "restart") this.pause("stopped");
    this.append({ kind: "run.ended", runId: run.runId, reason, ...(reason === "exited" ? { code } : {}) });
    log.info("agent.run.ended", { run: run.runId, reason, code });
  }

  /** Interrupt the running turn. Not queued: it must not wait behind the input it interrupts. */
  async abort(): Promise<{ accepted: boolean; reason?: string }> {
    const run = this.run;
    if (run === null) return { accepted: false, reason: "no live run" };
    const outcome = await run.session.abort();
    // Its process ended before it answered (oar ends one that doesn't stop in time): the turn
    // is over all the same.
    if (outcome.kind === "accepted" || outcome.code === "runtime_exited") return { accepted: true };
    return { accepted: false, reason: outcome.reason };
  }

  // ─── Idle timeout ─────────────────────────────────────────────────────────

  /** Called by the service after each appended entry: arm the idle timer when the run goes idle. */
  noteActivity(summary: AgentSummary): void {
    if (this.closed) return;
    // Work still running in the background (a dev server, a build) isn't idle: stopping the
    // run would end it too (oar 0.36.1 ends a runtime's processes with it).
    if (summary.status.kind === "running" || summary.pending.length > 0 || summary.tasks.length > 0) {
      this.clearIdle();
      return;
    }
    if (waiting(summary)) {
      // Idle with inputs held: the next one goes now, so no idle timeout.
      this.clearIdle();
      this.settleSoon();
      return;
    }
    if (this.run === null) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const current = this.deps.summary(this.id);
      if (
        current.status.kind === "idle" &&
        current.pending.length === 0 &&
        current.tasks.length === 0 &&
        !waiting(current)
      )
        void this.stop("idle");
    }, this.deps.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Server shutdown: stop the run and refuse further work. */
  async close(reason: RunEndReason): Promise<void> {
    await this.stop(reason);
    this.closed = true;
    this.clearIdle();
  }
}

/** Inputs are held and rowrow will send the next when the agent is idle. */
export function waiting(summary: AgentSummary): boolean {
  return summary.queued.length > 0 && summary.queuePaused === null;
}

function landing(
  success: "prompted" | "queued",
  outcome: ControlOutcome,
): { landed: SendResult["landed"]; code?: string; reason?: string } {
  return outcome.kind === "accepted"
    ? { landed: success }
    : { landed: "rejected", code: outcome.code, reason: outcome.reason };
}

/** oar's awaitIdle, bounded: an interrupt must not hang on a runtime that never ends its turn. */
async function awaitIdleFor(session: Session, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    awaitIdle(session),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Who sent an input, in oar's words (recorded with the request, never sent to the runtime): a
 * person on a device typed it; another agent or rowrow itself is automation.
 */
function originOf(by: Actor): InputOrigin {
  switch (by.kind) {
    case "device":
      return { kind: "user", source: by.name };
    case "agent":
      return { kind: "automation", source: `agent:${by.agentId}` };
    case "system":
      return { kind: "automation", source: "rowrow" };
  }
}
