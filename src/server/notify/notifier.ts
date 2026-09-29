// Turns attention changes into notifications (docs/architecture.md, "Attention and
// notifications"). An agent entering `blocked` or `done` is notified after a short delay,
// and only if it is still in that state and nobody is looking at it (no flapping, no noise
// about what's on your screen). Browsers show their own in-app toasts from AppState, and the
// iOS app its own banners; this sends Web Push and APNs to devices that have no focused
// window. When agents stop needing you (you saw them, or answered), the iOS app's badge
// follows, and its notifications for them go away.
import type { AgentSummary, Attention } from "../../shared/summary.ts";
import type { AgentService } from "../agents/service.ts";
import { log, serializeError } from "../telemetry/log.ts";
import type { Workspaces } from "../workspaces/service.ts";
import type { Apns } from "./apns.ts";
import type { Presence } from "./presence.ts";
import type { Push } from "./push.ts";

const DELAY_MS = 1500;
/** Agents seen within this long of each other clear together. */
const SEEN_DELAY_MS = 2500;

export class Notifier {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private seenTimer: NodeJS.Timeout | null = null;
  private readonly seenAgents = new Set<string>();
  private closed = false;
  private readonly agents: AgentService;
  private readonly workspaces: Workspaces;
  private readonly presence: Presence;
  private readonly push: Push;
  private readonly apns: Apns;

  constructor(agents: AgentService, workspaces: Workspaces, presence: Presence, push: Push, apns: Apns) {
    this.agents = agents;
    this.workspaces = workspaces;
    this.presence = presence;
    this.push = push;
    this.apns = apns;
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

  /** How many agents need you: the iOS app's badge. */
  private needingYou(): number {
    return this.agents
      .list()
      .filter((a) => !a.summary.archived && (a.attention === "blocked" || a.attention === "done")).length;
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
          badge: this.needingYou(),
          relevance: expected === "blocked" ? 1 : 0.6,
          // seq: what Mark as Seen marks, straight from the notification.
          data: { agentId, attention: expected, seq: agent.summary.headSeq },
        },
        active,
      ),
    ]);
  }

  private clearLater(agentId: string): void {
    if (!this.apns.configured || this.closed) return;
    this.seenAgents.add(agentId);
    if (this.seenTimer !== null) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      const ids = [...this.seenAgents];
      this.seenAgents.clear();
      if (this.closed) return;
      this.apns
        .seen(ids, this.needingYou())
        .catch((error: unknown) => log.warn("notify.seen_failed", { err: serializeError(error) }));
    }, SEEN_DELAY_MS);
    this.seenTimer.unref();
  }
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
  return { title, detail: detail.trim().replaceAll(/\s+/g, " ").slice(0, 180) };
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
