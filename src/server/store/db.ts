// The profile's database (docs/decisions.md, D-005). Plain SQL through node:sqlite; each
// table has a few typed functions here and nowhere else. Inspect it with
// `sqlite3 ~/.rowrow/<profile>/rowrow.db`.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS: readonly string[] = [
  // 1: the first schema
  `
  create table workspaces (
    id text primary key,
    path text not null unique,
    custom_label text,
    created_at integer not null,
    archived integer not null default 0
  );
  create table agents (
    id text primary key,
    workspace_id text not null,
    created_at integer not null,
    seen_seq integer not null default -1
  );
  -- One append-only log per agent (docs/architecture.md, "The agent log"). body is the whole entry as JSON.
  create table entries (
    agent_id text not null,
    seq integer not null,
    at integer not null,
    kind text not null,
    run_id text,
    input_id text,
    body text not null,
    primary key (agent_id, seq)
  ) without rowid;
  create index entries_by_input on entries (agent_id, input_id) where input_id is not null;
  create index entries_by_kind on entries (agent_id, kind, seq);
  create table devices (
    id text primary key,
    name text not null,
    kind text not null,
    token_hash text not null unique,
    created_at integer not null,
    last_seen_at integer,
    revoked_at integer
  );
  create table login_links (
    code_hash text primary key,
    name text,
    created_at integer not null,
    expires_at integer not null,
    used_at integer
  );
  create table push_subscriptions (
    device_id text primary key,
    endpoint text not null,
    p256dh text not null,
    auth text not null,
    created_at integer not null
  );
  create table turn_snapshots (
    workspace_id text primary key,
    tree text not null,
    agent_id text,
    taken_at integer not null
  );
  `,
  // 2: the commit a rowrow-made worktree started from (the branch scope's merge-base hint)
  `
  alter table workspaces add column base text;
  alter table workspaces add column base_label text;
  `,
  // 3: "last turn" baselines per agent, with the end of the turn (docs/git.md)
  `
  drop table turn_snapshots;
  create table agent_turns (
    agent_id text primary key,
    workspace_id text not null,
    start_tree text,
    end_tree text,
    started_at integer not null,
    ended_at integer,
    note text
  );
  create index agent_turns_by_workspace on agent_turns (workspace_id, started_at);
  `,
  // 4: settings that follow you to every device (quick replies…), one JSON value per key
  `
  create table settings (
    key text primary key,
    value text not null,
    updated_at integer not null
  );
  `,
  // 5: the iOS app's push tokens (APNs, D-028): one per device, with Apple's environment, the
  // app's bundle id, and the device's key that what notifications say is encrypted with
  `
  create table apns_tokens (
    device_id text primary key,
    token text not null,
    environment text not null,
    topic text not null,
    key text,
    created_at integer not null
  );
  `,
  // 6: subscription usage readings (D-040): one series per account and window, percent left,
  // kept sparse (a run of equal readings keeps its first and last)
  `
  create table usage_points (
    account text not null,
    window_id text not null,
    at integer not null,
    left real not null,
    resets_at integer,
    primary key (account, window_id, at)
  ) without rowid;
  `,
  // 7: packed oar records (D-041): a run of one agent's oar entries as zstd-compressed JSON
  // lines, in place of their rows. Packs never overlap; other kinds of entries stay rows.
  // rules_version is oar's REDACTION_RULES.version its records were last redacted with.
  `
  create table entry_packs (
    agent_id text not null,
    first_seq integer not null,
    last_seq integer not null,
    count integer not null,
    rules_version integer not null,
    body blob not null,
    primary key (agent_id, first_seq)
  ) without rowid;
  `,
  // 8: pinned agents (D-046): when you pinned it; null when it isn't
  `
  alter table agents add column pinned_at integer;
  `,
];

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec(
      "pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000; pragma foreign_keys = on;",
    );
    this.migrate();
  }

  private migrate(): void {
    const current = (this.sql.prepare("pragma user_version").get() as { user_version: number }).user_version;
    if (current > MIGRATIONS.length) {
      throw new Error(
        `the database is from a newer rowrow (schema ${current}, this one knows ${MIGRATIONS.length})`,
      );
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.sql.exec(MIGRATIONS[version] ?? "");
        this.sql.exec(`pragma user_version = ${version + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec("begin");
    try {
      const result = fn();
      this.sql.exec("commit");
      return result;
    } catch (error) {
      this.sql.exec("rollback");
      throw error;
    }
  }

  all<T>(query: string, ...params: SQLInputValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  get<T>(query: string, ...params: SQLInputValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  run(query: string, ...params: SQLInputValue[]): { changes: number } {
    const result = this.sql.prepare(query).run(...params);
    return { changes: Number(result.changes) };
  }

  close(): void {
    this.sql.close();
  }
}
