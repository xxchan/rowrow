// Turns attention changes into notifications (docs/architecture.md, "Attention and
// notifications"). An agent entering `blocked` or `done` is notified after a short delay,
// and only if it is still in that state and nobody is looking at it (no flapping, no noise
// about what's on your screen). Browsers show their own in-app toasts from AppState, and the
// iOS app its own banners; this sends Web Push, APNs and live notices (notify.watch, the Mac
// app) to devices that have no focused window. When agents stop needing you (you saw them, or
// answered), the apps' badges follow, and their notifications for them go away.
//
// Agents can also notify you themselves (notify.send, `rowrow notify`): see `send`. Coach's
// scheduled tasks (D-050) notify about their runs: see `taskNotice`.
import { taskUrl } from "../../shared/coach-tasks.ts";
import type { Actor, EntryOf } from "../../shared/entries.ts";
import type { AgentSummary, Attention } from "../../shared/summary.ts";
import type { AgentLog } from "../agents/log.ts";
import type { AgentService } from "../agents/service.ts";
import { UserError } from "../errors.ts";
import { log, serializeError, withContext } from "../telemetry/log.ts";
import type { Workspaces } from "../workspaces/service.ts";
import type { Apns } from "./apns.ts";
import type { LiveNotices } from "./live.ts";
import type { Presence } from "./presence.ts";
import type { Push } from "./push.ts";

const DELAY_MS = 1500;
/** Agents seen within this long of each other clear together. */
const SEEN_DELAY_MS = 2500;

/** How much an agent may notify you (notify.send), counted from its log. */
export const NOTICE_LIMITS = {
  /** At most one in this long… */
  burstMs: 10_000,
  /** …and this many an hour. */
  perHour: 30,
  /** A dedupKey is sent once in this long. */
  dedupMs: 24 * 3_600_000,
} as const;

export interface Notice {
  readonly title: string;
  /** "" for a title alone. */
  readonly body: string;
  readonly dedupKey?: string;
}

export interface NoticeResult {
  /** false: a notice with the same dedupKey went out within NOTICE_LIMITS.dedupMs (that one's seq). */
  readonly sent: boolean;
  readonly seq: number;
  readonly at: number;
}

export class Notifier {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private seenTimer: NodeJS.Timeout | null = null;
  private readonly seenAgents = new Set<string>();
  private closed = false;
  private readonly agents: AgentService;
  private readonly agentLog: AgentLog;
  private readonly workspaces: Workspaces;
  private readonly presence: Presence;
  private readonly push: Push;
  private readonly apns: Apns;
  private readonly live: LiveNotices;

  constructor(
    agents: AgentService,
    agentLog: AgentLog,
    workspaces: Workspaces,
    presence: Presence,
    push: Push,
    apns: Apns,
    live: LiveNotices,
  ) {
    this.agents = agents;
    this.agentLog = agentLog;
    this.workspaces = workspaces;
    this.presence = presence;
    this.push = push;
    this.apns = apns;
    this.live = live;
    agents.onAttention((change) => {
      if (change.to === "blocked" || change.to === "done") this.schedule(change.agentId, change.to);
      else {
        this.cancel(change.agentId);
        if (change.from === "blocked" || change.from === "done") this.clearLater(change.agentId);
      }
    });
  }

  private schedule(agentId: string, to: Attention): void {
    this.cancel(agentId);
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      void this.fire(agentId, to);
    }, DELAY_MS);
    timer.unref();
    this.timers.set(agentId, timer);
  }

  private cancel(agentId: string): void {
    clearTimeout(this.timers.get(agentId));
    this.timers.delete(agentId);
  }

  /** Stop pending notifications (server shutdown). */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.seenTimer !== null) clearTimeout(this.seenTimer);
    this.closed = true;
  }

  /** How many agents need you: the apps' badge. */
  needingYou(): number {
    return needingYou(this.agents, this.workspaces);
  }

  private async fire(agentId: string, expected: Attention): Promise<void> {
    if (this.closed) return;
    try {
      await this.deliver(agentId, expected);
    } catch (error) {
      log.error("notify.failed", { agent: agentId, err: serializeError(error) });
    }
  }

  private async deliver(agentId: string, expected: Attention): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent?.attention !== expected) return;
    if (this.presence.isWatching(agentId)) {
      log.debug("notify.skipped", { agent: agentId, reason: "watched" });
      return;
    }
    const workspace = this.workspaces.get(agent.summary.workspaceId)?.label ?? null;
    const words = wordsFor(agent.summary, expected);
    const active = (deviceId: string): boolean => this.presence.deviceActive(deviceId);
    const badge = this.needingYou();
    this.live.alert(
      {
        kind: "alert",
        agentId,
        attention: expected === "blocked" ? "blocked" : "done",
        title: words.title,
        subtitle: workspace,
        body: words.detail,
        url: `/a/${agentId}`,
        seq: agent.summary.headSeq,
        badge,
      },
      active,
    );
    await Promise.all([
      this.push.send(describe(agentId, agent.summary, expected, workspace), active),
      this.apns.alert(
        {
          title: words.title,
          ...(workspace === null ? {} : { subtitle: workspace }),
          body: words.detail === "" ? "Open it to see what happened." : words.detail,
          generic: expected === "blocked" ? "An agent needs you." : "An agent finished.",
          thread: agentId,
          category: "AGENT",
          badge,
          relevance: expected === "blocked" ? 1 : 0.6,
          // seq: what Mark as Seen marks, straight from the notification.
          data: { agentId, attention: expected, seq: agent.summary.headSeq },
        },
        active,
      ),
    ]);
  }

  /**
   * A notification from an agent (or about it), in its own words: logged in its transcript,
   * then sent whether or not anyone is looking at that agent, since it asked to tell you.
   * Browsers toast it from AppState (summary.lastNotification), so a device with a focused
   * window gets no Web Push or Mac alert (it would say it twice). The iOS app gets it through
   * APNs either way: it has no in-app path for it, and shows it unless that agent is on screen.
   * Dedup and limits count the agent's log, so they hold across restarts.
   */
  send(agentId: string, notice: Notice, by: Actor): NoticeResult {
    return withContext({ agent: agentId }, () => {
      this.agents.summary(agentId); // NOT_FOUND for an agent that isn't there
      const now = Date.now();
      const recent = this.agentLog.recent(agentId, "notification.sent", now - NOTICE_LIMITS.dedupMs);
      const same =
        notice.dedupKey === undefined ? undefined : recent.findLast((e) => e.dedupKey === notice.dedupKey);
      if (same !== undefined) {
        log.info("notify.notice_duplicate", { key: notice.dedupKey, seq: same.seq });
        return { sent: false, seq: same.seq, at: same.at };
      }
      const sentAt = recent.map((e) => e.at);
      const limited = noticeLimit(sentAt, now);
      if (limited !== null) {
        log.warn("notify.notice_limited", { msg: limited });
        throw new UserError(limited, "TOO_MANY_REQUESTS");
      }
      const entry = this.agentLog.append(agentId, {
        kind: "notification.sent",
        title: notice.title,
        body: notice.body,
        ...(notice.dedupKey === undefined ? {} : { dedupKey: notice.dedupKey }),
        by,
      }) as EntryOf<"notification.sent">;
      void this.deliverNotice(agentId, entry).catch((error: unknown) =>
        log.error("notify.notice_failed", { seq: entry.seq, err: serializeError(error) }),
      );
      return { sent: true, seq: entry.seq, at: entry.at };
    });
  }

  private async deliverNotice(agentId: string, entry: EntryOf<"notification.sent">): Promise<void> {
    if (this.closed) return;
    const name = this.agents.summary(agentId).title ?? "Agent";
    const url = `/a/${agentId}`;
    const active = (deviceId: string): boolean => this.presence.deviceActive(deviceId);
    const badge = this.needingYou();
    // Its own notification: it replaces neither the agent's "finished" nor an earlier notice.
    const tag = `${agentId}:notice:${entry.seq}`;
    const live = this.live.alert(
      {
        kind: "alert",
        agentId,
        attention: "notice",
        title: entry.title,
        subtitle: name,
        body: entry.body,
        url,
        seq: entry.seq,
        badge,
      },
      active,
    );
    const [web, app] = await Promise.all([
      this.push.send(
        { title: entry.title, body: [name, entry.body].filter((part) => part !== "").join(" · "), url, tag },
        active,
      ),
      this.apns.alert({
        title: entry.title,
        subtitle: name,
        body: entry.body,
        generic: "An agent notified you.",
        thread: agentId,
        collapse: tag,
        category: "AGENT",
        badge,
        relevance: 0.8,
        // notice: the app keeps it when it tidies away notifications for agents that don't need you.
        data: { agentId, notice: true, seq: entry.seq },
      }),
    ]);
    log.info("notify.notice_sent", { agent: agentId, seq: entry.seq, live, web, app });
  }

  /**
   * A notification about a Coach task's run (D-050): it opens Coach on that task and run.
   * Browsers with a focused window show it from AppState (coach.tasks' lastNotice), so they get
   * no Web Push or Mac alert; the iOS app gets it through APNs either way, like an agent's notice.
   */
  async taskNotice(notice: { taskId: string; runId: string; title: string; body: string }): Promise<void> {
    if (this.closed) return;
    const url = taskUrl(notice.taskId, notice.runId);
    const tag = `coach-task:${notice.taskId}:${notice.runId}`;
    const active = (deviceId: string): boolean => this.presence.deviceActive(deviceId);
    const badge = this.needingYou();
    const live = this.live.alert(
      {
        kind: "alert",
        agentId: "",
        attention: "notice",
        title: notice.title,
        subtitle: "Coach",
        body: notice.body,
        url,
        seq: -1,
        badge,
      },
      active,
    );
    const [web, app] = await Promise.all([
      this.push.send({ title: notice.title, body: `Coach · ${notice.body}`, url, tag }, active),
      this.apns.alert({
        title: notice.title,
        subtitle: "Coach",
        body: notice.body,
        generic: "A Coach task notified you.",
        thread: `coach-task:${notice.taskId}`,
        collapse: tag,
        badge,
        relevance: 0.8,
        data: { coachTask: notice.taskId, coachRun: notice.runId, url },
      }),
    ]);
    log.info("notify.task_notice_sent", { task: notice.taskId, run: notice.runId, live, web, app });
  }

  private clearLater(agentId: string): void {
    if ((!this.apns.configured && !this.live.connected) || this.closed) return;
    this.seenAgents.add(agentId);
    if (this.seenTimer !== null) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      const ids = [...this.seenAgents];
      this.seenAgents.clear();
      if (this.closed) return;
      const badge = this.needingYou();
      this.live.broadcast({ kind: "seen", agentIds: ids, badge });
      if (!this.apns.configured) return;
      this.apns
        .seen(ids, badge)
        .catch((error: unknown) => log.warn("notify.seen_failed", { err: serializeError(error) }));
    }, SEEN_DELAY_MS);
    this.seenTimer.unref();
  }
}

/**
 * Why one more notice from an agent now would be too many (NOTICE_LIMITS), given when its
 * earlier ones went out (oldest first), or null when it may send one.
 */
export function noticeLimit(sentAt: readonly number[], now: number): string | null {
  const last = sentAt.at(-1);
  if (last !== undefined && now - last < NOTICE_LIMITS.burstMs)
    return `Too many notifications: this agent sent one ${wait(now - last)} ago, and may send one every ${wait(NOTICE_LIMITS.burstMs)}. Try again in ${wait(last + NOTICE_LIMITS.burstMs - now)}.`;
  const hour = sentAt.filter((at) => at > now - 3_600_000);
  if (hour.length < NOTICE_LIMITS.perHour) return null;
  const free = (hour[hour.length - NOTICE_LIMITS.perHour] ?? now) + 3_600_000;
  return `Too many notifications: this agent sent ${hour.length} in the last hour, the most it may. Try again in ${wait(free - now)}.`;
}

function wait(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.ceil(ms / 1000))} s` : `${Math.ceil(ms / 60_000)} min`;
}

/** Agents that need you (blocked, or done and not seen), archived ones and archived workspaces' aside. */
export function needingYou(agents: AgentService, workspaces: Workspaces): number {
  return agents
    .list()
    .filter(
      (a) =>
        !a.summary.archived &&
        !workspaces.archived(a.summary.workspaceId) &&
        (a.attention === "blocked" || a.attention === "done"),
    ).length;
}

/** What happened, in a title and a line: "X finished" and the tail of what it said. */
function wordsFor(summary: AgentSummary, attention: Attention): { title: string; detail: string } {
  const name = summary.title ?? "Agent";
  const failed =
    summary.lastTurn?.outcome.kind === "failed" || (summary.lastError !== null && summary.run === null);
  const title =
    attention === "blocked" ? `${name} needs you` : failed ? `${name} failed` : `${name} finished`;
  const detail =
    attention === "blocked"
      ? "It is waiting for an answer."
      : failed
        ? (summary.lastError ?? "")
        : (summary.preview ?? "");
  const line = detail.trim().replaceAll(/\s+/g, " ").slice(0, 180);
  // A failed turn pauses what you queued after it (D-035): say so, or it looks sent.
  const held = summary.queuePaused === null ? 0 : summary.queued.length;
  const paused = held === 0 ? "" : `${held} queued ${held === 1 ? "message is" : "messages are"} paused`;
  return { title, detail: [line, paused].filter((part) => part !== "").join(" · ") };
}

export function describe(
  agentId: string,
  summary: AgentSummary,
  attention: Attention,
  workspace: string | null,
): { title: string; body: string; url: string; tag: string } {
  const { title, detail } = wordsFor(summary, attention);
  const body = [workspace, detail].filter((part) => part !== null && part !== "").join(" · ");
  return { title, body, url: `/a/${agentId}`, tag: agentId };
}
