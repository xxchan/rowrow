// Browser errors land in the server log (PRINCIPLES.md, engineering 4): uncaught errors,
// rejected promises, render errors, failed calls, lost connections. Batched, sent over
// plain HTTP (it must work while the WebSocket is down), and logged as `client.*` with the
// device, route and version, so `rowrow errors` shows what went wrong on your phone.
import type { ClientEvent, Level } from "../../shared/schemas.ts";
import { recentTrace } from "./connection.ts";

const queue: ClientEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function report(level: Level, evt: string, error?: unknown, data?: Record<string, unknown>): void {
  const err = error === undefined ? undefined : describe(error);
  queue.push({
    level,
    evt,
    at: Date.now(),
    route: location.pathname + location.search,
    ...(err === undefined ? {} : { msg: err.message }),
    ...(recentTrace() === null ? {} : { trace: recentTrace() ?? undefined }),
    data: {
      ...data,
      ...(err?.stack === undefined ? {} : { stack: err.stack }),
      ...(err?.code === undefined ? {} : { code: err.code }),
      ua: navigator.userAgent,
    },
  });
  if (level === "error" || level === "warn") console[level](`[rowrow] ${evt}`, error ?? "", data ?? "");
  if (queue.length > 100) queue.splice(0, queue.length - 100);
  timer ??= setTimeout(() => void flush(), level === "error" ? 200 : 2000);
}

function describe(error: unknown): { message: string; stack?: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack.slice(0, 4000) }),
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { message: String(error) };
}

async function flush(): Promise<void> {
  timer = null;
  if (queue.length === 0) return;
  const events = queue.splice(0, queue.length);
  try {
    await fetch("/api/telemetry/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
      keepalive: true,
    });
  } catch {
    // Offline: keep the newest events for the next try.
    queue.unshift(...events.slice(-50));
    timer ??= setTimeout(() => void flush(), 10_000);
  }
}

export function installGlobalHandlers(): void {
  window.addEventListener("error", (event) => report("error", "uncaught", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) =>
    report("error", "unhandled_rejection", event.reason),
  );
  window.addEventListener("pagehide", () => void flush());
}
