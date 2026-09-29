// One actor per agent (docs/architecture.md, "Agents at runtime"): every operation on the
// agent goes through its serial queue, and it is the only writer of the agent's log. It
// owns the live run: an oar Session whose records it appends verbatim, started lazily on
// input (resuming the runtime's own conversation) and stopped after an idle timeout.
import { awaitIdle, type ControlOutcome, type Session } from "@botiverse/oar";
import type { Actor, Attachment, EntryBody, InputMode, RunEndReason } from "../../shared/entries.ts";
import { newId } from "../../shared/ids.ts";
import type { SendResult } from "../../shared/schemas.ts";
import type { AgentSummary } from "../../shared/summary.ts";
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
  /** Called before an input starts a new turn (the "last turn" diff baseline). */
  readonly beforeTurn?: (agentId: string) => Promise<void>;
}

interface LiveRun {
  readonly runId: string;
  readonly session: Session;
  unsubscribe: () => void;
  stopping: boolean;
}

export interface SendInput {
  readonly inputId: string;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly mode: InputMode;
  readonly by: Actor;
  readonly trace?: string;
}

export class AgentActor {
  private queue: Promise<unknown> = Promise.resolve();
  private run: LiveRun | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

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
      });
      const result = await this.deliver(input);
      this.append({
        kind: "input.result",
        inputId: input.inputId,
        landed: result.landed,
        ...(result.runId === undefined ? {} : { runId: result.runId }),
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
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

  private async deliver(
    input: SendInput,
  ): Promise<{ landed: SendResult["landed"]; runId?: string; code?: string; reason?: string }> {
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
    const attachments = input.attachments ?? [];
    const text = runtimeText(input.text, attachments);
    // A runtime without image input still gets every image's path in the text.
    const images = session.capabilities.images ? runtimeImages(attachments) : [];
    const options = { inputId: input.inputId, ...(images.length === 0 ? {} : { images }) };
    const running = session.status().value.kind === "running";
    if (!running) {
      await this.deps.beforeTurn?.(this.id);
      return { runId, ...landing("prompted", await session.prompt(text, options)) };
    }
    switch (input.mode) {
      case "queue":
        return { runId, ...landing("queued", await session.queue(text, options)) };
      case "interrupt": {
        await session.abort();
        await awaitIdleFor(session, 30_000);
        await this.deps.beforeTurn?.(this.id);
        return { runId, ...landing("prompted", await session.prompt(text, options)) };
      }
      case "auto": {
        const result = await session.steerOrQueue(text, options);
        return result.landed === "rejected"
          ? { runId, landed: "rejected", code: result.code, reason: result.reason }
          : { runId, landed: result.landed };
      }
    }
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
    const base = {
      cwd,
      env: this.deps.env(this.id),
      ...(summary.model === null ? {} : { model: summary.model }),
      ...(summary.effort === null ? {} : { effort: summary.effort }),
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
          // The runtime lost the conversation (or never persisted it). Start a new one; the
          // log keeps the history, and says what happened.
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
      ...(resumed === undefined ? {} : { resume: resumed }),
    });
    log.info("agent.run.started", {
      run: runId,
      runtime: summary.runtime,
      resumed: resumed !== undefined,
      ms: Date.now() - started,
    });
    const run: LiveRun = { runId, session, stopping: false, unsubscribe: () => undefined };
    // From seq -1: records the runtime produced while starting are replayed, not lost.
    run.unsubscribe = session.rawEvents(
      (record) => {
        this.append({ kind: "oar", runId, record });
        if (record.kind === "response" && record.body.kind === "exited" && !run.stopping) {
          const code = record.body.code;
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
    return this.enqueue("stop", async () => {
      const run = this.run;
      if (run === null) return;
      run.stopping = true;
      try {
        await run.session.dispose();
      } catch (error) {
        log.error("agent.dispose_failed", { run: run.runId, err: serializeError(error) });
      }
      await this.finishRun(run, reason, null);
    });
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
    this.append({ kind: "run.ended", runId: run.runId, reason, ...(reason === "exited" ? { code } : {}) });
    log.info("agent.run.ended", { run: run.runId, reason, code });
  }

  /** Interrupt the running turn. Not queued: it must not wait behind the input it interrupts. */
  async abort(): Promise<{ accepted: boolean; reason?: string }> {
    const run = this.run;
    if (run === null) return { accepted: false, reason: "no live run" };
    const outcome = await run.session.abort();
    return outcome.kind === "accepted" ? { accepted: true } : { accepted: false, reason: outcome.reason };
  }

  // ─── Idle timeout ─────────────────────────────────────────────────────────

  /** Called by the service after each appended entry: arm the idle timer when the run goes idle. */
  noteActivity(summary: AgentSummary): void {
    if (this.closed || this.run === null) return;
    if (summary.status.kind === "running" || summary.pending.length > 0) {
      this.clearIdle();
      return;
    }
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const current = this.deps.summary(this.id);
      if (current.status.kind === "idle" && current.pending.length === 0) void this.stop("idle");
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
