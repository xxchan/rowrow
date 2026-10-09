// The transcript fold: entries → what the agent view renders. Each run's oar records fold
// into that run's SessionView (oar's own chat projection, streamId = runId so resumed
// runs never collide); rowrow's host facts (a run failed to start, an input that never
// reached a run, the run ended) sit between them in log order. A notification sent while a
// run is live goes in that run, after what the agent had said by then (`placeNotes`).
//
// Pure and incremental with structural sharing: an entry replaces only the block it
// touches, so a renderer memoized on block identity redraws only what changed. The fold
// may start at any entry (a window that begins mid-run gets a run block without its
// start), because oar's view adopts a turn it joins midway.
import type { RawEvent } from "@botiverse/oar";
import {
  initialSessionView,
  reduceSessionView,
  type SessionView,
  type ViewPart,
  type ViewSection,
} from "@botiverse/oar/observe";
import type { Entry, EntryOf } from "./entries.ts";
import { echoesInput } from "./summary.ts";

export interface RunBlock {
  readonly kind: "run";
  readonly runId: string;
  /** Absent when the window starts after the run started. */
  readonly started?: EntryOf<"run.started">;
  readonly ended?: EntryOf<"run.ended">;
  readonly view: SessionView;
  readonly firstSeq: number;
  readonly lastSeq: number;
  /** Its process exited to end a turn you stopped (oar ends one that doesn't stop in time). */
  readonly stoppedByExit?: true;
  /** Aborted turns no stop from rowrow was in flight for: the runtime stopped them itself (a pi extension). */
  readonly selfStopped?: readonly string[];
  /** Notifications sent while it was live (placeNotes says where they go). */
  readonly notes?: readonly RunNote[];
}

/** A notification sent during a run, after the message that was the run's last (null: none yet). */
export interface RunNote {
  readonly entry: EntryOf<"notification.sent">;
  readonly after: string | null;
}

/** An input as rowrow received it. Rendered on its own only until a run takes it over. */
export interface InputBlock {
  readonly kind: "input";
  readonly input: EntryOf<"input">;
  readonly result?: EntryOf<"input.result">;
  /** A held input (D-035) went to the runtime: how that went. */
  readonly sent?: EntryOf<"input.sent">;
  /** An oar request carried this input into a run; the run's view shows it from then on. */
  readonly delivered: boolean;
}

export interface NoticeBlock {
  readonly kind: "notice";
  readonly entry: EntryOf<"run.failed" | "host.error" | "agent.updated" | "notification.sent">;
}

export type TimelineBlock = RunBlock | InputBlock | NoticeBlock;

export interface Timeline {
  readonly blocks: readonly TimelineBlock[];
  /** Every input by id, for authorship and delivery state (who sent it, from where, how it landed). */
  readonly inputs: ReadonlyMap<string, InputBlock>;
  readonly firstSeq: number;
  /** seq of the last folded entry; the cursor to resume from. -1 before any. */
  readonly headSeq: number;
}

export function initialTimeline(): Timeline {
  return { blocks: [], inputs: new Map(), firstSeq: -1, headSeq: -1 };
}

export function timelineOf(entries: Iterable<Entry>): Timeline {
  let timeline = initialTimeline();
  for (const entry of entries) timeline = reduceTimeline(timeline, entry);
  return timeline;
}

export function reduceTimeline(previous: Timeline, entry: Entry): Timeline {
  if (entry.seq <= previous.headSeq) return previous; // replayed after a reconnect: already folded
  const next = foldEntry(previous, entry);
  return { ...next, firstSeq: previous.firstSeq === -1 ? entry.seq : previous.firstSeq, headSeq: entry.seq };
}

function foldEntry(t: Timeline, entry: Entry): Timeline {
  switch (entry.kind) {
    case "input": {
      const block: InputBlock = { kind: "input", input: entry, delivered: false };
      return { ...t, blocks: [...t.blocks, block], inputs: withInput(t.inputs, block) };
    }
    case "input.result": {
      const block = t.inputs.get(entry.inputId);
      return block === undefined ? t : replaceInput(t, block, { ...block, result: entry });
    }
    case "input.sent": {
      // It was held while the last turn ran; it belongs after that turn, where it was sent.
      const block = t.inputs.get(entry.inputId);
      if (block === undefined) return t;
      const moved: InputBlock = { ...block, sent: entry };
      return {
        ...t,
        blocks: [...t.blocks.filter((b) => b !== block), moved],
        inputs: withInput(t.inputs, moved),
      };
    }
    case "input.withdrawn": {
      const block = t.inputs.get(entry.inputId);
      // A steer the runtime never read, dismissed: the run's view still has it (unshown).
      if (block === undefined || block.delivered) return t;
      const inputs = new Map(t.inputs);
      inputs.delete(entry.inputId);
      return { ...t, blocks: t.blocks.filter((b) => b !== block), inputs };
    }
    case "run.started": {
      const block: RunBlock = {
        kind: "run",
        runId: entry.runId,
        started: entry,
        view: initialSessionView(),
        firstSeq: entry.seq,
        lastSeq: entry.seq,
      };
      return { ...t, blocks: [...t.blocks, block] };
    }
    case "oar": {
      const index = findRun(t.blocks, entry.runId);
      const base: RunBlock =
        index === -1
          ? {
              kind: "run",
              runId: entry.runId,
              view: initialSessionView(),
              firstSeq: entry.seq,
              lastSeq: entry.seq,
            }
          : (t.blocks[index] as RunBlock);
      const { record } = entry;
      const view = reduceSessionView(base.view, record, entry.runId);
      const run: RunBlock = {
        ...base,
        view,
        lastSeq: entry.seq,
        ...(endsStoppedTurn(base.view, view, record) ? { stoppedByExit: true } : {}),
        ...foldSelfStopped(base, view),
      };
      const blocks = index === -1 ? [...t.blocks, run] : replaceAt(t.blocks, index, run);
      let next: Timeline = { ...t, blocks };
      if (record.kind === "request" && record.direction === "toRuntime" && "inputId" in record.body) {
        const inputId = record.body.inputId;
        const input = inputId === undefined ? undefined : next.inputs.get(inputId);
        if (input !== undefined && !input.delivered)
          next = replaceInput(next, input, { ...input, delivered: true });
      }
      return next;
    }
    case "run.ended": {
      const index = findRun(t.blocks, entry.runId);
      if (index === -1) return t;
      const run = t.blocks[index] as RunBlock;
      return { ...t, blocks: replaceAt(t.blocks, index, { ...run, ended: entry, lastSeq: entry.seq }) };
    }
    case "run.failed":
    case "host.error":
      return { ...t, blocks: [...t.blocks, { kind: "notice", entry }] };
    case "notification.sent": {
      // Sent mid-run (usually by the agent itself, from a tool call): in the run, where it was.
      const index = lastRun(t.blocks);
      const run = index === -1 ? undefined : (t.blocks[index] as RunBlock);
      if (run === undefined || run.ended !== undefined)
        return { ...t, blocks: [...t.blocks, { kind: "notice", entry }] };
      const note: RunNote = { entry, after: run.view.messages.at(-1)?.id ?? null };
      return { ...t, blocks: replaceAt(t.blocks, index, { ...run, notes: [...(run.notes ?? []), note] }) };
    }
    case "agent.updated":
      // Only a model change reads as part of the conversation; renames and archiving don't.
      return entry.changes.model === undefined
        ? t
        : { ...t, blocks: [...t.blocks, { kind: "notice", entry }] };
    case "agent.created":
    case "queue.paused":
    case "queue.resumed":
      return t;
  }
}

function findRun(blocks: readonly TimelineBlock[], runId: string): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.kind === "run" && block.runId === runId) return i;
  }
  return -1;
}

function lastRun(blocks: readonly TimelineBlock[]): number {
  return blocks.findLastIndex((block) => block.kind === "run");
}

/**
 * Where a run's notes go: `before` its first message, or `after` the message that was last
 * when each was sent. One whose message is gone since (oar drops a turn that never began)
 * goes after the run's last message.
 */
export function placeNotes(run: RunBlock): {
  readonly before: readonly RunNote[];
  readonly after: ReadonlyMap<string, readonly RunNote[]>;
} {
  const notes = run.notes ?? [];
  if (notes.length === 0) return { before: [], after: new Map() };
  const ids = new Set(run.view.messages.map((message) => message.id));
  const last = run.view.messages.at(-1)?.id ?? null;
  const before: RunNote[] = [];
  const after = new Map<string, RunNote[]>();
  for (const note of notes) {
    const at = note.after === null ? null : ids.has(note.after) ? note.after : last;
    if (at === null) before.push(note);
    else after.set(at, [...(after.get(at) ?? []), note]);
  }
  return { before, after };
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const copy = [...items];
  copy[index] = item;
  return copy;
}

function withInput(inputs: ReadonlyMap<string, InputBlock>, block: InputBlock): Map<string, InputBlock> {
  return new Map(inputs).set(block.input.inputId, block);
}

function replaceInput(t: Timeline, old: InputBlock, block: InputBlock): Timeline {
  const index = t.blocks.lastIndexOf(old);
  return {
    ...t,
    blocks: index === -1 ? t.blocks : replaceAt(t.blocks, index, block),
    inputs: withInput(t.inputs, block),
  };
}

/** How an input ended up, as far as the log says: held and sent, or answered straight away. */
export function outcomeOf(block: InputBlock): EntryOf<"input.result" | "input.sent"> | undefined {
  return block.sent ?? block.result;
}

/** rowrow holds it (D-035): it waits above the composer, not in the conversation, until it is sent. */
export function held(block: InputBlock): boolean {
  return block.result?.held === true && block.sent === undefined;
}

/** How an input went into a turn when not as its own prompt. A held one went out as its own
 * prompt, unless someone steered it in. */
export function landedIn(block: InputBlock | undefined): "steered" | "queued" | null {
  const landed = block?.result?.held === true ? block.sent?.landed : block?.result?.landed;
  return landed === "steered" || landed === "queued" ? landed : null;
}

/**
 * Steered into a turn, and the runtime hasn't said it read it (`observations`, on the runtimes
 * that echo). It waits above the composer until then: the conversation shows only what the
 * agent got.
 */
export function steerUnread(block: InputBlock | undefined, observations: number, runtime: string): boolean {
  return landedIn(block) === "steered" && echoesInput(runtime) && observations === 0;
}

/**
 * The sub-agent a section of a turn came from, outermost first; empty for the agent itself.
 * oar's lane is the pair (sessionId, agentPath): claude names a sub-agent by its agentPath, but
 * codex and grok run each one as a session of its own ("nested" attribution), whose work
 * arrives under the child's sessionId with an empty agentPath, often while the agent itself is
 * still writing. That session is the sub-agent.
 */
export function laneOf(section: ViewSection, rootSessionId: string | undefined): readonly string[] {
  return rootSessionId === undefined || section.sessionId === rootSessionId
    ? section.agentPath
    : [section.sessionId, ...section.agentPath];
}

/** A section's part as it reads, or a run of hidden thoughts standing as one. */
export interface PartRun<T extends ViewPart> {
  /** The run's first part. */
  readonly part: T;
  /** Where the run starts in the section's parts. */
  readonly index: number;
  /** How many parts it stands for: more than one only for hidden thoughts back to back. */
  readonly count: number;
}

/**
 * A section's parts as they read: thoughts the runtime kept to itself (Claude's redacted
 * thinking, Codex's encrypted reasoning), back to back with nothing between them, are one
 * ("Thought (hidden) ×7"). Each says nothing alone, and a turn can have dozens; readable
 * thoughts and everything else stay one by one.
 */
export function foldHiddenThoughts<T extends ViewPart>(parts: readonly T[]): PartRun<T>[] {
  const runs: PartRun<T>[] = [];
  parts.forEach((part, index) => {
    const last = runs.at(-1);
    if (last !== undefined && hiddenThought(part) && hiddenThought(last.part))
      runs[runs.length - 1] = { ...last, count: last.count + 1 };
    else runs.push({ part, index, count: 1 });
  });
  return runs;
}

function hiddenThought(part: ViewPart): boolean {
  return part.kind === "reasoning" && part.content.kind !== "text";
}

/** The live run's view, if the latest run block has not ended. */
export function liveView(timeline: Timeline): SessionView | null {
  for (let i = timeline.blocks.length - 1; i >= 0; i--) {
    const block = timeline.blocks[i];
    if (block?.kind === "run") return block.ended === undefined ? block.view : null;
  }
  return null;
}

/** A turn that just ended aborted with no stop from rowrow in flight (no pending abort, accepted abort or dispose). */
function foldSelfStopped(run: RunBlock, after: SessionView): Partial<Pick<RunBlock, "selfStopped">> {
  const before = run.view.status;
  if (
    before.kind !== "running" ||
    after.status.kind !== "idle" ||
    after.status.lastTurnOutcome?.kind !== "aborted"
  ) {
    return {};
  }
  if (before.stop !== undefined && (before.stop.pendingAbortIds.length > 0 || before.stop.abortedOnExit))
    return {};
  const turn = after.messages.findLast((m) => m.kind === "turn" && m.outcome !== undefined);
  return turn === undefined ? {} : { selfStopped: [...(run.selfStopped ?? []), turn.id] };
}

/** An aborted turn the runtime stopped itself, not you. */
export function stoppedByAgent(run: RunBlock, turnId: string): boolean {
  return run.selfStopped?.includes(turnId) === true;
}

/** The process exit that ended a running turn as stopped (oar 0.37: after an accepted abort or dispose). */
export function endsStoppedTurn(before: SessionView, after: SessionView, record: RawEvent): boolean {
  return (
    record.kind === "response" &&
    record.body.kind === "exited" &&
    before.status.kind === "running" &&
    after.status.kind === "idle" &&
    after.status.lastTurnOutcome?.kind === "aborted"
  );
}
