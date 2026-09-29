// Web Push (docs/architecture.md, "Attention and notifications"). The server has its own
// VAPID key pair (generated once per profile, mode 0600) and sends straight to each
// browser's push service: no relay of ours in between. A subscription the push service
// says is gone (404/410) is deleted.
import fs from "node:fs";
import webpush from "web-push";
import type { Db } from "../store/db.ts";
import { log, serializeError } from "../telemetry/log.ts";

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Opened when the notification is clicked. */
  readonly url: string;
  /** Replaces an earlier notification with the same tag (one per agent). */
  readonly tag: string;
}

interface Row {
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class Push {
  readonly publicKey: string;
  private readonly db: Db;
  private readonly privateKey: string;

  constructor(db: Db, vapidFile: string) {
    this.db = db;
    let keys: { publicKey: string; privateKey: string };
    if (fs.existsSync(vapidFile)) {
      keys = JSON.parse(fs.readFileSync(vapidFile, "utf8")) as { publicKey: string; privateKey: string };
    } else {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(vapidFile, JSON.stringify(keys), { mode: 0o600 });
      log.info("push.keys_created", { file: vapidFile });
    }
    this.publicKey = keys.publicKey;
    this.privateKey = keys.privateKey;
  }

  subscribe(
    deviceId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): void {
    this.db.run(
      "insert into push_subscriptions (device_id, endpoint, p256dh, auth, created_at) values (?, ?, ?, ?, ?) on conflict(device_id) do update set endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth",
      deviceId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      Date.now(),
    );
    log.info("push.subscribed", { device: deviceId, service: new URL(subscription.endpoint).host });
  }

  unsubscribe(deviceId: string): void {
    this.db.run("delete from push_subscriptions where device_id = ?", deviceId);
  }

  subscribedDevices(): Set<string> {
    return new Set(
      this.db
        .all<{ device_id: string }>("select device_id from push_subscriptions")
        .map((row) => row.device_id),
    );
  }

  /** Send to every subscribed device except those `skip` says are already looking. Returns how many were sent. */
  async send(
    message: PushMessage,
    skip: (deviceId: string) => boolean = () => false,
    only?: string,
  ): Promise<number> {
    const rows = this.db.all<Row>("select * from push_subscriptions");
    let sent = 0;
    await Promise.all(
      rows
        .filter((row) => (only === undefined || row.device_id === only) && !skip(row.device_id))
        .map(async (row) => {
          try {
            await webpush.sendNotification(
              { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
              JSON.stringify(message),
              {
                vapidDetails: {
                  subject: "mailto:rowrow@users.noreply.github.com",
                  publicKey: this.publicKey,
                  privateKey: this.privateKey,
                },
                TTL: 3600,
                urgency: "high",
                topic: message.tag.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
              },
            );
            sent += 1;
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              this.unsubscribe(row.device_id);
              log.info("push.subscription_gone", { device: row.device_id, status });
            } else {
              log.warn("push.send_failed", { device: row.device_id, status, err: serializeError(error) });
            }
          }
        }),
    );
    if (sent > 0) log.info("push.sent", { tag: message.tag, sent });
    return sent;
  }
}
