// Structured logging (docs/architecture.md, "Observability"). Every line is one JSON
// object with a stable, dot-namespaced event name (`evt`), the trace and the ids of the
// work it belongs to, taken from the async context. Lines go to a JSONL file (rotated), a
// ring buffer (for `logs.query` and `rowrow status`), live subscribers (`logs.watch`), and
// stderr (readable in dev, JSON otherwise).
//
// Log events, not prose: log.info("agent.run.started", { runtime }). Never swallow an
// error: log it with context.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Level, LogEntry, LogFilter } from "../../shared/schemas.ts";

/** Ids of the work a line belongs to. Set once per request or task; every line inside inherits them. */
export interface LogContext {
  readonly trace?: string;
  readonly agent?: string;
  readonly run?: string;
  readonly ws?: string;
  readonly device?: string;
  readonly conn?: string;
}

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_SIZE = 20_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const KEEP_FILES = 3;

const context = new AsyncLocalStorage<LogContext>();
const ring: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

let file: { path: string; fd: number; size: number } | null = null;
let consoleLevel: Level = "info";
let consoleFormat: "pretty" | "json" | "off" = "pretty";

export interface LogSetup {
  /** Directory for rowrow.jsonl; no file when omitted (tests). */
  readonly dir?: string;
  readonly consoleLevel?: Level;
  readonly consoleFormat?: "pretty" | "json" | "off";
}

export function setupLog(setup: LogSetup): void {
  closeLog();
  consoleLevel = setup.consoleLevel ?? "info";
  consoleFormat = setup.consoleFormat ?? "pretty";
  if (setup.dir !== undefined) {
    fs.mkdirSync(setup.dir, { recursive: true });
    const filePath = path.join(setup.dir, "rowrow.jsonl");
    const fd = fs.openSync(filePath, "a");
    file = { path: filePath, fd, size: fs.fstatSync(fd).size };
  }
}

export function closeLog(): void {
  if (file !== null) {
    fs.closeSync(file.fd);
    file = null;
  }
}

export function logFile(): string | null {
  return file?.path ?? null;
}

export function newTraceId(): string {
  return randomBytes(8).toString("hex");
}

/** Run `fn` with extra context ids; lines logged inside (across awaits) carry them. */
export function withContext<T>(extra: LogContext, fn: () => T): T {
  return context.run({ ...context.getStore(), ...extra }, fn);
}

export function currentContext(): LogContext {
  return context.getStore() ?? {};
}

function write(level: Level, evt: string, fields?: Readonly<Record<string, unknown>>): void {
  const entry: LogEntry = { time: Date.now(), level, evt, ...currentContext(), ...sanitize(fields) };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  const line = `${JSON.stringify(entry)}\n`;
  if (file !== null) {
    try {
      fs.writeSync(file.fd, line);
      file.size += Buffer.byteLength(line);
      if (file.size > MAX_FILE_BYTES) rotate();
    } catch (error) {
      process.stderr.write(`rowrow: cannot write the log file: ${String(error)}\n`);
    }
  }
  if (consoleFormat !== "off" && RANK[level] >= RANK[consoleLevel]) {
    process.stderr.write(consoleFormat === "json" ? line : pretty(entry));
  }
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // a broken live tail must never break logging
    }
  }
}

function rotate(): void {
  if (file === null) return;
  const { path: current, fd } = file;
  fs.closeSync(fd);
  for (let i = KEEP_FILES - 1; i >= 1; i--) {
    const from = `${current}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${current}.${i + 1}`);
  }
  fs.renameSync(current, `${current}.1`);
  const next = fs.openSync(current, "a");
  file = { path: current, fd: next, size: 0 };
}

export const log = {
  debug: (evt: string, fields?: Readonly<Record<string, unknown>>): void => write("debug", evt, fields),
  info: (evt: string, fields?: Readonly<Record<string, unknown>>): void => write("info", evt, fields),
  warn: (evt: string, fields?: Readonly<Record<string, unknown>>): void => write("warn", evt, fields),
  error: (evt: string, fields?: Readonly<Record<string, unknown>>): void => write("error", evt, fields),
  /** Write an entry that already has its shape (browser events arriving through telemetry.report). */
  entry: (level: Level, evt: string, fields: Readonly<Record<string, unknown>>): void => write(level, evt, fields),
};

// ─── Reading ─────────────────────────────────────────────────────────────────

export function matches(entry: LogEntry, filter: LogFilter): boolean {
  if (filter.since !== undefined && entry.time < filter.since) return false;
  if (filter.level !== undefined && RANK[entry.level] < RANK[filter.level]) return false;
  if (filter.evt !== undefined && !entry.evt.startsWith(filter.evt)) return false;
  if (filter.trace !== undefined && entry.trace !== filter.trace) return false;
  if (filter.agent !== undefined && entry["agent"] !== filter.agent) return false;
  if (filter.text !== undefined && !JSON.stringify(entry).includes(filter.text)) return false;
  return true;
}

/** Matching entries from the ring buffer, oldest first, the newest `limit` of them. */
export function queryLog(filter: LogFilter): LogEntry[] {
  const out: LogEntry[] = [];
  const limit = filter.limit ?? 500;
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = ring[i];
    if (entry !== undefined && matches(entry, filter)) out.push(entry);
  }
  return out.reverse();
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const SECRET_KEYS = /^(token|password|secret|cookie|authorization|code|auth|p256dh)$/i;
const SECRET_PARAMS = /([?&](?:code|token|key)=)[^&#\s"]+/gi;

function sanitize(fields: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = SECRET_KEYS.test(key) ? "[redacted]" : scrub(value);
  }
  return out;
}

function scrub(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "string") return value.replace(SECRET_PARAMS, "$1[redacted]");
  return value;
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const out: Record<string, unknown> = { type: error.name, message: error.message.replace(SECRET_PARAMS, "$1[redacted]") };
  if (error.stack !== undefined) out["stack"] = error.stack;
  const code = (error as { code?: unknown }).code;
  if (code !== undefined) out["code"] = code;
  if (error.cause !== undefined) out["cause"] = serializeError(error.cause);
  return out;
}

const COLOR: Record<Level, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };

function pretty(entry: LogEntry): string {
  const { time, level, evt, msg, ...rest } = entry;
  const clock = new Date(time).toISOString().slice(11, 23);
  const pairs = Object.entries(rest)
    .filter(([key]) => key !== "err")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  const err = rest["err"] as { stack?: string; message?: string } | undefined;
  const tail = err === undefined ? "" : `\n${err.stack ?? err.message ?? ""}`;
  return `\x1b[90m${clock}\x1b[0m ${COLOR[level]}${level.toUpperCase().padEnd(5)}\x1b[0m ${evt}${msg === undefined ? "" : ` ${msg}`} ${pairs}${tail}\n`;
}
