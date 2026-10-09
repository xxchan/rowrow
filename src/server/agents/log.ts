// The agent logs (docs/architecture.md, "The agent log"): append, read windows, follow.
// Appends are synchronous inserts (WAL, synchronous=normal: no fsync per commit), so an
// entry is in the database before any listener hears of it. Listeners are called in
// append order; a subscription that replays from a cursor reads the database and starts
// listening in the same tick, so nothing falls between the two.
// Older oar records are packed (D-041): runs of them move from rows into zstd blocks, and
// every read merges both by seq, so readers never know.
import type { RawEvent } from "@botiverse/oar";
import { setImmediate as nextTick } from "node:timers/promises";
import zlib from "node:zlib";
import type { Entry, EntryBody, EntryKind, EntryOf } from "../../shared/entries.ts";
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

/** Records rewritten per transaction; the server answers between pages. */
const REWRITE_PAGE = 200;
/** Records per pack at most, so reading a window decompresses little it doesn't need. */
const PACK_MAX = 2000;
/** An agent still writing is packed once this many of its records are old enough (a long turn). */
const PACK_MIN = 500;

interface PackRow {
  readonly agent_id: string;
  readonly first_seq: number;
  readonly body: Uint8Array;
}

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
    const pack = this.db.get<{ seq: number | null }>(
      "select max(last_seq) as seq from entry_packs where agent_id = ?",
      agentId,
    );
    const head = Math.max(row?.seq ?? -1, pack?.seq ?? -1);
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
      const entries: Entry[] = [];
      for (const entry of this.scan(agentId, options.after)) {
        if (entries.push(entry) >= limit) break;
      }
      return { entries, firstSeq: entries[0]?.seq ?? -1, headSeq, hasMore: options.after >= 0 };
    }
    const end = options.before ?? headSeq + 1;
    const start = this.windowStart(agentId, end, options.turns ?? 3);
    // Past the limit, keep the newest entries: the end of a conversation matters most.
    let entries: Entry[] = [];
    for (const entry of this.scan(agentId, start - 1, end)) {
      if (entries.push(entry) >= 2 * limit) entries = entries.slice(-limit);
    }
    entries = entries.slice(-limit);
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
  iterate(agentId: string): Generator<Entry> {
    return this.scan(agentId, -1);
  }

  /**
   * The entries with `after` < seq < `before`, oldest first: rows and packed records merged by
   * seq (packs never overlap, so a pack's records go out in a run between rows).
   */
  private *scan(agentId: string, after: number, before = Number.MAX_SAFE_INTEGER): Generator<Entry> {
    const rows = this.db.sql
      .prepare("select seq, body from entries where agent_id = ? and seq > ? and seq < ? order by seq")
      .iterate(agentId, after, before) as Iterator<{ seq: number; body: string }>;
    const packs = this.db.sql
      .prepare(
        "select agent_id, first_seq, body from entry_packs where agent_id = ? and last_seq > ? and first_seq < ? order by first_seq",
      )
      .iterate(agentId, after, before) as Iterator<PackRow>;
    let row = rows.next();
    for (let pack = packs.next(); pack.done !== true; pack = packs.next()) {
      for (; row.done !== true && row.value.seq < pack.value.first_seq; row = rows.next()) {
        yield JSON.parse(row.value.body) as Entry;
      }
      for (const entry of unpack(pack.value.body)) {
        if (entry.seq <= after || entry.seq >= before) continue;
        for (; row.done !== true && row.value.seq < entry.seq; row = rows.next()) {
          yield JSON.parse(row.value.body) as Entry;
        }
        yield entry;
      }
    }
    for (; row.done !== true; row = rows.next()) yield JSON.parse(row.value.body) as Entry;
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

  /** An agent's entries of these kinds, oldest first. Not for oar records (packed). */
  ofKinds<K extends Exclude<EntryKind, "oar">>(agentId: string, kinds: readonly K[]): EntryOf<K>[] {
    return this.rows(
      `select body from entries where agent_id = ? and kind in (${kinds.map(() => "?").join(", ")}) order by seq`,
      agentId,
      ...kinds,
    ) as EntryOf<K>[];
  }

  /** An agent's entries of one kind appended since `at` (epoch ms), oldest first. Not for oar records (packed). */
  recent<K extends Exclude<EntryKind, "oar">>(agentId: string, kind: K, at: number): EntryOf<K>[] {
    return this.rows(
      "select body from entries where agent_id = ? and kind = ? and at >= ? order by seq",
      agentId,
      kind,
      at,
    ) as EntryOf<K>[];
  }

  /**
   * Replay the entries after `after`, then deliver new ones as they are appended.
   * Returns the unsubscribe function.
   */
  follow(agentId: string, after: number, listener: Listener): () => void {
    // Read it all before calling the listener: what it does can't move rows under the scan.
    const replay = Array.from(this.scan(agentId, after));
    for (const entry of replay) listener(entry);
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

  /**
   * Run stored oar records through `rewrite` and write back the ones it changes: oar's
   * redactRecord, for credentials a runtime reported that oar recorded as they came before it
   * knew better. Only records whose JSON contains one of `needles` (oar's REDACTION_RULES frame
   * type prefixes) are read, so this is cheap enough for every start; a page at a time, so the
   * server keeps answering. Returns how many changed.
   */
  async rewriteRecords(
    rules: { readonly frameTypePrefixes: readonly string[]; readonly version: number },
    rewrite: (record: RawEvent) => RawEvent,
  ): Promise<number> {
    const needles = rules.frameTypePrefixes;
    const changed = await this.rewritePacks(rules.version, rewrite);
    if (needles.length === 0) return changed;
    return changed + (await this.rewriteRows(needles, rewrite));
  }

  /** Packs last redacted with older rules: unpacked, rewritten and packed again, one at a time. */
  private async rewritePacks(version: number, rewrite: (record: RawEvent) => RawEvent): Promise<number> {
    let changed = 0;
    for (;;) {
      const pack = this.db.get<PackRow>(
        "select agent_id, first_seq, body from entry_packs where rules_version < ? limit 1",
        version,
      );
      if (pack === undefined) return changed;
      let touched = false;
      const entries = unpack(pack.body).map((entry) => {
        if (entry.kind !== "oar") return entry;
        const record = rewrite(entry.record);
        if (record === entry.record) return entry;
        touched = true;
        changed++;
        return { ...entry, record };
      });
      this.db.run(
        "update entry_packs set rules_version = ?, body = ? where agent_id = ? and first_seq = ?",
        version,
        touched ? packOf(entries) : pack.body,
        pack.agent_id,
        pack.first_seq,
      );
      await nextTick();
    }
  }

  private async rewriteRows(
    needles: readonly string[],
    rewrite: (record: RawEvent) => RawEvent,
  ): Promise<number> {
    const mentions = needles.map(() => "instr(body, ?) > 0").join(" or ");
    let agentId = "";
    let seq = -1;
    let changed = 0;
    for (;;) {
      const rows = this.db.all<{ agent_id: string; seq: number; body: string }>(
        `select agent_id, seq, body from entries where kind = 'oar' and (agent_id, seq) > (?, ?) and (${mentions}) order by agent_id, seq limit ?`,
        agentId,
        seq,
        ...needles,
        REWRITE_PAGE,
      );
      const last = rows.at(-1);
      if (last === undefined) return changed;
      this.db.transaction(() => {
        for (const row of rows) {
          const entry = JSON.parse(row.body) as Extract<Entry, { kind: "oar" }>;
          const record = rewrite(entry.record);
          if (record === entry.record) continue;
          this.db.run(
            "update entries set body = ? where agent_id = ? and seq = ?",
            JSON.stringify({ ...entry, record }),
            row.agent_id,
            row.seq,
          );
          changed++;
        }
      });
      agentId = last.agent_id;
      seq = last.seq;
      await nextTick();
    }
  }

  /**
   * Move oar records written before `cutoff` from rows into packs (D-041), up to PACK_MAX each:
   * an agent's whole backlog once it has gone quiet (its turn ended, or its process did), else
   * once PACK_MIN have waited (a turn that runs for hours). Records are packed as they are,
   * after the start's redaction pass, so a pack is marked with the rules it was redacted with.
   * A pack at a time, so the server keeps answering. Returns how many records were packed.
   */
  async pack(cutoff: number, rulesVersion: number): Promise<number> {
    let packed = 0;
    const agents = this.db.all<{ agent_id: string; pending: number; last_seq: number }>(
      "select agent_id, count(*) as pending, max(seq) as last_seq from entries where kind = 'oar' and at < ? group by agent_id",
      cutoff,
    );
    for (const agent of agents) {
      const newest = this.db.get<{ at: number }>(
        "select max(at) as at from entries where agent_id = ?",
        agent.agent_id,
      )?.at;
      if (agent.pending < PACK_MIN && newest !== undefined && newest >= cutoff) continue;
      for (;;) {
        const rows = this.db.all<{ seq: number; body: string }>(
          "select seq, body from entries where agent_id = ? and kind = 'oar' and seq <= ? order by seq limit ?",
          agent.agent_id,
          agent.last_seq,
          PACK_MAX,
        );
        const first = rows[0];
        const last = rows.at(-1);
        if (first === undefined || last === undefined) break;
        this.db.transaction(() => {
          this.db.run(
            "insert into entry_packs (agent_id, first_seq, last_seq, count, rules_version, body) values (?, ?, ?, ?, ?, ?)",
            agent.agent_id,
            first.seq,
            last.seq,
            rows.length,
            rulesVersion,
            zlib.zstdCompressSync(Buffer.from(rows.map((row) => row.body).join("\n"))),
          );
          this.db.run(
            "delete from entries where agent_id = ? and kind = 'oar' and seq >= ? and seq <= ?",
            agent.agent_id,
            first.seq,
            last.seq,
          );
        });
        packed += rows.length;
        await nextTick();
      }
    }
    return packed;
  }

  count(): number {
    const rows = this.db.get<{ n: number }>("select count(*) as n from entries")?.n ?? 0;
    return rows + (this.db.get<{ n: number | null }>("select sum(count) as n from entry_packs")?.n ?? 0);
  }

  private rows(query: string, ...params: (string | number)[]): Entry[] {
    return this.db.all<{ body: string }>(query, ...params).map((row) => JSON.parse(row.body) as Entry);
  }
}

function unpack(body: Uint8Array): Entry[] {
  return zlib
    .zstdDecompressSync(body)
    .toString("utf8")
    .split("\n")
    .map((line) => JSON.parse(line) as Entry);
}

function packOf(entries: readonly Entry[]): Buffer {
  return zlib.zstdCompressSync(Buffer.from(entries.map((entry) => JSON.stringify(entry)).join("\n")));
}
