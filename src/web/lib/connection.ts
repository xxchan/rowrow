// The browser's one connection to the server (docs/decisions.md, D-003): a WebSocket that
// carries every call and subscription. Disconnection is the normal case on a phone
// (PRINCIPLES.md, engineering 2): it reconnects with backoff, at once when the network or
// the page comes back, and everything subscribed resumes from its own cursor.
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "../../shared/contract.ts";

export type Client = ContractRouterClient<typeof contract>;

export type ConnectionStatus =
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "open"; readonly client: Client; readonly since: number }
  | { readonly kind: "offline"; readonly since: number; readonly retryAt: number; readonly attempt: number }
  /** No valid credential: the sign-in screen, not a retry loop. */
  | { readonly kind: "signed-out" };

type Listener = (status: ConnectionStatus) => void;

let lastTrace: string | null = null;
/** The trace id of the most recent call, attached to client error reports. */
export function recentTrace(): string | null {
  return lastTrace;
}

function traceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

class Connection {
  private status: ConnectionStatus = { kind: "connecting", attempt: 0 };
  private readonly listeners = new Set<Listener>();
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private started = false;

  get current(): ConnectionStatus {
    return this.status;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener("online", () => this.retryNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.retryNow();
    });
    void this.connect();
  }

  /** Reconnect now if we are waiting to (network back, page shown again). */
  retryNow(): void {
    if (this.status.kind === "offline") {
      if (this.timer !== null) clearTimeout(this.timer);
      void this.connect();
    }
  }

  private async connect(): Promise<void> {
    this.attempt += 1;
    this.set({ kind: "connecting", attempt: this.attempt });
    // A browser can't read the HTTP status of a refused WebSocket, so ask first.
    try {
      const probe = await fetch("/api/devices/whoami", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (probe.status === 401) {
        this.set({ kind: "signed-out" });
        return;
      }
    } catch {
      this.scheduleRetry();
      return;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/rpc`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      const client = createORPCClient<Client>(
        new RPCLink({
          websocket: socket,
          headers: () => {
            lastTrace = traceId();
            return { "x-rowrow-trace": lastTrace };
          },
        }),
      );
      this.set({ kind: "open", client, since: Date.now() });
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.attempt, 5)) * (0.8 + Math.random() * 0.4);
    const since = this.status.kind === "offline" ? this.status.since : Date.now();
    this.set({ kind: "offline", since, retryAt: Date.now() + delay, attempt: this.attempt });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}

export const connection = new Connection();
