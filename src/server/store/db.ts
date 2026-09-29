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
