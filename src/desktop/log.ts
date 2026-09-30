// The Mac app's own log (PRINCIPLES.md, engineering 4): JSON lines with a stable, dot-namespaced
// event name, in ~/Library/Logs/rowrow/desktop.jsonl (Help → Show the App's Log). What a
// server does is in that server's log; this says what the app did about it: hosts it set up,
// tunnels, pairing, notifications, updates.
import fs from "node:fs";
import path from "node:path";

export type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(evt: string, fields?: Record<string, unknown>): void;
  info(evt: string, fields?: Record<string, unknown>): void;
  warn(evt: string, fields?: Record<string, unknown>): void;
  error(evt: string, fields?: Record<string, unknown>): void;
  readonly file: string | null;
}

const MAX_BYTES = 5_000_000;

export function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error)
    return { message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) };
  return { message: String(error) };
}

/** A logger writing to `file` (rotated at 5 MB to `file.1`), and to stderr when `echo`. */
export function createLogger(file: string | null, echo: boolean): Logger {
  if (file !== null) fs.mkdirSync(path.dirname(file), { recursive: true });
  let size =
    file === null
      ? 0
      : ((): number => {
          try {
            return fs.statSync(file).size;
          } catch {
            return 0;
          }
        })();
  const write = (level: Level, evt: string, fields: Record<string, unknown> = {}): void => {
    const line = `${JSON.stringify({ time: new Date().toISOString(), level, evt, ...fields })}\n`;
    if (echo) process.stderr.write(line);
    if (file === null) return;
    try {
      if (size + line.length > MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += line.length;
    } catch {
      // The log is best effort; never let it take the app down.
    }
  };
  return {
    debug: (evt, fields) => write("debug", evt, fields),
    info: (evt, fields) => write("info", evt, fields),
    warn: (evt, fields) => write("warn", evt, fields),
    error: (evt, fields) => write("error", evt, fields),
    file,
  };
}
