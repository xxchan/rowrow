// Words and colors for states, shared by every screen so an agent reads the same
// everywhere (docs/architecture.md, "Attention and notifications").
import type { StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { classifyTool, toolActionLabel } from "@botiverse/oar/observe";
import type { AgentState } from "../../shared/schemas.ts";
import { stalledFor, type AgentSummary } from "../../shared/summary.ts";

export const STALL_MS = 3 * 60_000;

/** The latest thing worth your attention was a failure (a failed turn, a run that died or never started). */
export function failed(summary: AgentSummary): boolean {
  if (summary.lastCompletionSeq < 0) return false;
  return summary.lastTurn?.seq === summary.lastCompletionSeq
    ? summary.lastTurn.outcome.kind === "failed"
    : summary.lastError !== null;
}

export function statusDot(
  agent: AgentState,
  now = Date.now(),
): { variant: StatusDotVariant; label: string; pulsing: boolean } {
  const { summary } = agent;
  switch (agent.attention) {
    case "blocked":
      return { variant: "error", label: "Needs you", pulsing: true };
    case "done":
      return failed(summary)
        ? { variant: "error", label: "Failed", pulsing: false }
        : { variant: "success", label: "Finished", pulsing: false };
    case "working":
      return stalledFor(summary, now, STALL_MS) === null
        ? { variant: "accent", label: phaseLabel(summary), pulsing: true }
        : {
            variant: "warning",
            label: `Silent for ${duration(now - (summary.status.kind === "running" ? summary.status.lastEventAt : now))}`,
            pulsing: false,
          };
    case "idle":
      return { variant: "neutral", label: summary.run === null ? "Idle" : "Idle (live)", pulsing: false };
  }
}

export function phaseLabel(summary: AgentSummary): string {
  if (summary.status.kind !== "running") return "Idle";
  const { phase } = summary.status;
  if (typeof phase !== "string")
    return toolActionLabel(classifyTool(summary.runtime, phase.tool).kind, "running");
  switch (phase) {
    case "waiting_model":
      return "Waiting for the model";
    case "thinking":
      return "Thinking";
    case "responding":
      return "Writing";
    case "compacting":
      return "Compacting context";
  }
}

export function title(agent: AgentState): string {
  return agent.summary.title ?? "Untitled agent";
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
