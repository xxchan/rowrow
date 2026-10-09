// Transcript search (agents.search, D-055): what the transcript shows, not the log's bytes.
// The log is folded exactly as every client folds it (timeline.ts, then transcript-model.ts's
// items), so a hit names the item a client renders: the kit's item id, which the web app also
// puts on its elements (data-item). Streamed text is found whole, though it arrived in
// fragments, one entry each.
//
// The fold notes where each item began (the entry that made it appear, and the input its turn
// started at) as it goes, so a client can load the log from that turn and scroll to the hit.
// A run's view only grows at its end: new messages are appended, and new parts land in its
// open turn, so each record is checked there and nowhere else.
import type { ViewMessage } from "@botiverse/oar/observe";
import type { Entry } from "./entries.ts";
import type { SearchWho, TranscriptHit, TranscriptSearch } from "./schemas.ts";
import { initialTimeline, reduceTimeline, type RunBlock, type Timeline } from "./timeline.ts";
import { transcriptItems } from "./transcript-model.ts";

/** Matches returned at most by default: the newest ones. */
export const SEARCH_LIMIT = 200;

/** Characters of context kept before and after a match in its snippet. */
const BEFORE = 40;
const AFTER = 100;

interface Origin {
  readonly seq: number;
  readonly at: number;
  readonly turnSeq: number;
}

export interface SearchOptions {
  /** Only these (default: all three). Counts cover every kind regardless. */
  readonly who?: readonly SearchWho[];
  readonly limit?: number;
}

/** One agent's log folded for searching; `add` more entries as they come, then `search` it. */
export class TranscriptIndex {
  private readonly runtime: string;
  private timeline: Timeline = initialTimeline();
  private readonly origins = new Map<string, Origin>();
  /** Each run's open turn after the last record, which that record may have closed. */
  private readonly openTurns = new Map<string, string>();
  private turnSeq = 0;

  /** `runtime` is the agent's runtime id, which says how to read its tool calls (as the kit does). */
  constructor(runtime: string) {
    this.runtime = runtime;
  }

  /** The last entry folded: add the ones after it. */
  get headSeq(): number {
    return this.timeline.headSeq;
  }

  add(entry: Entry): void {
    if (entry.seq <= this.timeline.headSeq) return;
    this.timeline = reduceTimeline(this.timeline, entry);
    const here = { seq: entry.seq, at: entry.at, turnSeq: this.turnSeq };
    if (entry.kind === "input") {
      this.turnSeq = entry.seq;
      this.origins.set(`pending:${entry.inputId}`, { seq: entry.seq, at: entry.at, turnSeq: entry.seq });
    } else if (entry.kind === "oar") {
      const run = this.timeline.blocks.findLast(
        (block): block is RunBlock => block.kind === "run" && block.runId === entry.runId,
      );
      if (run !== undefined) this.noteRun(run, here);
    }
  }

  /** Name what this record added to the run: messages at its end, parts in the turns it wrote to. */
  private noteRun(run: RunBlock, here: Origin): void {
    const { messages, openTurn } = run.view;
    const touched = new Set<ViewMessage>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message === undefined || this.origins.has(`${run.runId}:${message.id}`)) break;
      this.note(`${run.runId}:${message.id}`, here);
      touched.add(message);
    }
    const before = this.openTurns.get(run.runId);
    if (before !== undefined) {
      const turn = messages.findLast((message) => message.id === before);
      if (turn !== undefined) touched.add(turn);
    }
    const open = messages[openTurn];
    if (open !== undefined) touched.add(open);
    if (open === undefined) this.openTurns.delete(run.runId);
    else this.openTurns.set(run.runId, open.id);
    for (const message of touched) {
      if (message.kind !== "turn") continue;
      // A part loads with its turn: from the input before the turn began, not one held since.
      const turnSeq = this.origins.get(`${run.runId}:${message.id}`)?.turnSeq ?? here.turnSeq;
      message.sections.forEach((section, s) => {
        // Parts are only ever appended to a section: the last one named says how far it got.
        for (let p = section.parts.length - 1; p >= 0; p--) {
          const id = `${run.runId}:${message.id}:${s}:${p}`;
          if (this.origins.has(id)) break;
          this.note(id, { ...here, turnSeq });
        }
      });
    }
  }

  private note(id: string, origin: Origin): void {
    if (!this.origins.has(id)) this.origins.set(id, origin);
  }

  /**
   * The items whose text matches `query`: case-insensitive, as plain text (a run of spaces
   * matches any run of whitespace, as Markdown shows it). Oldest first; past the limit, the
   * newest ones.
   */
  search(query: string, options: SearchOptions = {}): TranscriptSearch {
    const pattern = searchPattern(query);
    const wanted = new Set(options.who ?? ["you", "agent", "tool"]);
    const limit = options.limit ?? SEARCH_LIMIT;
    const counts = { you: 0, agent: 0, tool: 0 };
    const found: { readonly text: string; readonly make: (snippet: Snippet) => TranscriptHit }[] = [];
    if (pattern === null) return { hits: [], more: false, counts };
    const consider = (
      id: string,
      who: SearchWho,
      field: TranscriptHit["field"],
      text: string | null,
      tool: string | null,
      at: number | null,
    ): void => {
      if (text === null || !pattern.test(text)) return;
      counts[who]++;
      if (!wanted.has(who)) return;
      const origin = this.origins.get(id) ?? { seq: this.timeline.firstSeq, at: 0, turnSeq: 0 };
      found.push({
        text,
        make: (snippet) => ({
          itemId: id,
          seq: origin.seq,
          turnSeq: origin.turnSeq,
          at: at ?? origin.at,
          who,
          tool,
          field,
          ...snippet,
        }),
      });
    };
    for (const item of transcriptItems(this.timeline, this.runtime)) {
      switch (item.kind) {
        case "input":
          consider(item.id, "you", "text", item.text, null, item.at);
          break;
        case "text":
          consider(item.id, "agent", "text", item.text, null, null);
          break;
        case "tool":
          consider(item.id, "tool", "input", inputText(item.input), item.tool, null);
          consider(item.id, "tool", "output", item.output, item.tool, null);
          break;
        // What rowrow and the runtime say around the conversation, and thoughts, aren't searched.
        case "turn":
        case "reasoning":
        case "request":
        case "notice":
        case "outcome":
        case "action":
          break;
      }
    }
    const kept = found.slice(-limit);
    return {
      hits: kept.map((hit) => hit.make(snippetOf(hit.text, pattern))),
      more: found.length > kept.length,
      counts,
    };
  }
}

/** Every entry folded, then searched: for a log read once. */
export function searchEntries(
  entries: Iterable<Entry>,
  runtime: string,
  query: string,
  options: SearchOptions = {},
): TranscriptSearch {
  const index = new TranscriptIndex(runtime);
  for (const entry of entries) index.add(entry);
  return index.search(query, options);
}

/**
 * The query as a case-insensitive literal, its spaces matching any whitespace (as Markdown shows
 * it); null when empty. The web app marks matches with the same one.
 */
export function searchPattern(query: string, flags = "iu"): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), flags);
}

/**
 * A tool call's input as its card shows it: the values of its JSON (a command, a path, the text
 * an edit wrote), not JSON's quoting and escapes; anything else as it is.
 */
function inputText(input: string | null): string | null {
  if (input === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return input;
  }
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") values.push(value);
    else if (typeof value === "number" || typeof value === "boolean") values.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(parsed);
  return values.join("\n");
}

type Snippet = Pick<TranscriptHit, "snippet" | "match">;

/** The first match with some text around it, on one line; … where it was cut. */
function snippetOf(text: string, pattern: RegExp): Snippet {
  const found = pattern.exec(text);
  if (found === null) return { snippet: oneLine(text.slice(0, BEFORE + AFTER)), match: [0, 0] };
  const start = Math.max(0, found.index - BEFORE);
  const end = Math.min(text.length, found.index + found[0].length + AFTER);
  const before = `${start > 0 ? "…" : ""}${oneLine(text.slice(start, found.index)).trimStart()}`;
  const hit = oneLine(found[0]);
  const after = `${oneLine(text.slice(found.index + found[0].length, end)).trimEnd()}${end < text.length ? "…" : ""}`;
  return { snippet: `${before}${hit}${after}`, match: [before.length, before.length + hit.length] };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ");
