// The server's front door (docs/architecture.md, "API" and "Auth and remote access"):
//
//   GET  /healthz             liveness, no auth
//   GET  /auth/redeem?code=…  one-time login link → session cookie → the app
//   POST /auth/logout         sign this browser out
//   GET  /rpc  (Upgrade)      the WebSocket every browser uses (oRPC)
//   POST /rpc/*               the same procedures over HTTP (the typed CLI client, tests)
//   *    /api/*               the same procedures as OpenAPI routes (curl, agents); spec at /api/openapi.json
//   GET  /*                   the web app (when built), falling back to index.html
//
// Every request to a procedure needs a device credential: the session cookie or a bearer
// token (D-009). A WebSocket must also come from this server's own origin.
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler as FetchRPCHandler } from "@orpc/server/fetch";
import { RPCHandler as WsRPCHandler } from "@orpc/server/ws";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { getRequestListener } from "@hono/node-server";
import { Hono, type Context as HonoContext } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { contract } from "../../shared/contract.ts";
import type { Actor } from "../../shared/entries.ts";
import type { DeviceRecord, Devices } from "../auth/devices.ts";
import type { Presence } from "../notify/presence.ts";
import { log, serializeError } from "../telemetry/log.ts";
import type { ApiContext, Router } from "./router.ts";

export const COOKIE = "rowrow_session";
const TRACE_HEADER = "x-rowrow-trace";
const AGENT_HEADER = "x-rowrow-agent";

export interface HttpOptions {
  readonly router: Router;
  readonly devices: Devices;
  readonly presence: Presence;
  /** The credential rowrow hands to the agents it runs; requests with it act as an agent. */
  readonly agentDeviceId: string;
  readonly host: string;
  readonly port: number;
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly webDir?: string;
  readonly version: string;
}

export interface HttpServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startHttp(options: HttpOptions): Promise<HttpServer> {
  const secure = options.tls !== undefined;
  const auth = (token: string | undefined, agentHeader: string | undefined): ApiContext | null => {
    const device = options.devices.authenticate(token);
    if (device === null) return null;
    const actor: Actor =
      device.id === options.agentDeviceId && agentHeader !== undefined && agentHeader !== ""
        ? { kind: "agent", agentId: agentHeader }
        : { kind: "device", deviceId: device.id, name: device.name };
    return { device, actor };
  };
  const traceOf = (value: string | null | undefined): Pick<ApiContext, "trace"> =>
    value === null || value === undefined || !/^[\w-]{1,64}$/.test(value) ? {} : { trace: value };

  const httpRpc = new FetchRPCHandler(options.router);
  const openapi = new OpenAPIHandler(options.router);
  const spec = await new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] }).generate(
    contract,
    {
      info: {
        title: "rowrow API",
        version: options.version,
        description:
          "Everything the rowrow UI can see and do. Authenticate with `Authorization: Bearer <token>` (the local CLI's token is in <profile>/server.json). The `rowrow` CLI wraps all of it: `rowrow help`.",
      },
      servers: [{ url: "/api" }],
    },
  );

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: options.version }));

  app.get("/auth/redeem", (c) => {
    const code = c.req.query("code") ?? "";
    const redeemed = options.devices.redeem(code, c.req.header("user-agent"));
    if (redeemed === null) {
      return c.html(
        page(
          "This sign-in link doesn't work",
          "It was already used, or it expired (links last 10 minutes). Get a new one with <code>rowrow open</code>, or from <b>Pair a device</b> in rowrow on a device that is signed in.",
        ),
        400,
      );
    }
    setCookie(c, COOKIE, redeemed.token, {
      httpOnly: true,
      sameSite: "Lax",
      secure,
      path: "/",
      maxAge: 400 * 24 * 3600,
    });
    log.info("auth.login", { device: redeemed.device.id, name: redeemed.device.name });
    return c.redirect("/", 302);
  });

  app.post("/auth/logout", (c) => {
    const context = auth(getCookie(c, COOKIE), undefined);
    if (context !== null) options.devices.revoke(context.device.id);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.get("/api/openapi.json", (c) => c.json(spec));

  const bearer = (c: HonoContext): string | undefined => {
    const header = c.req.header("authorization");
    return header?.startsWith("Bearer ") === true
      ? header.slice("Bearer ".length).trim()
      : getCookie(c, COOKIE);
  };

  app.all("/rpc/*", async (c) => {
    const context = auth(bearer(c), c.req.header(AGENT_HEADER));
    if (context === null) return unauthorized(c);
    const { matched, response } = await httpRpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { ...context, ...traceOf(c.req.header(TRACE_HEADER)) },
    });
    return matched ? response : c.text("no such procedure\n", 404);
  });

  app.all("/api/*", async (c) => {
    const context = auth(bearer(c), c.req.header(AGENT_HEADER));
    if (context === null) return unauthorized(c);
    const { matched, response } = await openapi.handle(c.req.raw, {
      prefix: "/api",
      context: { ...context, ...traceOf(c.req.header(TRACE_HEADER)) },
    });
    return matched ? response : c.text("no such procedure: GET /api/openapi.json lists them\n", 404);
  });

  if (options.webDir !== undefined) app.get("*", (c) => serveWeb(c, options.webDir ?? ""));
  else
    app.get("/", (c) =>
      c.html(
        page(
          "rowrow is running",
          "The web app isn't built. Run <code>pnpm build</code>, or use <code>pnpm dev</code>.",
        ),
      ),
    );

  const handle = getRequestListener(app.fetch);
  const listener = (request: IncomingMessage, response: http.ServerResponse): void => {
    void handle(request, response);
  };
  const server = secure
    ? https.createServer(
        { cert: fs.readFileSync(options.tls?.cert ?? ""), key: fs.readFileSync(options.tls?.key ?? "") },
        listener,
      )
    : http.createServer(listener);

  // ─── WebSocket ─────────────────────────────────────────────────────────────
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: { threshold: 1024 },
    maxPayload: 16 * 1024 * 1024,
  });
  const wsRpc = new WsRPCHandler(options.router, {
    interceptors: [
      async (call) => {
        const trace = call.request.headers[TRACE_HEADER];
        return call.next({
          ...call,
          context: { ...call.context, ...traceOf(typeof trace === "string" ? trace : undefined) },
        });
      },
    ],
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const reject = (status: number, reason: string): void => {
      log.warn("ws.rejected", { status, reason, origin: request.headers.origin });
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    };
    if (url.pathname !== "/rpc") return reject(404, "Not Found");
    const origin = request.headers.origin;
    if (origin !== undefined && new URL(origin).host !== request.headers.host)
      return reject(403, "Forbidden");
    const cookies = parseCookies(request.headers.cookie);
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") === true ? header.slice(7) : cookies[COOKIE];
    const context = auth(token, undefined);
    if (context === null) return reject(401, "Unauthorized");
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connectionId = `conn_${randomBytes(5).toString("hex")}`;
      options.presence.open(connectionId, context.device.id, context.device.name);
      log.info("ws.open", {
        conn: connectionId,
        device: context.device.id,
        ua: request.headers["user-agent"],
      });
      ws.on("close", (code) => {
        options.presence.close(connectionId);
        log.info("ws.close", { conn: connectionId, device: context.device.id, code });
      });
      ws.on("error", (error) => log.warn("ws.error", { conn: connectionId, err: serializeError(error) }));
      void wsRpc.upgrade(ws, { context: { ...context, connectionId } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const hostForUrl = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `${secure ? "https" : "http"}://${hostForUrl}:${address.port}`;
  log.info("server.listening", { url });

  return {
    url,
    port: address.port,
    close: async () => {
      for (const client of wss.clients) client.close(1001, "server shutting down");
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function unauthorized(c: HonoContext): Response {
  return c.json(
    {
      code: "UNAUTHORIZED",
      message:
        "Sign in first. Browsers: open a login link (`rowrow open` or Pair a device). CLI: the token is in <profile>/server.json (`rowrow` reads it for you).",
    },
    401,
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function serveWeb(c: HonoContext, root: string): Response {
  const requested = decodeURIComponent(new URL(c.req.url).pathname);
  const file = path.resolve(root, `.${requested}`);
  const inside = file.startsWith(path.resolve(root) + path.sep);
  const target =
    inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root, "index.html");
  if (!fs.existsSync(target)) return c.text("web app not built\n", 404);
  const ext = path.extname(target);
  const immutable = requested.startsWith("/assets/");
  return new Response(fs.readFileSync(target), {
    headers: {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      ...(ext === ".html"
        ? {
            "content-security-policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          }
        : {}),
    },
  });
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · rowrow</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}code{background:#8882;padding:.1em .3em;border-radius:4px}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

export type { DeviceRecord };
