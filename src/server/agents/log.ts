// The agent logs (docs/architecture.md, "The agent log"): append, read windows, follow.
// Appends are synchronous inserts (WAL, synchronous=normal: no fsync per commit), so an
// entry is in the database before any listener hears of it. Listeners are called in
// append order; a subscription that replays from a cursor reads the database and starts
// listening in the same tick, so nothing falls between the two.
import type { Entry, EntryBody } from "../../shared/entries.ts";
import type { Db } from "../store/db.ts";

export interface LogWindow {
  readonly entries: Entry[];
  readonly firstSeq: number;
  readonly headSeq: number;
  readonly hasMore: boolean;
}

export interface ReadOptions {
  /** Entries after this seq, forward. */
  readonly after?: number;
  /** The window ending before this seq (older history). */
  readonly before?: number;
  /** Window size in inputs: start at the n-th most recent input (default 3). */
  readonly turns?: number;
  readonly limit?: number;
}

type Listener = (entry: Entry) => void;

export class AgentLog {
  private readonly heads = new Map<string, number>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly anyListeners = new Set<(agentId: string, entry: Entry) => void>();

  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  head(agentId: string): number {
    const cached = this.heads.get(agentId);
    if (cached !== undefined) return cached;
    const row = this.db.get<{ seq: number | null }>(
      "select max(seq) as seq from entries where agent_id = ?",
      agentId,
    );
    const head = row?.seq ?? -1;
    this.heads.set(agentId, head);
    return head;
  }

  append(agentId: string, body: EntryBody): Entry {
    const seq = this.head(agentId) + 1;
    const entry = { ...body, seq, at: Date.now() } as Entry;
    this.db.run(
      "insert into entries (agent_id, seq, at, kind, run_id, input_id, body) values (?, ?, ?, ?, ?, ?, ?)",
      agentId,
      seq,
      entry.at,
      entry.kind,
      "runId" in entry ? entry.runId : null,
      "inputId" in entry ? entry.inputId : null,
      JSON.stringify(entry),
    );
    this.heads.set(agentId, seq);
    for (const listener of this.anyListeners) listener(agentId, entry);
    for (const listener of this.listeners.get(agentId) ?? []) listener(entry);
    return entry;
  }

  read(agentId: string, options: ReadOptions = {}): LogWindow {
    const headSeq = this.head(agentId);
    const limit = options.limit ?? 20_000;
    if (options.after !== undefined) {
      const entries = this.rows(
        "select body from entries where agent_id = ? and seq > ? order by seq limit ?",
        agentId,
        options.after,
        limit,
      );
      return { entries, firstSeq: entries[0]?.seq ?? -1, headSeq, hasMore: options.after >= 0 };
    }
    const end = options.before ?? headSeq + 1;
    const start = this.windowStart(agentId, end, options.turns ?? 3);
    // Past the limit, keep the newest entries: the end of a conversation matters most.
    const entries = this.rows(
      "select body from (select seq, body from entries where agent_id = ? and seq >= ? and seq < ? order by seq desc limit ?) order by seq",
      agentId,
      start,
      end,
      limit,
    );
    const firstSeq = entries[0]?.seq ?? -1;
    return { entries, firstSeq, headSeq, hasMore: firstSeq > 0 };
  }

  /** Where a window of `turns` inputs ending before `end` starts: at an input, so the fold opens on a turn. */
  private windowStart(agentId: string, end: number, turns: number): number {
    const row = this.db.get<{ seq: number }>(
      "select seq from entries where agent_id = ? and kind = 'input' and seq < ? order by seq desc limit 1 offset ?",
      agentId,
      end,
      turns - 1,
    );
    return row?.seq ?? 0;
  }

  /** Every entry, oldest first, without holding them all at once. */
  *iterate(agentId: string): Generator<Entry> {
    const statement = this.db.sql.prepare("select body from entries where agent_id = ? order by seq");
    for (const row of statement.iterate(agentId)) yield JSON.parse((row as { body: string }).body) as Entry;
  }

  /** The input entry with this id and its result, for idempotent sends. */
  findInput(agentId: string, inputId: string): { input?: Entry; result?: Entry } {
    const found: { input?: Entry; result?: Entry } = {};
    for (const entry of this.rows(
      "select body from entries where agent_id = ? and input_id = ? order by seq",
      agentId,
      inputId,
    )) {
      if (entry.kind === "input") found.input = entry;
      else if (entry.kind === "input.result") found.result = entry;
    }
    return found;
  }

  /**
   * Replay the entries after `after`, then deliver new ones as they are appended.
   * Returns the unsubscribe function.
   */
  follow(agentId: string, after: number, listener: Listener): () => void {
    for (const entry of this.rows(
      "select body from entries where agent_id = ? and seq > ? order by seq",
      agentId,
      after,
    )) {
      listener(entry);
    }
    let set = this.listeners.get(agentId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(agentId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(agentId);
    };
  }

  /** Every append of every agent (the server's summary folds). */
  onAppend(listener: (agentId: string, entry: Entry) => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  count(): number {
    return this.db.get<{ n: number }>("select count(*) as n from entries")?.n ?? 0;
  }

  private rows(query: string, ...params: (string | number)[]): Entry[] {
    return this.db.all<{ body: string }>(query, ...params).map((row) => JSON.parse(row.body) as Entry);
  }
}
