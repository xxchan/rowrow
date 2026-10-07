// The summary fold: entries → what a list row, the attention model and notifications need
// to know about one agent. Pure and incremental (reduceSummary), so the server keeps one
// per agent up to date as entries are appended, and any tool can rebuild it from a log.
import type { ContextUsage, RawEvent, TokenTotals, TurnOutcome } from "@botiverse/oar";
import {
  appRequestKind,
  initialStatus,
  reduceStatus,
  reduceTasks,
  type AgentStatus,
  type TaskView,
} from "@botiverse/oar/observe";
import type { Actor, Attachment, Entry, EntryOf, QueuePauseReason } from "./entries.ts";

export interface PendingRequestSummary {
  readonly requestId: string;
  /** The runtime's own method or subtype, e.g. claude `can_use_tool`, codex `item/commandExecution/requestApproval`. */
  readonly type: string;
  /** The log entry that carried the request. */
  readonly seq: number;
}

/**
 * Whether the runtime reports reading a steered input (a `user_message` carrying its id).
 * Where it doesn't, oar accepting the steer is all anyone will learn, so that counts as read.
 */
export function echoesInput(runtime: string): boolean {
  return runtime === "claude" || runtime === "codex";
}

/**
 * Whether input can go into a running turn, for what the composer offers before sending.
 * The server asks the session (whether oar gave it a `steer`) and says so when it can't;
 * "redoes": grok takes it by starting the current step again.
 */
export function steerSupport(runtime: string): "yes" | "no" | "redoes" {
  if (runtime === "kimi" || runtime === "antigravity") return "no";
  return runtime === "grok" ? "redoes" : "yes";
}

/** An input rowrow holds until the running turn ends (D-035). */
export interface QueuedInput {
  readonly inputId: string;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly by: Actor;
  readonly at: number;
}

export interface AgentSummary {
  readonly workspaceId: string;
  readonly runtime: string;
  readonly title: string | null;
  /** The model you asked for; null means the runtime's default. */
  readonly model: string | null;
  /** The reasoning effort you asked for; null means the runtime's default. */
  readonly effort: string | null;
  readonly archived: boolean;
  readonly createdAt: number;
  /** The live run, while one is attached. */
  readonly run: { readonly runId: string; readonly sessionId: string; readonly since: number } | null;
  /** The runtime's own session id from the latest run: what the next run resumes. */
  readonly sessionId: string | null;
  /** The root agent's status in the live run (oar's fold); idle without a run. */
  readonly status: AgentStatus;
  /** The model the runtime reported it is using. */
  readonly reportedModel: string | null;
  /** The reasoning effort the runtime reported (claude reports none). */
  readonly reportedEffort: string | null;
  /** Runtime→app requests (an approval, a question) of the live run that nobody answered yet. */
  readonly pending: readonly PendingRequestSummary[];
  /** The latest turn the runtime ended, with its own outcome. */
  readonly lastTurn: { readonly seq: number; readonly at: number; readonly outcome: TurnOutcome } | null;
  /**
   * seq of the latest event worth your attention: a turn that completed or failed, a run
   * that failed to start or died on its own. -1 before any. `done` means this is after your
   * seen marker. An aborted turn or a run someone stopped is not one: you did that.
   */
  readonly lastCompletionSeq: number;
  readonly lastActivityAt: number;
  /** The tail of the agent's latest text, for list rows and notifications. */
  readonly preview: string | null;
  readonly lastError: string | null;
  /**
   * Tokens since the run's session opened (oar 0.30: every runtime counts from there, so a
   * resumed session starts again); null until the run reports them, and some never do (Codex
   * before 0.151 on a resumed session).
   */
  readonly usage: TokenTotals | null;
  readonly context: ContextUsage | null;
  readonly inputs: number;
  /** Inputs held for after the running turn, oldest first: sent one per turn, or taken back. */
  readonly queued: readonly QueuedInput[];
  /** Why rowrow stopped sending `queued`; null while it sends the next one when a turn ends. */
  readonly queuePaused: QueuePauseReason | null;
  /** Steered into the running turn, and the runtime hasn't said it read them yet (see echoesInput). */
  readonly steering: readonly QueuedInput[];
  /** Steered, but the turn or the run ended before the runtime read them: they may never have arrived. */
  readonly unread: readonly QueuedInput[];
  /** seq of the last folded entry; -1 before any. */
  readonly headSeq: number;
  /** Fold internals, derivable like the rest: the latest root event was text (so the next text joins the preview). */
  readonly textOpen: boolean;
  /**
   * Fold internals: the live run has been asked to stop, or its process exited to end a turn
   * you stopped, so its exit is not a surprise.
   */
  readonly stopping: boolean;
  /** Fold internals: the latest input, until its result says whether rowrow holds it. */
  readonly unanswered: QueuedInput | null;
  /**
   * What the runtime runs beside its turns, still going (oar's task events, folded by
   * reduceTasks): background commands, subagents, tool calls moved off the turn. They can run
   * on after the turn ends; they end with the run. Work the runtime does for itself is left out.
   */
  readonly tasks: readonly TaskView[];
}

const PREVIEW_CHARS = 280;

export function initialSummary(): AgentSummary {
  return {
    workspaceId: "",
    runtime: "",
    title: null,
    model: null,
    effort: null,
    archived: false,
    createdAt: 0,
    run: null,
    sessionId: null,
    status: initialStatus,
    reportedModel: null,
    reportedEffort: null,
    pending: [],
    lastTurn: null,
    lastCompletionSeq: -1,
    lastActivityAt: 0,
    preview: null,
    lastError: null,
    usage: null,
    context: null,
    inputs: 0,
    queued: [],
    queuePaused: null,
    steering: [],
    unread: [],
    headSeq: -1,
    textOpen: false,
    stopping: false,
    unanswered: null,
    tasks: [],
  };
}

export function reduceSummary(previous: AgentSummary, entry: Entry): AgentSummary {
  return { ...foldEntry(previous, entry), headSeq: entry.seq, lastActivityAt: entry.at };
}

export function summaryOf(entries: Iterable<Entry>): AgentSummary {
  let summary = initialSummary();
  for (const entry of entries) summary = reduceSummary(summary, entry);
  return summary;
}

function foldEntry(s: AgentSummary, entry: Entry): AgentSummary {
  switch (entry.kind) {
    case "agent.created":
      return {
        ...s,
        workspaceId: entry.workspaceId,
        runtime: entry.runtime,
        model: entry.model ?? null,
        effort: entry.effort ?? null,
        title: entry.title ?? null,
        createdAt: entry.at,
      };
    case "agent.updated": {
      const { changes } = entry;
      return {
        ...s,
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.model === undefined ? {} : { model: changes.model }),
        ...(changes.effort === undefined ? {} : { effort: changes.effort }),
        ...(changes.archived === undefined ? {} : { archived: changes.archived }),
      };
    }
    case "input":
      return {
        ...s,
        inputs: s.inputs + 1,
        unanswered: {
          inputId: entry.inputId,
          text: entry.text,
          attachments: entry.attachments ?? [],
          by: entry.by,
          at: entry.at,
        },
      };
    case "input.result": {
      const input = s.unanswered?.inputId === entry.inputId ? s.unanswered : null;
      const held = entry.held === true ? input : null;
      const steering = entry.landed === "steered" && echoesInput(s.runtime) ? input : null;
      return {
        ...s,
        unanswered: null,
        ...(held === null ? {} : { queued: [...s.queued, held] }),
        ...(steering === null ? {} : { steering: [...s.steering, steering] }),
        ...(entry.landed === "failed"
          ? { lastError: entry.reason ?? "the input could not be delivered" }
          : {}),
      };
    }
    case "input.sent":
      return {
        // Steered in when it went out as a steer; anything else it isn't (a rejected steer
        // falls back to a prompt).
        ...(entry.landed === "steered"
          ? unqueue(s, entry.inputId)
          : read(unqueue(s, entry.inputId), entry.inputId)),
        ...(entry.landed === "failed"
          ? { lastError: entry.reason ?? "the input could not be delivered" }
          : {}),
      };
    case "input.withdrawn": {
      const next = unqueue(s, entry.inputId);
      return next.unread.some((u) => u.inputId === entry.inputId)
        ? { ...next, unread: next.unread.filter((u) => u.inputId !== entry.inputId) }
        : next;
    }
    case "queue.paused":
      return s.queued.length === 0 ? s : { ...s, queuePaused: entry.reason };
    case "queue.resumed":
      return { ...s, queuePaused: null };
    case "run.started":
      return {
        ...s,
        run: { runId: entry.runId, sessionId: entry.sessionId, since: entry.at },
        sessionId: entry.sessionId,
        status: initialStatus,
        pending: [],
        tasks: [],
        lastError: null,
        textOpen: false,
        stopping: false,
        // The last run's count isn't this one's.
        usage: null,
      };
    case "run.failed":
      return { ...s, lastError: entry.error, lastCompletionSeq: entry.seq };
    case "run.ended":
      return s.run?.runId === entry.runId ? endRun(s, entry) : s;
    case "host.error":
      return { ...s, lastError: entry.message };
    case "oar": {
      // A held input leaves the queue as it goes out, not a moment later with input.sent.
      const { record } = entry;
      const sending =
        record.kind === "request" && record.direction === "toRuntime" && "inputId" in record.body
          ? record.body.inputId
          : undefined;
      const steered =
        record.kind === "request" && record.body.kind === "steer" && echoesInput(s.runtime)
          ? s.queued.find((q) => q.inputId === sending)
          : undefined;
      const unqueued = sending === undefined ? s : unqueue(s, sending);
      const next =
        steered === undefined ? unqueued : { ...unqueued, steering: [...unqueued.steering, steered] };
      return next.run?.runId === entry.runId
        ? foldRecord(next, next.run.sessionId, record, entry.seq, entry.at)
        : next;
    }
  }
}

function unqueue(s: AgentSummary, inputId: string): AgentSummary {
  if (!s.queued.some((q) => q.inputId === inputId)) return s;
  const queued = s.queued.filter((q) => q.inputId !== inputId);
  // Nothing left to hold back: a pause means nothing.
  return { ...s, queued, ...(queued.length === 0 ? { queuePaused: null } : {}) };
}

/** The runtime read a steered input. */
function read(s: AgentSummary, inputId: string): AgentSummary {
  const steering = s.steering.filter((q) => q.inputId !== inputId);
  const unread = s.unread.filter((q) => q.inputId !== inputId);
  return steering.length === s.steering.length && unread.length === s.unread.length
    ? s
    : { ...s, steering, unread };
}

/** The turn ended: whatever was steered into it and not read by now never will be. */
function unreadSteering(s: AgentSummary): AgentSummary {
  return s.steering.length === 0 ? s : { ...s, steering: [], unread: [...s.unread, ...s.steering] };
}

const ACTIVE = new Set<TaskView["status"]>(["pending", "running", "paused"]);

/** The runtime's tasks still going, after `record` (only frames that report tasks change them). */
function foldTasks(s: AgentSummary, record: RawEvent): AgentSummary {
  if (record.kind !== "frame" || !record.body.events.some((event) => event.kind.startsWith("task_")))
    return s;
  const known = reduceTasks(new Map(s.tasks.map((task) => [task.taskId, task])), record);
  return {
    ...s,
    tasks: [...known.values()].filter((task) => task.ambient !== true && ACTIVE.has(task.status)),
  };
}

function endRun(s: AgentSummary, entry: EntryOf<"run.ended">): AgentSummary {
  // A run the server lost (crashed) or that exited while a turn was open ended that turn
  // without the runtime saying so. That is a failure you should see.
  const surprise = !s.stopping && (entry.reason === "crashed" || entry.reason === "exited");
  const cutTurn = s.status.kind === "running";
  const failed = surprise && (cutTurn || (entry.code ?? 0) !== 0);
  const reason = describeEnd(entry.reason, entry.code);
  return {
    ...unreadSteering(s),
    run: null,
    pending: [],
    // Its processes ended with it.
    tasks: [],
    textOpen: false,
    stopping: false,
    status: cutTurn
      ? { kind: "idle", lastTurnOutcome: { kind: "failed", reason, failure: "runtime_exited" } }
      : s.status,
    ...(failed ? { lastError: reason, lastCompletionSeq: entry.seq } : {}),
  };
}

function foldRecord(
  s: AgentSummary,
  sessionId: string,
  record: RawEvent,
  seq: number,
  at: number,
): AgentSummary {
  const status = reduceStatus(s.status, record, sessionId);
  let next: AgentSummary = foldTasks(status === s.status ? s : { ...s, status }, record);
  const root = record.sessionId === sessionId && record.agentPath.length === 0;

  switch (record.kind) {
    case "request":
      if (record.direction === "toApp") {
        const type = record.body.kind === "native" ? record.body.type : record.body.kind;
        // A client call the adapter answers itself (grok's terminal/*) needs nobody.
        if (appRequestKind(type) === "service") return next;
        return { ...next, pending: [...next.pending, { requestId: record.id, type, seq }] };
      }
      if (record.body.kind === "dispose") return { ...next, stopping: true };
      return record.body.kind === "prompt" ? { ...next, textOpen: false } : next;
    case "response":
      if (next.pending.some((p) => p.requestId === record.requestId)) {
        return { ...next, pending: next.pending.filter((p) => p.requestId !== record.requestId) };
      }
      // Its processes ended with it: oar 0.38 ends every unfinished task at the root's exit
      // (stopped or failed), and this list holds only those still running.
      if (record.body.kind === "exited" && root) next = { ...next, tasks: [] };
      if (record.body.kind === "exited" && s.status.kind === "running" && !s.stopping) {
        // It ended a turn you stopped (oar ends one that doesn't stop in time): stopped, as if
        // the turn had ended so.
        if (next.status.kind === "idle" && next.status.lastTurnOutcome?.kind === "aborted")
          return {
            ...unreadSteering(next),
            stopping: true,
            lastTurn: { seq, at, outcome: next.status.lastTurnOutcome },
          };
        // The process died mid-turn on its own; oar's status fold already calls it failed.
        return { ...next, lastCompletionSeq: seq, lastError: describeEnd("exited", record.body.code) };
      }
      return next;
    case "frame":
      if (!root) return next;
      for (const event of record.body.events) {
        if (event.kind === "text_delta") {
          const text = next.textOpen ? (next.preview ?? "") + event.text : event.text;
          next = {
            ...next,
            preview: text.length > PREVIEW_CHARS ? text.slice(-PREVIEW_CHARS) : text,
            textOpen: true,
          };
          continue;
        }
        switch (event.kind) {
          case "turn_ended": {
            // A completed turn with more held behind it isn't done: rowrow sends the next one.
            const continues =
              event.outcome.kind === "completed" && next.queued.length > 0 && next.queuePaused === null;
            next = {
              // Stopped before it read what you steered in. (A turn that ends on its own
              // hands it to the next one on runtimes that echo, so the echo still comes.)
              ...(event.outcome.kind === "aborted" ? unreadSteering(next) : next),
              lastTurn: { seq, at, outcome: event.outcome },
              ...(event.outcome.kind === "aborted" || continues ? {} : { lastCompletionSeq: seq }),
              ...(event.outcome.kind === "failed" ? { lastError: event.outcome.reason } : {}),
            };
            break;
          }
          case "user_message":
            if (event.inputId !== undefined) next = read(next, event.inputId);
            break;
          case "model":
            next = { ...next, reportedModel: event.model };
            break;
          case "effort":
            next = { ...next, reportedEffort: event.effort };
            break;
          case "usage":
            if (event.usage.tokens !== undefined) next = { ...next, usage: event.usage.tokens };
            if (event.usage.context !== undefined) next = { ...next, context: event.usage.context };
            break;
          case "reasoning":
          case "tool_call_started":
          case "tool_call_input":
          case "tool_call_ended":
          case "tool_call_progress":
          case "compaction_started":
          case "compaction_ended":
          case "retry":
          // Folded by foldTasks, every agent's, not just the root's.
          case "task_started":
          case "task_updated":
          case "task_ended":
            break;
        }
        // Usage and model reports interleave with text on some runtimes; they don't end a text run.
        if (event.kind !== "usage" && event.kind !== "model" && event.kind !== "effort" && next.textOpen)
          next = { ...next, textOpen: false };
      }
      return next;
  }
}

function describeEnd(reason: string, code: number | null | undefined): string {
  switch (reason) {
    case "crashed":
      return "rowrow stopped while this agent was running";
    case "exited":
      return code === null || code === undefined
        ? "the agent process exited"
        : `the agent process exited with code ${code}`;
    default:
      return `the run ended (${reason})`;
  }
}

// ─── Attention ───────────────────────────────────────────────────────────────

/** Why an agent needs you, in priority order (docs/architecture.md, "Attention and notifications"). */
export type Attention = "blocked" | "done" | "working" | "idle";

export const ATTENTION_RANK: Readonly<Record<Attention, number>> = {
  blocked: 4,
  done: 3,
  working: 2,
  idle: 1,
};

export function attentionOf(summary: AgentSummary, seenSeq: number): Attention {
  if (summary.pending.length > 0) return "blocked";
  if (summary.status.kind === "running") return "working";
  if (summary.lastCompletionSeq > seenSeq) return "done";
  return "idle";
}

/** How long a working agent has been silent, when longer than `thresholdMs` (fold × clock). */
export function stalledFor(summary: AgentSummary, now: number, thresholdMs: number): number | null {
  if (summary.status.kind !== "running") return null;
  const silent = now - summary.status.lastEventAt;
  return silent >= thresholdMs ? silent : null;
}
