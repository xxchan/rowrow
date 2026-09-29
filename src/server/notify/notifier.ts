// Turns attention changes into notifications (docs/architecture.md, "Attention and
// notifications"). An agent entering `blocked` or `done` is notified after a short delay,
// and only if it is still in that state and nobody is looking at it (no flapping, no noise
// about what's on your screen). Browsers show their own in-app toasts from AppState; this
// sends Web Push to devices that have no focused window.
import type { AgentSummary, Attention } from "../../shared/summary.ts";
import type { AgentService } from "../agents/service.ts";
import { log, serializeError } from "../telemetry/log.ts";
import type { Workspaces } from "../workspaces/service.ts";
import type { Presence } from "./presence.ts";
import type { Push } from "./push.ts";

const DELAY_MS = 1500;

export class Notifier {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private readonly agents: AgentService;
  private readonly workspaces: Workspaces;
  private readonly presence: Presence;
  private readonly push: Push;

  constructor(agents: AgentService, workspaces: Workspaces, presence: Presence, push: Push) {
    this.agents = agents;
    this.workspaces = workspaces;
    this.presence = presence;
    this.push = push;
    agents.onAttention((change) => {
      if (change.to === "blocked" || change.to === "done") this.schedule(change.agentId, change.to);
      else this.cancel(change.agentId);
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
    this.closed = true;
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
    const message = describe(
      agentId,
      agent.summary,
      expected,
      this.workspaces.get(agent.summary.workspaceId)?.label ?? null,
    );
    await this.push.send(message, (deviceId) => this.presence.deviceActive(deviceId));
  }
}

export function describe(
  agentId: string,
  summary: AgentSummary,
  attention: Attention,
  workspace: string | null,
): { title: string; body: string; url: string; tag: string } {
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
  const body = [workspace, detail.trim().replaceAll(/\s+/g, " ").slice(0, 180)]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
  return { title, body, url: `/a/${agentId}`, tag: agentId };
}
