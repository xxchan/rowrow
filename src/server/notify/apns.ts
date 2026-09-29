// Push to the iOS app through Apple's push service (docs/decisions.md, D-028). Like Web Push
// (push.ts), the server sends straight to Apple: no relay of ours in between. Apple accepts a
// push for an app only from its developer, so the server signs with your own APNs key (a .p8
// from developer.apple.com), which `rowrow push apns` or notify.configureApns stores in the
// profile (apns.json, mode 0600). The app registers the token iOS gave it, with its bundle id
// (the topic), Apple's environment (sandbox for builds from Xcode) and a key of its own.
//
// Apple reads nothing but "rowrow: an agent finished" (PRINCIPLES.md, product 7): what the
// notification says (the agent, the workspace, the tail of what it wrote) is encrypted with
// the device's key (AES-256-GCM), and the app's notification service extension decrypts it
// on the phone. That is what Web Push gives browsers (RFC 8291), for the app.
//
// One HTTP/2 connection per environment, reused; the provider token (an ES256 JWT) is
// renewed every 50 minutes, as Apple asks. A token Apple says is gone is deleted.
import { createCipheriv, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import { UserError } from "../errors.ts";
import type { Db } from "../store/db.ts";
import { log, serializeError } from "../telemetry/log.ts";

export type ApnsEnvironment = "sandbox" | "production";

const ORIGINS: Readonly<Record<ApnsEnvironment, string>> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
const TOKEN_TTL_S = 50 * 60;
const TIMEOUT_MS = 15_000;
/** An idle connection is closed after this long; the next push opens a new one. */
const IDLE_MS = 10 * 60_000;

export interface ApnsKey {
  /** The .p8 file's contents: a PEM "PRIVATE KEY" (EC P-256). */
  readonly key: string;
  /** The key's id, 10 characters (developer.apple.com → Keys). */
  readonly keyId: string;
  /** The team that owns the key and the app, 10 characters. */
  readonly teamId: string;
}

export interface ApnsAlert {
  /** What the notification says. Encrypted for the device: Apple sees `generic` instead. */
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  /** What Apple (and a phone that can't decrypt) sees: no names, no content. */
  readonly generic: string;
  /** One notification per thread: the agent. A newer one replaces the older (apns-collapse-id). */
  readonly thread: string;
  /** The app's actions for it (UNNotificationCategory), e.g. AGENT: reply, mark as seen. */
  readonly category?: string;
  /** The Home Screen badge: how many agents need you. */
  readonly badge?: number;
  /** How the notification summary ranks it (0…1). */
  readonly relevance?: number;
  /** Anything else the app needs to act on it (agentId…). */
  readonly data?: Readonly<Record<string, unknown>>;
}

interface Row {
  device_id: string;
  token: string;
  environment: ApnsEnvironment;
  topic: string;
  /** The device's AES-256 key, base64: what its notifications say is encrypted with it. */
  key: string | null;
}

interface Sendable {
  readonly type: "alert" | "background";
  readonly priority: 5 | 10;
  /** The payload for one device (an alert's words are encrypted for each). */
  readonly payload: (row: Row) => Readonly<Record<string, unknown>>;
  readonly collapseId?: string;
}

/** AES-256-GCM as CryptoKit's AES.GCM.SealedBox(combined:) reads it: nonce (12) ‖ ciphertext ‖ tag (16), base64. */
export function sealFor(key: string, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString("base64");
}

export class Apns {
  private readonly db: Db;
  private readonly file: string;
  private readonly origins: Readonly<Record<ApnsEnvironment, string>>;
  private key: (ApnsKey & { readonly object: KeyObject }) | null = null;
  private jwt: { readonly token: string; readonly issuedAt: number } | null = null;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  /** Told when the key is set or removed (the app state says whether push to the app works). */
  onChange: () => void = () => undefined;

  /** `origin` sends every push there instead of Apple (tests: a local HTTP/2 server). */
  constructor(db: Db, file: string, origin?: string) {
    this.db = db;
    this.file = file;
    this.origins = origin === undefined ? ORIGINS : { sandbox: origin, production: origin };
    if (fs.existsSync(file)) {
      try {
        this.key = load(JSON.parse(fs.readFileSync(file, "utf8")) as ApnsKey);
      } catch (error) {
        log.error("apns.key_unreadable", { file, err: serializeError(error) });
      }
    }
  }

  get configured(): boolean {
    return this.key !== null;
  }

  describe(): { keyId: string; teamId: string } | null {
    return this.key === null ? null : { keyId: this.key.keyId, teamId: this.key.teamId };
  }

  /** Store the key (checked first: it must be an EC P-256 private key that can sign). */
  configure(input: ApnsKey): void {
    const next = load(input);
    fs.writeFileSync(
      this.file,
      JSON.stringify({ key: input.key.trim(), keyId: next.keyId, teamId: next.teamId }),
      { mode: 0o600 },
    );
    this.key = next;
    this.jwt = null;
    log.info("apns.configured", { keyId: next.keyId, teamId: next.teamId });
    this.onChange();
  }

  remove(): void {
    fs.rmSync(this.file, { force: true });
    this.key = null;
    this.jwt = null;
    this.closeSessions();
    log.info("apns.removed", {});
    this.onChange();
  }

  register(
    deviceId: string,
    device: { token: string; environment: ApnsEnvironment; topic: string; key: string },
  ): void {
    this.db.run(
      "insert into apns_tokens (device_id, token, environment, topic, key, created_at) values (?, ?, ?, ?, ?, ?) on conflict(device_id) do update set token = excluded.token, environment = excluded.environment, topic = excluded.topic, key = excluded.key",
      deviceId,
      device.token.toLowerCase(),
      device.environment,
      device.topic,
      device.key,
      Date.now(),
    );
    log.info("apns.registered", { device: deviceId, environment: device.environment, topic: device.topic });
  }

  unregister(deviceId: string): void {
    this.db.run("delete from apns_tokens where device_id = ?", deviceId);
  }

  registeredDevices(): Set<string> {
    return new Set(
      this.db.all<{ device_id: string }>("select device_id from apns_tokens").map((row) => row.device_id),
    );
  }

  /**
   * An alert to every registered device but those `skip` names (or only to `only`). Apple
   * gets the generic words; the real ones go encrypted in `e`, for the app's notification
   * service extension to show. Returns how many Apple took.
   */
  async alert(
    message: ApnsAlert,
    skip: (deviceId: string) => boolean = () => false,
    only?: string,
  ): Promise<number> {
    const words = JSON.stringify({
      title: message.title,
      ...(message.subtitle === undefined ? {} : { subtitle: message.subtitle }),
      body: message.body,
    });
    const payload = (row: Row): Record<string, unknown> => ({
      aps: {
        alert: { title: "rowrow", body: message.generic },
        sound: "default",
        "thread-id": message.thread,
        ...(row.key === null ? {} : { "mutable-content": 1 }),
        ...(message.category === undefined ? {} : { category: message.category }),
        ...(message.badge === undefined ? {} : { badge: message.badge }),
        ...(message.relevance === undefined ? {} : { "relevance-score": message.relevance }),
      },
      ...(row.key === null ? {} : { e: sealFor(row.key, words) }),
      ...message.data,
    });
    return this.broadcast({ type: "alert", priority: 10, payload, collapseId: message.thread }, skip, only);
  }

  /**
   * Quietly bring every device up to date after agents were seen elsewhere: the badge, then a
   * background push that lets the app take those agents' notifications away.
   */
  async seen(agentIds: readonly string[], badge: number): Promise<void> {
    await this.broadcast({ type: "alert", priority: 5, payload: () => ({ aps: { badge } }) });
    await this.broadcast({
      type: "background",
      priority: 5,
      payload: () => ({ aps: { "content-available": 1 }, seen: agentIds }),
    });
  }

  private async broadcast(
    push: Sendable,
    skip: (deviceId: string) => boolean = () => false,
    only?: string,
  ): Promise<number> {
    if (this.key === null) return 0;
    const rows = this.db
      .all<Row>("select * from apns_tokens")
      .filter((row) => (only === undefined || row.device_id === only) && !skip(row.device_id));
    const results = await Promise.all(rows.map(async (row) => this.deliver(row, push)));
    const sent = results.filter(Boolean).length;
    if (sent > 0) log.info("apns.sent", { type: push.type, sent });
    return sent;
  }

  private async deliver(row: Row, push: Sendable): Promise<boolean> {
    try {
      const { status, reason } = await this.request(row, push);
      if (status === 200) return true;
      if (status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") {
        this.unregister(row.device_id);
        log.info("apns.token_gone", { device: row.device_id, status, reason });
      } else if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") {
        this.jwt = null;
        log.error("apns.key_rejected", { status, reason, keyId: this.key?.keyId, teamId: this.key?.teamId });
      } else {
        log.warn("apns.send_failed", { device: row.device_id, status, reason });
      }
    } catch (error) {
      log.warn("apns.send_failed", { device: row.device_id, err: serializeError(error) });
    }
    return false;
  }

  private request(row: Row, push: Sendable): Promise<{ status: number; reason: string | undefined }> {
    const session = this.session(this.origins[row.environment]);
    return new Promise((resolve, reject) => {
      const stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${row.token}`,
        authorization: `bearer ${this.providerToken()}`,
        "apns-topic": row.topic,
        "apns-push-type": push.type,
        "apns-priority": String(push.priority),
        "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
        ...(push.collapseId === undefined ? {} : { "apns-collapse-id": push.collapseId.slice(0, 64) }),
        "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      stream.setEncoding("utf8");
      stream.on("response", (headers) => {
        status = headers[":status"] ?? 0;
      });
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => {
        let reason: string | undefined;
        try {
          reason = body === "" ? undefined : (JSON.parse(body) as { reason?: string }).reason;
        } catch {
          reason = body.slice(0, 200);
        }
        resolve({ status, reason });
      });
      stream.on("error", reject);
      stream.setTimeout(TIMEOUT_MS, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error(`APNs did not answer in ${TIMEOUT_MS / 1000} s`));
      });
      // Which device it's for: an app paired with several servers finds the one that sent it.
      stream.end(JSON.stringify({ ...push.payload(row), deviceId: row.device_id }));
    });
  }

  private session(origin: string): http2.ClientHttp2Session {
    const open = this.sessions.get(origin);
    if (open !== undefined && !open.closed && !open.destroyed) return open;
    const session = http2.connect(origin);
    const forget = (): void => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on("error", (error) => {
      log.warn("apns.connection_error", { origin, err: serializeError(error) });
      forget();
    });
    session.on("goaway", forget);
    session.on("close", forget);
    session.setTimeout(IDLE_MS, () => session.close());
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  private providerToken(): string {
    const key = this.key;
    if (key === null) throw new Error("no APNs key");
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt !== null && now - this.jwt.issuedAt < TOKEN_TTL_S) return this.jwt.token;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: key.keyId })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: key.teamId, iat: now })).toString("base64url");
    const input = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(input), { key: key.object, dsaEncoding: "ieee-p1363" });
    const token = `${input}.${signature.toString("base64url")}`;
    this.jwt = { token, issuedAt: now };
    return token;
  }

  private closeSessions(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  close(): void {
    this.closeSessions();
  }
}

function load(input: ApnsKey): ApnsKey & { readonly object: KeyObject } {
  const keyId = input.keyId.trim();
  const teamId = input.teamId.trim();
  if (!/^[A-Z0-9]{10}$/.test(keyId))
    throw new UserError(`The key id should be 10 letters and digits, like ABC123DEFG (got "${keyId}").`);
  if (!/^[A-Z0-9]{10}$/.test(teamId))
    throw new UserError(`The team id should be 10 letters and digits, like DEF123GHIJ (got "${teamId}").`);
  let object: KeyObject;
  try {
    object = createPrivateKey(input.key.trim());
  } catch {
    throw new UserError(
      "That isn't a private key: pass the contents of the AuthKey_XXXXXXXXXX.p8 file Apple gave you.",
    );
  }
  if (object.asymmetricKeyType !== "ec" || object.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new UserError("An APNs key is an EC P-256 key (a .p8 from developer.apple.com → Keys).");
  return { key: input.key.trim(), keyId, teamId, object };
}
