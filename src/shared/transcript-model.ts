// The transcript as a flat list of items with stable ids, for clients that render natively
// (the iOS app, through the kit: src/kit/kit.ts, docs/decisions.md D-027). It is the same
// timeline fold the web app renders (timeline.ts), cut into the pieces a native list redraws
// one at a time: an input, a turn's header, each text, thought, tool call and notice in it,
// the turn's outcome, and rowrow's own notes between runs.
//
// `TranscriptProjector` remembers what it produced last and returns only the items that
// changed (and the order, when it changed). The fold shares structure, so an item whose
// source objects are the same ones as last time is skipped without being looked at: while
// text streams, one item is re-serialized and sent.
import {
  classifyTool,
  type ViewMessage,
  type ViewNotice,
  type ViewPart,
  type ViewTurn,
} from "@botiverse/oar/observe";
import type { Attachment, EntryOf } from "./entries.ts";
import { actorLabel } from "./render-text.ts";
import type { InputBlock, RunBlock, Timeline } from "./timeline.ts";

/** Bumped when an item changes shape; a client checks it before trusting the kit. */
export const TRANSCRIPT_MODEL_VERSION = 1;

/** Tool input and output are cut at this many characters in the list (`full` gives them whole). */
export const TOOL_CLIP = 2000;

export interface InputItem {
  readonly kind: "input";
  readonly id: string;
  /** What the person wrote (not the text the runtime read, which lists the attachments first). */
  readonly text: string;
  /** The files that went with it (D-024). */
  readonly attachments: readonly Attachment[];
  /** Who sent it (a device's name, an agent, rowrow); null when the log doesn't say. */
  readonly by: string | null;
  readonly at: number | null;
  /** sending: not taken by the runtime yet; failed: rejected or not delivered. */
  readonly state: "sending" | "sent" | "failed";
  /** Where it landed, when not as a plain prompt. */
  readonly landed: "steered" | "queued" | null;
  /** Why it failed. */
  readonly reason: string | null;
}

/** A turn starts: the items that follow, up to the next input, turn or note, are its content. */
export interface TurnItem {
  readonly kind: "turn";
  readonly id: string;
  /** The runtime is still working on it. */
  readonly open: boolean;
}

interface PartOf {
  readonly id: string;
  /** The turn it belongs to. */
  readonly turn: string;
  /** The sub-agent it came from, outermost first; empty for the agent itself. */
  readonly lane: readonly string[];
}

export interface TextItem extends PartOf {
  readonly kind: "text";
  /** Markdown. */
  readonly text: string;
  readonly streaming: boolean;
}

export interface ReasoningItem extends PartOf {
  readonly kind: "reasoning";
  /** null when the runtime keeps its thinking to itself. */
  readonly text: string | null;
  readonly streaming: boolean;
}

export interface ToolItem extends PartOf {
  readonly kind: "tool";
  readonly callId: string;
  readonly tool: string;
  /** What it does, across runtimes (oar's classifyTool): run_command, read_file, edit_file, search, web, mcp, other. */
  readonly action: string;
  /** What it acts on: the command, path, pattern or URL. */
  readonly detail: string | null;
  /** The runtime's input (usually JSON) and the tool's output, cut at TOOL_CLIP characters. */
  readonly input: string | null;
  readonly output: string | null;
  /** Their whole lengths. */
  readonly inputLength: number;
  readonly outputLength: number;
  readonly result: "running" | "ok" | "failed" | "ended";
}

/** The runtime asked the app something (an approval, a question). */
export interface RequestItem extends PartOf {
  readonly kind: "request";
  readonly type: string;
  readonly answered: boolean;
}

export interface NoticeItem {
  readonly kind: "notice";
  readonly id: string;
  /** Inside a turn (a compaction, a retry), or null between turns. */
  readonly turn: string | null;
  readonly lane: readonly string[];
  readonly text: string;
  readonly tone: "normal" | "error";
  /** A divider across the conversation (a resumed run, a model switch) rather than a sentence. */
  readonly divider: boolean;
}

export interface OutcomeItem {
  readonly kind: "outcome";
  readonly id: string;
  readonly turn: string;
  readonly outcome: "completed" | "aborted" | "failed";
  /** Why it failed, in the runtime's words. */
  readonly reason: string | null;
  /** oar's failure class: auth, quota, invalid_request, overloaded, provider, runtime_exited, unknown. */
  readonly failure: string | null;
}

export type TranscriptItem =
  | InputItem
  | TurnItem
  | TextItem
  | ReasoningItem
  | ToolItem
  | RequestItem
  | NoticeItem
  | OutcomeItem;

/** What changed since the last update: the order when it changed, and the items that did (as JSON). */
export interface TranscriptDelta {
  readonly order: readonly string[] | null;
  readonly items: readonly string[];
}

interface Cached {
  /** The objects (and flags) the item was made from; the same ones mean the same item. */
  readonly deps: readonly unknown[];
  readonly json: string;
  /** Makes the item again, uncut (tool input and output whole). */
  readonly full: () => TranscriptItem;
}

interface Pending {
  readonly id: string;
  readonly deps: readonly unknown[];
  readonly make: (clip: number) => TranscriptItem;
}

export class TranscriptProjector {
  private readonly runtime: string;
  private cache = new Map<string, Cached>();
  private order: readonly string[] = [];

  /** `runtime` is the agent's runtime id, which says how to read its tool names. */
  constructor(runtime: string) {
    this.runtime = runtime;
  }

  /** Forget what was sent: the next update returns every item (a client that starts over). */
  reset(): void {
    this.cache = new Map();
    this.order = [];
  }

  update(timeline: Timeline): TranscriptDelta {
    const pending = itemsOf(timeline, this.runtime);
    const next = new Map<string, Cached>();
    const items: string[] = [];
    for (const item of pending) {
      const cached = this.cache.get(item.id);
      if (cached !== undefined && sameDeps(cached.deps, item.deps)) {
        next.set(item.id, cached);
        continue;
      }
      const json = JSON.stringify(item.make(TOOL_CLIP));
      next.set(item.id, { deps: item.deps, json, full: () => item.make(Number.POSITIVE_INFINITY) });
      if (cached?.json !== json) items.push(json);
    }
    const order = pending.map((item) => item.id);
    const orderChanged = order.length !== this.order.length || order.some((id, i) => id !== this.order[i]);
    this.cache = next;
    this.order = order;
    return { order: orderChanged ? order : null, items };
  }

  /** The item as last projected, but whole (tool input and output uncut); null if there's none. */
  full(id: string): TranscriptItem | null {
    return this.cache.get(id)?.full() ?? null;
  }
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Every item of the timeline in order, each with what it is made from and how to make it. */
function itemsOf(timeline: Timeline, runtime: string): Pending[] {
  const out: Pending[] = [];
  for (const block of timeline.blocks) {
    switch (block.kind) {
      case "input":
        // Shown on its own only until a run takes it over; the run's view shows it from then on.
        if (!block.delivered)
          out.push({
            id: `pending:${block.input.inputId}`,
            deps: [block],
            make: () => pendingInput(block),
          });
        break;
      case "notice": {
        const { entry } = block;
        out.push({
          id: `notice:${entry.seq}`,
          deps: [entry],
          make: () => hostNotice(entry, `notice:${entry.seq}`),
        });
        break;
      }
      case "run":
        runItems(block, timeline, runtime, out);
        break;
    }
  }
  return out;
}

function runItems(run: RunBlock, timeline: Timeline, runtime: string, out: Pending[]): void {
  const { started, ended, view } = run;
  const at = (suffix: string): string => `${run.runId}:${suffix}`;
  if (started?.resume !== undefined) {
    out.push({
      id: at("resumed"),
      deps: [started],
      make: () =>
        note(at("resumed"), `Resumed${started.model === undefined ? "" : ` on ${started.model}`}`, {
          divider: true,
        }),
    });
  }
  view.messages.forEach((message, index) => {
    // The run's own end says why the process went away; oar's exit notice would repeat it.
    if (
      message.kind === "notice" &&
      message.notice.cause === "exited" &&
      ended !== undefined &&
      ended.reason !== "exited"
    )
      return;
    const id = at(message.id);
    switch (message.kind) {
      case "input": {
        const inputId = message.input.inputId;
        const origin = inputId === undefined ? undefined : timeline.inputs.get(inputId);
        out.push({ id, deps: [message, origin], make: () => deliveredInput(id, message, origin) });
        break;
      }
      case "notice":
        out.push({ id, deps: [message], make: () => note(id, noticeText(message.notice)) });
        break;
      case "turn":
        turnItems(id, message, index === view.openTurn && ended === undefined, runtime, out);
        break;
    }
  });
  if (ended !== undefined && ended.reason !== "idle" && ended.reason !== "restart") {
    out.push({
      id: at("ended"),
      deps: [ended],
      make: () =>
        note(at("ended"), endText(ended.reason, ended.code), {
          tone: ended.reason === "crashed" || ended.reason === "exited" ? "error" : "normal",
        }),
    });
  }
}

function turnItems(turnId: string, turn: ViewTurn, open: boolean, runtime: string, out: Pending[]): void {
  out.push({ id: turnId, deps: [open], make: () => ({ kind: "turn", id: turnId, open }) });
  turn.sections.forEach((section, s) => {
    const lastSection = s === turn.sections.length - 1;
    section.parts.forEach((part, p) => {
      const id = `${turnId}:${s}:${p}`;
      const streaming = open && lastSection && p === section.parts.length - 1;
      const where = { id, turn: turnId, lane: section.agentPath };
      out.push({
        id,
        deps: [part, streaming],
        make: (clip) => partItem(part, where, streaming, runtime, clip),
      });
    });
  });
  const { outcome } = turn;
  if (outcome !== undefined) {
    const id = `${turnId}:outcome`;
    out.push({
      id,
      deps: [outcome],
      make: () => ({
        kind: "outcome",
        id,
        turn: turnId,
        outcome: outcome.kind,
        reason: outcome.kind === "failed" ? outcome.reason : null,
        failure: outcome.kind === "failed" ? outcome.failure : null,
      }),
    });
  }
}

function partItem(
  part: ViewPart,
  where: { readonly id: string; readonly turn: string; readonly lane: readonly string[] },
  streaming: boolean,
  runtime: string,
  clip: number,
): TranscriptItem {
  switch (part.kind) {
    case "text":
      return { kind: "text", ...where, text: part.text, streaming };
    case "reasoning":
      return {
        kind: "reasoning",
        ...where,
        text: part.content.kind === "text" ? part.content.text : null,
        streaming,
      };
    case "tool": {
      const action = classifyTool(runtime, part.tool, part.input);
      return {
        kind: "tool",
        ...where,
        callId: part.callId,
        tool: part.tool,
        action: action.kind,
        detail: action.detail ?? null,
        input: part.input === undefined ? null : cut(part.input, clip),
        output: part.output === undefined ? null : cut(part.output, clip),
        inputLength: part.input?.length ?? 0,
        outputLength: part.output?.length ?? 0,
        result: part.result,
      };
    }
    case "notice":
      return {
        kind: "notice",
        id: where.id,
        turn: where.turn,
        lane: where.lane,
        text: noticeText(part.notice),
        tone: "normal",
        divider: false,
      };
    case "app_request":
      return { kind: "request", ...where, type: part.type, answered: part.answered };
  }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function pendingInput(block: InputBlock): InputItem {
  const failed =
    block.result !== undefined && (block.result.landed === "failed" || block.result.landed === "rejected");
  return {
    kind: "input",
    id: `pending:${block.input.inputId}`,
    text: block.input.text,
    attachments: block.input.attachments ?? [],
    by: actorLabel(block.input.by),
    at: block.input.at,
    state: failed ? "failed" : "sending",
    landed: null,
    reason: failed ? (block.result?.reason ?? block.result?.landed ?? null) : null,
  };
}

function deliveredInput(
  id: string,
  message: Extract<ViewMessage, { kind: "input" }>,
  origin: InputBlock | undefined,
): InputItem {
  const { input } = message;
  const landed = origin?.result?.landed;
  return {
    kind: "input",
    id,
    // What you sent (your text and files), rather than the text the runtime read.
    text: origin?.input.text ?? input.input,
    attachments: origin?.input.attachments ?? [],
    by: origin === undefined ? null : actorLabel(origin.input.by),
    at: origin?.input.at ?? null,
    state: input.state === "rejected" ? "failed" : input.state === "pending" ? "sending" : "sent",
    landed: landed === "steered" || landed === "queued" ? landed : null,
    reason: input.state === "rejected" ? (origin?.result?.reason ?? null) : null,
  };
}

function hostNotice(entry: EntryOf<"run.failed" | "host.error" | "agent.updated">, id: string): NoticeItem {
  switch (entry.kind) {
    case "run.failed":
      return note(id, `Couldn't start the agent: ${entry.error}`, { tone: "error" });
    case "host.error":
      return note(id, entry.message, { tone: "error" });
    case "agent.updated": {
      const parts = [
        entry.changes.model === undefined ? null : `model: ${entry.changes.model ?? "default"}`,
        entry.changes.effort === undefined ? null : `effort: ${entry.changes.effort ?? "default"}`,
      ].filter((part) => part !== null);
      return note(id, `Switched ${parts.join(", ")}`, { divider: true });
    }
  }
}

function note(
  id: string,
  text: string,
  options: { readonly tone?: "normal" | "error"; readonly divider?: boolean } = {},
): NoticeItem {
  return {
    kind: "notice",
    id,
    turn: null,
    lane: [],
    text,
    tone: options.tone ?? "normal",
    divider: options.divider ?? false,
  };
}

/** What a runtime notice says, in words. */
export function noticeText(notice: ViewNotice): string {
  switch (notice.cause) {
    case "compaction_started":
      return "Compacting the conversation…";
    case "compaction_ended":
      return notice.outcome === "completed"
        ? "Conversation compacted"
        : `Compaction ${notice.outcome}${notice.reason === undefined ? "" : `: ${notice.reason}`}`;
    case "retry":
      return `Retrying (attempt ${notice.attempt}${notice.maxAttempts === undefined ? "" : ` of ${notice.maxAttempts}`})${notice.reason === undefined ? "" : `: ${notice.reason}`}`;
    case "control_rejected":
      return `${notice.action} was refused: ${notice.reason}`;
    case "child_turn_ended":
      return `A sub-agent finished (${notice.outcome.kind})`;
    case "exited":
      return `The agent process exited${notice.code === null ? "" : ` (code ${notice.code})`}`;
  }
}

/** Why a run ended, in words (idle and restart ends say nothing: nothing happened to you). */
export function endText(reason: string, exitCode: number | null | undefined): string {
  switch (reason) {
    case "stopped":
      return "Stopped. The next message resumes the conversation.";
    case "archived":
      return "Archived.";
    case "shutdown":
      return "rowrow shut down; the next message resumes the conversation.";
    case "crashed":
      return "rowrow stopped unexpectedly while this was running.";
    case "exited":
      return `The agent process exited${exitCode === null || exitCode === undefined ? "" : ` (code ${exitCode})`}.`;
    default:
      return `Run ended: ${reason}`;
  }
}
