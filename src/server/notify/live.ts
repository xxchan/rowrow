// Notifications for apps that stay connected (notify.watch; the Mac app, D-030). A desktop app
// can't take Web Push (Electron has no push service) and needs no APNs: it holds a stream while
// it runs, and shows what arrives as the system's own notifications. The Notifier decides what
// to say and when, exactly as for pushes; this only fans it out to the streams that are open.
import type { Notice } from "../../shared/schemas.ts";

type Alert = Extract<Notice, { kind: "alert" }>;

interface Watcher {
  readonly deviceId: string;
  readonly push: (notice: Notice) => void;
}

export class LiveNotices {
  private readonly watchers = new Set<Watcher>();

  /** Stream notices to one device until the returned function is called. */
  watch(deviceId: string, push: (notice: Notice) => void): () => void {
    const watcher: Watcher = { deviceId, push };
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  get connected(): boolean {
    return this.watchers.size > 0;
  }

  devices(): Set<string> {
    return new Set([...this.watchers].map((w) => w.deviceId));
  }

  /**
   * An alert for every watching device except those `active` says are looking (a focused
   * window shows its own toast): they get the new badge instead. Returns how many alerts went.
   */
  alert(alert: Alert, active: (deviceId: string) => boolean, only?: string): number {
    let sent = 0;
    for (const watcher of this.watchers) {
      if (only !== undefined && watcher.deviceId !== only) continue;
      if (active(watcher.deviceId)) watcher.push({ kind: "badge", badge: alert.badge });
      else {
        watcher.push(alert);
        sent += 1;
      }
    }
    return sent;
  }

  /** To every watching device. */
  broadcast(notice: Notice): void {
    for (const watcher of this.watchers) watcher.push(notice);
  }
}
