// One server, live (docs/desktop.md): where it is, the credential this app holds there, and
// its notifications. Reconnects with backoff forever (PRINCIPLES.md, engineering 2: a server
// restarting, a tunnel dropping and a Mac waking up are all the normal case), and signs in again
// on its own where the app can mint a code (this Mac, SSH hosts). A URL server whose credential
// stops working needs a new link from you.
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "../shared/contract.ts";
import type { Notice } from "../shared/schemas.ts";
import type { ServerStatus } from "./api.ts";
import { serializeError, type Logger } from "./log.ts";

export type Client = ContractRouterClient<typeof contract>;

/** The server doesn't take the credential (revoked, or its data was reset). */
export class SignedOut extends Error {}

export interface ConnectionOptions {
  readonly id: string;
  /** Where the server is now: may start a tunnel or ask the host; throws when it can't be reached. */
  origin(): Promise<string>;
  token(): string | null;
  saveToken(token: string): void;
  /** A fresh one-time code (the host's `rowrow pair`), where the app can get one. */
  readonly mintCode: (() => Promise<string>) | null;
  /** Sign a browser session in with a code and return its credential (servers without /auth/token). */
  readonly redeemInBrowser: (origin: string, code: string) => Promise<string | null>;
  readonly deviceName: string;
  onStatus(status: ServerStatus): void;
  onNotice(notice: Notice): void;
  /** Online, with what the server says it is; `restarted` when it isn't the process it was. */
  onOnline(info: { origin: string; version: string; restarted: boolean }): void;
  readonly log: Logger;
  readonly fetch?: typeof fetch;
}

/** Trade a one-time code for a bearer token (POST /auth/token); null when the server predates it. */
export async function redeemCode(
  origin: string,
  code: string,
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const response = await fetcher(`${origin}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => ({}))) as { token?: string; message?: string };
  if (!response.ok || body.token === undefined)
    throw new Error(body.message ?? `signing in failed: HTTP ${response.status}`);
  return body.token;
}

export function clientFor(origin: string, token: string, fetcher?: typeof fetch): Client {
  return createORPCClient<Client>(
    new RPCLink({
      url: `${origin}/rpc`,
      headers: { authorization: `Bearer ${token}` },
      ...(fetcher === undefined ? {} : { fetch: fetcher }),
    }),
  );
}

export class Connection {
  private readonly o: ConnectionOptions;
  private stopped = true;
  private wake: (() => void) | null = null;
  private attempt = 0;
  private abort: AbortController | null = null;
  /** When the server we last saw started: a new one means it restarted (an upgrade, a crash). */
  private serverStartedAt: number | null = null;
  status: ServerStatus = { kind: "connecting", detail: null };
  origin: string | null = null;
  version: string | null = null;
  badge: number | null = null;
  /** The server streams notifications (notify.watch); older ones don't; null until we know. */
  notifications: boolean | null = null;
  client: Client | null = null;

  constructor(options: ConnectionOptions) {
    this.o = options;
  }

  private get fetch(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
  }

  /** Resolves once online (true), or false after `timeoutMs`. */
  async whenOnline(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.status.kind !== "online") {
      if (Date.now() > deadline || this.stopped) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  }

  /** Try again now (Retry, the Mac woke up, the host's server was restarted). */
  kick(): void {
    this.attempt = 0;
    this.abort?.abort();
    this.wake?.();
  }

  private set(status: ServerStatus): void {
    this.status = status;
    this.o.onStatus(status);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.wake = () => {
        this.wake = null;
        done();
      };
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.session();
        this.attempt = 0;
      } catch (error) {
        if (this.stopped) return;
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof SignedOut) {
          this.set({ kind: "signed-out", reason });
          this.o.log.warn("desktop.connection.signed_out", { server: this.o.id, reason });
          await this.sleep(10 * 60_000);
          continue;
        }
        if (this.status.kind !== "offline" || this.status.reason !== reason) {
          this.o.log.info("desktop.connection.offline", { server: this.o.id, reason });
          this.set({ kind: "offline", reason, since: Date.now() });
        }
      }
      if (this.stopped) return;
      const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt, 5));
      this.attempt += 1;
      await this.sleep(delay);
    }
  }

  /** Check a credential: 200 is fine, 401 is not; anything else is the server's trouble. */
  private async accepted(origin: string, token: string): Promise<boolean> {
    const response = await this.fetch(`${origin}/api/devices/whoami`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (response.status === 401) return false;
    if (!response.ok) throw new Error(`the server answered HTTP ${response.status}`);
    return true;
  }

  /** A credential for this server: the one we hold, or a new one where we can mint a code. */
  private async credential(origin: string): Promise<string> {
    const held = this.o.token();
    if (held !== null && (await this.accepted(origin, held))) return held;
    if (this.o.mintCode === null)
      throw new SignedOut(
        held === null
          ? "not signed in yet: add it with a sign-in link"
          : "this Mac was signed out there (its device was revoked): sign in again with a new link",
      );
    this.set({ kind: "connecting", detail: "Signing in" });
    const code = await this.o.mintCode();
    const token =
      (await redeemCode(origin, code, this.o.deviceName, this.fetch)) ??
      (await this.o.redeemInBrowser(origin, code));
    if (token === null) throw new Error("the server didn't give this app a credential");
    this.o.saveToken(token);
    this.o.log.info("desktop.connection.paired", { server: this.o.id });
    return token;
  }

  private async session(): Promise<void> {
    this.set({ kind: "connecting", detail: this.origin === null ? null : "Reconnecting" });
    const origin = await this.o.origin();
    const health = await this.fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(
      (error: unknown) => {
        throw new Error(
          `can't reach the server at ${origin} (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      },
    );
    if (!health.ok) throw new Error(`the server at ${origin} answered HTTP ${health.status}`);
    const { version } = (await health.json()) as { version: string };
    const token = await this.credential(origin);
    const client = clientFor(origin, token, this.o.fetch);
    const info = await client.app.info();
    const restarted = this.serverStartedAt !== null && this.serverStartedAt !== info.startedAt;
    this.serverStartedAt = info.startedAt;
    this.origin = origin;
    this.version = version;
    this.client = client;
    this.set({ kind: "online" });
    this.o.onOnline({ origin, version, restarted });
    this.o.log.info("desktop.connection.online", { server: this.o.id, origin, version, restarted });
    await this.watch(client, origin);
  }

  /** notify.watch until it ends; a server without it is watched by polling its health. */
  private async watch(client: Client, origin: string): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    try {
      if (await this.notices(client, abort.signal)) return;
      // A server from before notify.watch (rowrow < 0.3): no notifications, but still watched.
      while (!this.stopped && !abort.signal.aborted) {
        await this.sleep(15_000);
        const health = await this.fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(10_000) });
        if (!health.ok) throw new Error(`the server answered HTTP ${health.status}`);
      }
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** Hear notify.watch until it ends (true), or learn the server doesn't have it (false). */
  private async notices(client: Client, signal: AbortSignal): Promise<boolean> {
    try {
      const stream = await client.notify.watch(undefined, { signal });
      this.notifications = true;
      for await (const notice of stream) {
        this.badge = notice.badge;
        this.o.onNotice(notice);
      }
      if (!this.stopped) throw new Error("the server closed the connection");
      return true;
    } catch (error) {
      if (signal.aborted) {
        if (this.stopped) return true;
        throw new Error("reconnecting", { cause: error });
      }
      if (!isMissingProcedure(error)) throw error;
      this.notifications = false;
      this.o.log.info("desktop.connection.no_notifications", {
        server: this.o.id,
        err: serializeError(error),
      });
      return false;
    }
  }
}

function isMissingProcedure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  return status === 404 || code === "NOT_FOUND";
}
