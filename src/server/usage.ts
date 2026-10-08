// Subscription usage (D-040): every few minutes, each signed-in runtime that can say how much
// of its plan's windows is left (oar's accountUsage) is asked, and the readings are stored as
// a sparse series per account and window. Cycles and pace are folds over them (shared/usage.ts).
import type { AccountUsageSnapshot } from "@botiverse/oar";
import type { RuntimeUsage, UsagePoint } from "../shared/schemas.ts";
import type { Db } from "./store/db.ts";
import { log, serializeError } from "./telemetry/log.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How often each runtime is asked; for Claude Code that is one short start of its CLI. */
const EVERY_MS = 5 * MINUTE;
/** The first ask waits for the runtimes' first probe to settle. */
const FIRST_READ_MS = 15_000;
const KEEP_MS = 45 * DAY;
const SHOW_MS = 8 * DAY;

/** A runtime that can read its account's usage now. */
export interface UsageReader {
  readonly id: string;
  readonly read: () => Promise<AccountUsageSnapshot>;
}

interface Latest {
  checkedAt: number;
  problem: RuntimeUsage["problem"];
  /** From the last read that worked. */
  read: { account: string; snapshot: Extract<AccountUsageSnapshot, { kind: "available" }> } | null;
}

export class UsageService {
  readonly #db: Db;
  readonly #readers: () => readonly UsageReader[];
  readonly #now: () => number;
  readonly #latest = new Map<string, Latest>();
  #reading: Promise<void> | null = null;
  /** The read after the running one, for the calls that came while it ran. */
  #next: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: { db: Db; readers: () => readonly UsageReader[]; now?: () => number }) {
    this.#db = options.db;
    this.#readers = options.readers;
    this.#now = options.now ?? Date.now;
  }

  start(delayMs = FIRST_READ_MS): void {
    this.stop();
    this.#timer = setTimeout(() => {
      this.#timer = setInterval(() => void this.readAll(), EVERY_MS);
      this.#timer.unref();
      void this.readAll();
    }, delayMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Ask every runtime that can say, in parallel. A call while a read runs gets a fresh read once
   * it ends, shared by every call that came meanwhile: the running one chose its runtimes, and
   * asked them, before the call (a "Check now" just after a sign-in must ask that runtime).
   */
  readAll(): Promise<void> {
    if (this.#reading === null) {
      this.#reading = this.#readAll().finally(() => {
        this.#reading = null;
      });
      return this.#reading;
    }
    const fresh = (): Promise<void> => {
      this.#next = null;
      return this.readAll();
    };
    this.#next ??= this.#reading.then(fresh, fresh);
    return this.#next;
  }

  async #readAll(): Promise<void> {
    const readers = this.#readers();
    for (const id of this.#latest.keys()) {
      if (!readers.some((reader) => reader.id === id)) this.#latest.delete(id);
    }
    await Promise.all(readers.map((reader) => this.#readOne(reader)));
    this.#db.run("delete from usage_points where at < ?", this.#now() - KEEP_MS);
  }

  async #readOne(reader: UsageReader): Promise<void> {
    const latest: Latest = this.#latest.get(reader.id) ?? { checkedAt: 0, problem: null, read: null };
    let snapshot: AccountUsageSnapshot;
    try {
      snapshot = await reader.read();
    } catch (error) {
      log.warn("usage.read_failed", { runtime: reader.id, error: serializeError(error) });
      this.#latest.set(reader.id, {
        ...latest,
        checkedAt: this.#now(),
        problem: { kind: "failed", detail: error instanceof Error ? error.message : String(error) },
      });
      return;
    }
    const checkedAt = this.#now();
    switch (snapshot.kind) {
      case "available": {
        const account = `${reader.id}:${snapshot.email ?? snapshot.displayName ?? ""}`;
        this.#db.transaction(() => {
          for (const window of snapshot.windows) {
            this.#record(account, window.id ?? window.label, {
              at: checkedAt,
              left: Math.round((1 - window.usedRatio) * 1000) / 10,
              resetsAt: toMinute(window.resetsAt),
            });
          }
        });
        this.#latest.set(reader.id, { checkedAt, problem: null, read: { account, snapshot } });
        log.info("usage.read", { runtime: reader.id, windows: snapshot.windows.length });
        return;
      }
      case "reauth_required":
        this.#latest.set(reader.id, {
          checkedAt,
          problem: { kind: "signed_out", ...(snapshot.reason ? { detail: snapshot.reason } : {}) },
          read: null,
        });
        return;
      case "unsupported":
        this.#latest.set(reader.id, {
          checkedAt,
          problem: { kind: "unsupported", ...(snapshot.reason ? { detail: snapshot.reason } : {}) },
          read: null,
        });
        return;
    }
  }

  /**
   * Store one reading, sparsely: when it equals the last two, the last moves forward to it
   * instead, so a run of equal readings keeps its first and last.
   */
  #record(account: string, windowId: string, point: UsagePoint): void {
    const [last, before] = this.#db.all<{ at: number; left: number; resets_at: number | null }>(
      "select at, left, resets_at from usage_points where account = ? and window_id = ? order by at desc limit 2",
      account,
      windowId,
    );
    const same = (row: typeof last): boolean =>
      row !== undefined && row.left === point.left && row.resets_at === point.resetsAt;
    if (last !== undefined && same(last) && same(before)) {
      this.#db.run(
        "update usage_points set at = ? where account = ? and window_id = ? and at = ?",
        point.at,
        account,
        windowId,
        last.at,
      );
      return;
    }
    this.#db.run(
      "insert or replace into usage_points (account, window_id, at, left, resets_at) values (?, ?, ?, ?, ?)",
      account,
      windowId,
      point.at,
      point.left,
      point.resetsAt,
    );
  }

  #history(account: string, windowId: string, since: number): UsagePoint[] {
    return this.#db
      .all<{ at: number; left: number; resets_at: number | null }>(
        "select at, left, resets_at from usage_points where account = ? and window_id = ? and at >= ? order by at",
        account,
        windowId,
        since,
      )
      .map((row) => ({ at: row.at, left: row.left, resetsAt: row.resets_at }));
  }

  /** Every runtime that can say, with its last read's windows and their recent history. */
  list(): RuntimeUsage[] {
    const since = this.#now() - SHOW_MS;
    return this.#readers().map(({ id }): RuntimeUsage => {
      const latest = this.#latest.get(id);
      const read = latest?.read ?? null;
      return {
        runtime: id,
        checkedAt: latest?.checkedAt ?? null,
        problem: latest?.problem ?? null,
        account:
          read === null
            ? null
            : {
                ...(read.snapshot.email ? { email: read.snapshot.email } : {}),
                ...(read.snapshot.displayName ? { name: read.snapshot.displayName } : {}),
                ...(read.snapshot.plan ? { plan: read.snapshot.plan } : {}),
              },
        rateLimited: read?.snapshot.rateLimited ?? false,
        windows:
          read === null
            ? []
            : read.snapshot.windows.map((window) => {
                const windowId = window.id ?? window.label;
                return {
                  id: windowId,
                  label: window.label,
                  durationMs: window.durationMs ?? null,
                  history: this.#history(read.account, windowId, since),
                };
              }),
      };
    });
  }
}

/** Reset times are kept to the minute: some runtimes compute them afresh on every read. */
function toMinute(instant: string | undefined): number | null {
  const ms = instant === undefined ? Number.NaN : Date.parse(instant);
  return Number.isFinite(ms) ? Math.round(ms / MINUTE) * MINUTE : null;
}
