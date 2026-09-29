// The transcript fold: entries → what the agent view renders. Each run's oar records fold
// into that run's SessionView (oar's own chat projection, streamId = runId so resumed
// runs never collide); rowrow's host facts (a run failed to start, an input that never
// reached a run, the run ended) sit between them in log order.
//
// Pure and incremental with structural sharing: an entry replaces only the block it
// touches, so a renderer memoized on block identity redraws only what changed. The fold
// may start at any entry (a window that begins mid-run gets a run block without its
// start), because oar's view adopts a turn it joins midway.
import { initialSessionView, reduceSessionView, type SessionView } from "@botiverse/oar/observe";
import type { Entry, EntryOf } from "./entries.ts";

export interface RunBlock {
  readonly kind: "run";
  readonly runId: string;
  /** Absent when the window starts after the run started. */
  readonly started?: EntryOf<"run.started">;
  readonly ended?: EntryOf<"run.ended">;
  readonly view: SessionView;
  readonly firstSeq: number;
  readonly lastSeq: number;
}

/** An input as rowrow received it. Rendered on its own only until a run takes it over. */
export interface InputBlock {
  readonly kind: "input";
  readonly input: EntryOf<"input">;
  readonly result?: EntryOf<"input.result">;
  /** An oar request carried this input into a run; the run's view shows it from then on. */
  readonly delivered: boolean;
}

export interface NoticeBlock {
  readonly kind: "notice";
  readonly entry: EntryOf<"run.failed" | "host.error" | "agent.updated">;
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
          ? { kind: "run", runId: entry.runId, view: initialSessionView(), firstSeq: entry.seq, lastSeq: entry.seq }
          : (t.blocks[index] as RunBlock);
      const run: RunBlock = { ...base, view: reduceSessionView(base.view, entry.record, entry.runId), lastSeq: entry.seq };
      const blocks = index === -1 ? [...t.blocks, run] : replaceAt(t.blocks, index, run);
      let next: Timeline = { ...t, blocks };
      const { record } = entry;
      if (record.kind === "request" && record.direction === "toRuntime" && "inputId" in record.body) {
        const inputId = record.body.inputId;
        const input = inputId === undefined ? undefined : next.inputs.get(inputId);
        if (input !== undefined && !input.delivered) next = replaceInput(next, input, { ...input, delivered: true });
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
    case "agent.updated":
      // Only a model change reads as part of the conversation; renames and archiving don't.
      return entry.changes.model === undefined ? t : { ...t, blocks: [...t.blocks, { kind: "notice", entry }] };
    case "agent.created":
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

/** The live run's view, if the latest run block has not ended. */
export function liveView(timeline: Timeline): SessionView | null {
  for (let i = timeline.blocks.length - 1; i >= 0; i--) {
    const block = timeline.blocks[i];
    if (block?.kind === "run") return block.ended === undefined ? block.view : null;
  }
  return null;
}
