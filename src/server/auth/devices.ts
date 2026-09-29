// Devices and their credentials (docs/decisions.md, D-009). A device is one signed-in
// browser, app or CLI. Its token is shown once and stored only as a SHA-256 hash. Browsers
// get one by opening a one-time login link; the iOS app trades the same link's code for a
// bearer token (D-026). The local CLI and the agents rowrow runs get tokens that rotate at
// every server start (written to server.json and the agents' env).
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { newId } from "../../shared/ids.ts";
import type { Device } from "../../shared/schemas.ts";
import type { Db } from "../store/db.ts";
import { log } from "../telemetry/log.ts";

export type DeviceKind = "browser" | "app" | "cli";

export interface DeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind;
}

interface Row {
  id: string;
  name: string;
  kind: DeviceKind;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const LINK_TTL_MS = 10 * 60_000;
/** Device names rowrow manages itself: rotated at every start, never listed for revocation by name. */
export const LOCAL_CLI = "local CLI";
export const AGENTS = "agents run by rowrow";

export class Devices {
  private readonly db: Db;
  private readonly seen = new Map<string, number>();

  constructor(db: Db) {
    this.db = db;
  }

  private mint(name: string, kind: DeviceKind): { device: DeviceRecord; token: string } {
    const token = `rr_${randomBytes(32).toString("base64url")}`;
    const device: DeviceRecord = { id: newId("dev"), name, kind };
    this.db.run(
      "insert into devices (id, name, kind, token_hash, created_at) values (?, ?, ?, ?, ?)",
      device.id,
      name,
      kind,
      hash(token),
      Date.now(),
    );
    log.info("auth.device.created", { device: device.id, kind, name });
    return { device, token };
  }

  /** Revoke the previous server's built-in credentials and mint fresh ones. */
  rotateBuiltins(): { cliToken: string; agentToken: string; agentDevice: DeviceRecord } {
    this.db.run(
      "update devices set revoked_at = ? where revoked_at is null and name in (?, ?)",
      Date.now(),
      LOCAL_CLI,
      AGENTS,
    );
    const cli = this.mint(LOCAL_CLI, "cli");
    const agents = this.mint(AGENTS, "cli");
    return { cliToken: cli.token, agentToken: agents.token, agentDevice: agents.device };
  }

  /** The device a token belongs to, or null (unknown or revoked). */
  authenticate(token: string | undefined): DeviceRecord | null {
    if (token === undefined || !token.startsWith("rr_")) return null;
    const row = this.db.get<Row>(
      "select * from devices where token_hash = ? and revoked_at is null",
      hash(token),
    );
    if (row === undefined) return null;
    const now = Date.now();
    if (now - (this.seen.get(row.id) ?? 0) > 60_000) {
      this.seen.set(row.id, now);
      this.db.run("update devices set last_seen_at = ? where id = ?", now, row.id);
    }
    return { id: row.id, name: row.name, kind: row.kind };
  }

  list(currentId: string | null, pushDevices: ReadonlySet<string>): Device[] {
    return this.db
      .all<Row>(
        "select * from devices where revoked_at is null and name not in (?, ?) order by created_at",
        LOCAL_CLI,
        AGENTS,
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        current: row.id === currentId,
        push: pushDevices.has(row.id),
      }));
  }

  get(id: string): DeviceRecord | null {
    const row = this.db.get<Row>("select * from devices where id = ? and revoked_at is null", id);
    return row === undefined ? null : { id: row.id, name: row.name, kind: row.kind };
  }

  rename(id: string, name: string): void {
    this.db.run("update devices set name = ? where id = ? and revoked_at is null", name, id);
  }

  revoke(id: string): void {
    this.db.run("update devices set revoked_at = ? where id = ? and revoked_at is null", Date.now(), id);
    this.db.run("delete from push_subscriptions where device_id = ?", id);
    this.db.run("delete from apns_tokens where device_id = ?", id);
    log.info("auth.device.revoked", { device: id });
  }

  /** A one-time code that signs one browser or app in. */
  createLoginCode(name?: string): { code: string; expiresAt: number } {
    const code = randomBytes(18).toString("base64url");
    const expiresAt = Date.now() + LINK_TTL_MS;
    this.db.run(
      "insert into login_links (code_hash, name, created_at, expires_at) values (?, ?, ?, ?)",
      hash(code),
      name ?? null,
      Date.now(),
      expiresAt,
    );
    this.db.run("delete from login_links where expires_at < ?", Date.now() - 24 * 3600_000);
    log.info("auth.link.created", { expiresAt });
    return { code, expiresAt };
  }

  /**
   * Redeem a login code: a new device (a browser, unless an app redeems it), or null when the
   * code is unknown, used or expired. The name given when the link was made wins over the
   * app's own and the browser's.
   */
  redeem(
    code: string,
    userAgent: string | undefined,
    as: { readonly kind: "browser" | "app"; readonly name?: string } = { kind: "browser" },
  ): { device: DeviceRecord; token: string } | null {
    const row = this.db.get<{ name: string | null; expires_at: number; used_at: number | null }>(
      "select name, expires_at, used_at from login_links where code_hash = ?",
      hash(code),
    );
    if (row === undefined || row.used_at !== null || row.expires_at < Date.now()) {
      log.warn("auth.link.rejected", {
        reason: row === undefined ? "unknown" : row.used_at === null ? "expired" : "used",
      });
      return null;
    }
    this.db.run("update login_links set used_at = ? where code_hash = ?", Date.now(), hash(code));
    return this.mint(row.name ?? as.name ?? describeBrowser(userAgent), as.kind);
  }
}

function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** "Safari on iPhone" from a user agent; good enough to tell your devices apart. */
export function describeBrowser(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const platform = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : os.hostname();
  return `${browser} on ${platform}`;
}
