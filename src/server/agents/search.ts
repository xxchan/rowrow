// Transcript search (agents.search, D-055): an agent's whole log, rows and packs, folded the way
// every client folds it (src/shared/transcript-search.ts) and searched. Searching as you type
// asks again for every few letters, so the folds of the agents searched last are kept for a
// while, and the next search folds only what was appended since.
import { setImmediate as nextTick } from "node:timers/promises";
import { slimEntry } from "../../shared/entries.ts";
import type { TranscriptSearch } from "../../shared/schemas.ts";
import { TranscriptIndex, type SearchOptions } from "../../shared/transcript-search.ts";
import type { AgentLog } from "./log.ts";

/** Folds kept, the ones searched last. */
const KEEP = 3;
/** How long a fold nobody searches is kept. */
const IDLE_MS = 10 * 60_000;
/** Entries folded between turns of the event loop, so a long log doesn't hold up the server. */
const PAGE = 5000;

export class TranscriptSearches {
  private readonly log: AgentLog;
  private readonly runtimeOf: (agentId: string) => string;
  /** Least recently searched first. */
  private readonly kept = new Map<string, TranscriptIndex>();
  private timer: NodeJS.Timeout | null = null;

  constructor(log: AgentLog, runtimeOf: (agentId: string) => string) {
    this.log = log;
    this.runtimeOf = runtimeOf;
  }

  async search(agentId: string, text: string, options: SearchOptions = {}): Promise<TranscriptSearch> {
    const index = this.kept.get(agentId) ?? new TranscriptIndex(this.runtimeOf(agentId));
    this.kept.delete(agentId);
    this.kept.set(agentId, index);
    for (const oldest of this.kept.keys()) {
      if (this.kept.size <= KEEP) break;
      this.kept.delete(oldest);
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.kept.clear(), IDLE_MS).unref();
    // A page at a time, each read whole: another search of the same agent meanwhile folds on
    // from where this one got (the index skips what it has).
    for (;;) {
      const page = this.log.read(agentId, { after: index.headSeq, limit: PAGE });
      // Slim, as clients fold them: what the transcript shows, without natives to keep.
      for (const entry of page.entries) index.add(slimEntry(entry));
      if (page.entries.length < PAGE) break;
      await nextTick();
    }
    return index.search(text, options);
  }
}
