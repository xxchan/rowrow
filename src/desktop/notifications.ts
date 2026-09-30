// What notify.watch says, as macOS notifications (docs/desktop.md). The server decides what to
// say and when (after a short delay, never about what a focused window shows): this only shows
// it. One notification per agent (a newer one replaces it), with Reply and Mark as Seen, like
// the iOS app's; when you see the agent anywhere, its notification goes.
import { Notification } from "electron";
import type { Notice } from "../shared/schemas.ts";
import type { Logger } from "./log.ts";

type Alert = Extract<Notice, { kind: "alert" }>;

export interface NotificationActions {
  open(serverId: string, url: string): void;
  reply(serverId: string, agentId: string, text: string): Promise<void>;
  markSeen(serverId: string, agentId: string, seq: number): Promise<void>;
}

export class Notifications {
  private readonly shown = new Map<string, Notification>();
  private readonly actions: NotificationActions;
  private readonly log: Logger;

  constructor(actions: NotificationActions, log: Logger) {
    this.actions = actions;
    this.log = log;
  }

  /** `serverName` goes in the subtitle when there are several servers. */
  notice(serverId: string, serverName: string | null, notice: Notice): void {
    if (notice.kind === "alert") this.alert(serverId, serverName, notice);
    else if (notice.kind === "seen") for (const agentId of notice.agentIds) this.close(serverId, agentId);
  }

  private close(serverId: string, agentId: string): void {
    const key = `${serverId}:${agentId}`;
    this.shown.get(key)?.close();
    this.shown.delete(key);
  }

  private alert(serverId: string, serverName: string | null, alert: Alert): void {
    if (!Notification.isSupported()) return;
    const about = alert.agentId !== "";
    this.close(serverId, alert.agentId);
    const subtitle = [serverName, alert.subtitle].filter((part) => part !== null && part !== "").join(" · ");
    const notification = new Notification({
      title: alert.title,
      ...(subtitle === "" ? {} : { subtitle }),
      body: alert.body === "" ? "Open it to see what happened." : alert.body,
      ...(about
        ? {
            hasReply: true,
            replyPlaceholder: "Reply",
            actions: [{ type: "button" as const, text: "Mark as Seen" }],
          }
        : {}),
    });
    const key = `${serverId}:${alert.agentId}`;
    notification.on("click", () => {
      this.shown.delete(key);
      this.actions.open(serverId, alert.url);
    });
    notification.on("reply", (details) => {
      this.shown.delete(key);
      this.actions.reply(serverId, alert.agentId, details.reply).catch((error: unknown) =>
        this.log.error("desktop.notification.reply_failed", {
          server: serverId,
          agent: alert.agentId,
          err: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    notification.on("action", (details) => {
      if (details.actionIndex !== 0) return;
      this.shown.delete(key);
      void this.actions.markSeen(serverId, alert.agentId, alert.seq).catch(() => undefined);
    });
    notification.on("close", () => {
      if (this.shown.get(key) === notification) this.shown.delete(key);
    });
    // Held until it's dealt with: a notification that's collected stops sending its events.
    this.shown.set(key, notification);
    notification.show();
    this.log.info("desktop.notification.shown", {
      server: serverId,
      agent: alert.agentId,
      attention: alert.attention,
    });
  }

  clearServer(serverId: string): void {
    for (const [key, notification] of this.shown)
      if (key.startsWith(`${serverId}:`)) {
        notification.close();
        this.shown.delete(key);
      }
  }
}
