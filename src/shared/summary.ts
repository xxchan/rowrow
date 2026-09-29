// The summary fold: entries → what a list row, the attention model and notifications need
// to know about one agent. Pure and incremental (reduceSummary), so the server keeps one
// per agent up to date as entries are appended, and any tool can rebuild it from a log.
import type { ContextUsage, RawEvent, TokenTotals, TurnOutcome } from "@botiverse/oar";
import { initialStatus, reduceStatus, type AgentStatus } from "@botiverse/oar/observe";
import type { Entry, EntryOf } from "./entries.ts";

export interface PendingRequestSummary {
  readonly requestId: string;
  /** The runtime's own method or subtype, e.g. claude `can_use_tool`, codex `item/commandExecution/requestApproval`. */
  readonly type: string;
  /** The log entry that carried the request. */
  readonly seq: number;
}

export interface AgentSummary {
  readonly workspaceId: string;
  readonly runtime: string;
  readonly title: string | null;
  /** The model you asked for; null means the runtime's default. */
  readonly model: string | null;
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
  readonly usage: TokenTotals | null;
  readonly context: ContextUsage | null;
  readonly inputs: number;
  /** seq of the last folded entry; -1 before any. */
  readonly headSeq: number;
  /** Fold internals, derivable like the rest: the latest root event was text (so the next text joins the preview). */
  readonly textOpen: boolean;
  /** Fold internals: the live run has been asked to stop, so its exit is not a surprise. */
  readonly stopping: boolean;
}

const PREVIEW_CHARS = 280;

export function initialSummary(): AgentSummary {
  return {
    workspaceId: "",
    runtime: "",
    title: null,
    model: null,
    archived: false,
    createdAt: 0,
    run: null,
    sessionId: null,
    status: initialStatus,
    reportedModel: null,
    pending: [],
    lastTurn: null,
    lastCompletionSeq: -1,
    lastActivityAt: 0,
    preview: null,
    lastError: null,
    usage: null,
    context: null,
    inputs: 0,
    headSeq: -1,
    textOpen: false,
    stopping: false,
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
        title: entry.title ?? null,
        createdAt: entry.at,
      };
    case "agent.updated": {
      const { changes } = entry;
      return {
        ...s,
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.model === undefined ? {} : { model: changes.model }),
        ...(changes.archived === undefined ? {} : { archived: changes.archived }),
      };
    }
    case "input":
      return { ...s, inputs: s.inputs + 1 };
    case "input.result":
      return entry.landed === "failed" ? { ...s, lastError: entry.reason ?? "the input could not be delivered" } : s;
    case "run.started":
      return {
        ...s,
        run: { runId: entry.runId, sessionId: entry.sessionId, since: entry.at },
        sessionId: entry.sessionId,
        status: initialStatus,
        pending: [],
        lastError: null,
        textOpen: false,
        stopping: false,
      };
    case "run.failed":
      return { ...s, lastError: entry.error, lastCompletionSeq: entry.seq };
    case "run.ended":
      return s.run?.runId === entry.runId ? endRun(s, entry) : s;
    case "host.error":
      return { ...s, lastError: entry.message };
    case "oar":
      return s.run?.runId === entry.runId ? foldRecord(s, s.run.sessionId, entry.record, entry.seq, entry.at) : s;
  }
}

function endRun(s: AgentSummary, entry: EntryOf<"run.ended">): AgentSummary {
  // A run the server lost (crashed) or that exited while a turn was open ended that turn
  // without the runtime saying so. That is a failure you should see.
  const surprise = !s.stopping && (entry.reason === "crashed" || entry.reason === "exited");
  const cutTurn = s.status.kind === "running";
  const failed = surprise && (cutTurn || (entry.code ?? 0) !== 0);
  const reason = describeEnd(entry.reason, entry.code);
  return {
    ...s,
    run: null,
    pending: [],
    textOpen: false,
    stopping: false,
    status: cutTurn ? { kind: "idle", lastTurnOutcome: { kind: "failed", reason, failure: "runtime_exited" } } : s.status,
    ...(failed ? { lastError: reason, lastCompletionSeq: entry.seq } : {}),
  };
}

function foldRecord(s: AgentSummary, sessionId: string, record: RawEvent, seq: number, at: number): AgentSummary {
  const status = reduceStatus(s.status, record, sessionId);
  let next: AgentSummary = status === s.status ? s : { ...s, status };
  const root = record.sessionId === sessionId && record.agentPath.length === 0;

  switch (record.kind) {
    case "request":
      if (record.direction === "toApp") {
        const type = record.body.kind === "native" ? record.body.type : record.body.kind;
        return { ...next, pending: [...next.pending, { requestId: record.id, type, seq }] };
      }
      if (record.body.kind === "dispose") return { ...next, stopping: true };
      return record.body.kind === "prompt" ? { ...next, textOpen: false } : next;
    case "response":
      if (next.pending.some((p) => p.requestId === record.requestId)) {
        return { ...next, pending: next.pending.filter((p) => p.requestId !== record.requestId) };
      }
      if (record.body.kind === "exited" && s.status.kind === "running" && !s.stopping) {
        // The process died mid-turn on its own; oar's status fold already calls it failed.
        return { ...next, lastCompletionSeq: seq, lastError: describeEnd("exited", record.body.code) };
      }
      return next;
    case "frame":
      if (!root) return next;
      for (const event of record.body.events) {
        if (event.kind === "text_delta") {
          const text = next.textOpen ? (next.preview ?? "") + event.text : event.text;
          next = { ...next, preview: text.length > PREVIEW_CHARS ? text.slice(-PREVIEW_CHARS) : text, textOpen: true };
          continue;
        }
        switch (event.kind) {
          case "turn_ended":
            next = {
              ...next,
              lastTurn: { seq, at, outcome: event.outcome },
              ...(event.outcome.kind === "aborted" ? {} : { lastCompletionSeq: seq }),
              ...(event.outcome.kind === "failed" ? { lastError: event.outcome.reason } : {}),
            };
            break;
          case "model":
            next = { ...next, reportedModel: event.model };
            break;
          case "usage":
            if (event.usage.tokens !== undefined) next = { ...next, usage: event.usage.tokens };
            if (event.usage.context !== undefined) next = { ...next, context: event.usage.context };
            break;
          case "reasoning":
          case "tool_call_started":
          case "tool_call_ended":
          case "tool_call_progress":
          case "compaction_started":
          case "compaction_ended":
          case "retry":
          case "user_message":
            break;
        }
        // Usage and model reports interleave with text on some runtimes; they don't end a text run.
        if (event.kind !== "usage" && event.kind !== "model" && next.textOpen) next = { ...next, textOpen: false };
      }
      return next;
  }
}

function describeEnd(reason: string, code: number | null | undefined): string {
  switch (reason) {
    case "crashed":
      return "rowrow stopped while this agent was running";
    case "exited":
      return code === null || code === undefined ? "the agent process exited" : `the agent process exited with code ${code}`;
    default:
      return `the run ended (${reason})`;
  }
}

// ─── Attention ───────────────────────────────────────────────────────────────

/** Why an agent needs you, in priority order (docs/architecture.md, "Attention and notifications"). */
export type Attention = "blocked" | "done" | "working" | "idle";

export const ATTENTION_RANK: Readonly<Record<Attention, number>> = { blocked: 4, done: 3, working: 2, idle: 1 };

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
