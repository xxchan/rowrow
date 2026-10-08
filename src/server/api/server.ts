// The server's front door (docs/architecture.md, "API" and "Auth and remote access"):
//
//   GET  /healthz             liveness, no auth
//   GET  /auth/redeem?code=…  one-time login link → session cookie → the app
//   POST /auth/token          the same link's code → a bearer token, for the iOS app (D-026)
//   POST /auth/logout         sign this browser out
//   GET  /kit.js              src/shared's folds for the iOS app to run (D-027), no auth: it's code
//   GET  /rpc  (Upgrade)      the WebSocket every browser uses (oRPC)
//   POST /rpc/*               the same procedures over HTTP (the typed CLI client, tests)
//   *    /api/*               the same procedures as OpenAPI routes (curl, agents); spec at /api/openapi.json
//   GET  /*                   the web app (when built), falling back to index.html; a signed-in
//                             browser gets its page and manifest under this server's name
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
import { createHash, randomBytes } from "node:crypto";
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
import type { CoachTokens } from "../coach/tokens.ts";
import type { Presence } from "../notify/presence.ts";
import { log, serializeError } from "../telemetry/log.ts";
import type { ApiContext, Router } from "./router.ts";

export const COOKIE = "rowrow_session";
/** Who Coach's reads come from, in the log: no device of yours. */
const COACH_DEVICE: DeviceRecord = { id: "coach", name: "Coach", kind: "cli" };
const TRACE_HEADER = "x-rowrow-trace";
const AGENT_HEADER = "x-rowrow-agent";

export interface HttpOptions {
  readonly router: Router;
  readonly devices: Devices;
  readonly presence: Presence;
  /** The credential rowrow hands to the agents it runs; requests with it act as an agent. */
  readonly agentDeviceId: string;
  /** The tokens of Coach's runs (D-044): the router lets them only read. */
  readonly coachTokens?: CoachTokens;
  readonly host: string;
  readonly port: number;
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly webDir?: string;
  /** The kit (dist/kit/kit.js), when built. */
  readonly kitFile?: string;
  /** What the app is called on this server ("rowrow · Work", settings.instanceName); null: rowrow. */
  readonly appName?: () => string | null;
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
    const coach = options.coachTokens?.authenticate(token) ?? null;
    if (coach !== null) return { device: COACH_DEVICE, actor: { kind: "system" }, coach };
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

  // The iOS app holds its credential like the CLI does, as a bearer token (in the Keychain):
  // it trades the same one-time code a browser would open for one.
  app.post("/auth/token", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "BAD_REQUEST", message: 'Send JSON: {"code": "…", "name": "…"}.' }, 400);
    }
    const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const code = typeof fields["code"] === "string" ? fields["code"] : "";
    const name =
      typeof fields["name"] === "string" && fields["name"].trim() !== ""
        ? fields["name"].trim().slice(0, 100)
        : undefined;
    const redeemed = options.devices.redeem(code, c.req.header("user-agent"), {
      kind: "app",
      ...(name === undefined ? {} : { name }),
    });
    if (redeemed === null)
      return c.json(
        {
          code: "INVALID_LINK",
          message:
            "This sign-in link was already used, or it expired (links last 10 minutes). Get a new one with `rowrow pair`, or from Pair a device on a device that is signed in.",
        },
        400,
      );
    log.info("auth.login", { device: redeemed.device.id, name: redeemed.device.name, kind: "app" });
    return c.json({ token: redeemed.token, device: { id: redeemed.device.id, name: redeemed.device.name } });
  });

  app.post("/auth/logout", (c) => {
    const context = auth(getCookie(c, COOKIE), undefined);
    if (context !== null) options.devices.revoke(context.device.id);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.get("/api/openapi.json", (c) => c.json(spec));

  app.get("/kit.js", (c) => serveKit(c, options.kitFile));

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

  if (options.webDir !== undefined) {
    const root = options.webDir;
    // Only a signed-in browser learns the server's name: the address alone doesn't tell it.
    const nameFor = (c: HonoContext) => (): string | null => {
      const name = options.appName?.() ?? null;
      return name === null || auth(getCookie(c, COOKIE), undefined) === null ? null : name;
    };
    app.get("*", (c) => serveWeb(c, root, nameFor(c)));
  } else
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
    // With the context kept across messages, even a few hundred bytes of JSON shrink about 13×
    // (a streaming answer's batches are that small); tinier ones aren't worth the work.
    perMessageDeflate: { threshold: 256 },
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

let kitCache: {
  readonly file: string;
  readonly mtimeMs: number;
  readonly body: Buffer;
  readonly etag: string;
} | null = null;

/** The kit, with an ETag so the app downloads it again only when it changed. */
function serveKit(c: HonoContext, file: string | undefined): Response {
  if (file === undefined || !fs.existsSync(file))
    return c.text("the kit isn't built: run `pnpm build` (or `pnpm dev`, which keeps it built)\n", 404);
  const { mtimeMs } = fs.statSync(file);
  if (kitCache?.file !== file || kitCache.mtimeMs !== mtimeMs) {
    const body = fs.readFileSync(file);
    const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
    kitCache = { file, mtimeMs, body, etag };
  }
  const headers = { etag: kitCache.etag, "cache-control": "no-cache" };
  if (c.req.header("if-none-match") === kitCache.etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(kitCache.body), {
    headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
  });
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

/**
 * A file of the built web app. The page and the manifest carry the app's name on this server
 * (roamgate #368): its title, the name iOS and Android give it on the Home Screen. `name` is
 * null when the server has none of its own or the browser isn't signed in: they're served as built.
 */
function serveWeb(c: HonoContext, root: string, name: () => string | null): Response {
  const requested = decodeURIComponent(new URL(c.req.url).pathname);
  const file = path.resolve(root, `.${requested}`);
  const inside = file.startsWith(path.resolve(root) + path.sep);
  const target =
    inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root, "index.html");
  if (!fs.existsSync(target)) return c.text("web app not built\n", 404);
  const ext = path.extname(target);
  const immutable = requested.startsWith("/assets/");
  const named =
    target === path.join(root, "index.html") || target === path.join(root, "manifest.webmanifest");
  const raw = fs.readFileSync(target);
  const appName = named ? name() : null;
  const body =
    appName === null
      ? raw
      : ext === ".html"
        ? namePage(raw.toString(), appName)
        : nameManifest(raw.toString(), appName);
  return new Response(body, {
    headers: {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": named
        ? "private, no-cache"
        : immutable
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      ...(ext === ".html"
        ? {
            "content-security-policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          }
        : {}),
    },
  });
}

function namePage(html: string, name: string): string {
  const text = escapeHtml(name);
  return html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${text}</title>`)
    .replace(
      /(<meta name="(?:apple-mobile-web-app-title|application-name)" content=")[^"]*"/g,
      (_, start: string) => `${start}${text}"`,
    );
}

function nameManifest(json: string, name: string): string {
  return JSON.stringify({ ...(JSON.parse(json) as object), name, short_name: name }, null, 2);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · rowrow</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}code{background:#8882;padding:.1em .3em;border-radius:4px}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

export type { DeviceRecord };
