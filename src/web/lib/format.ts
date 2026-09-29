// Words and colors for states, shared by every screen so an agent reads the same
// everywhere (docs/architecture.md, "Attention and notifications").
import { classifyTool, toolActionLabel } from "@botiverse/oar/observe";
import type { AgentState } from "../../shared/schemas.ts";
import { stalledFor, type AgentSummary } from "../../shared/summary.ts";

export const STALL_MS = 3 * 60_000;

/** The color family of a state: the same everywhere a state is shown. */
export type Tone = "error" | "success" | "accent" | "warning" | "neutral";

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
): { tone: Tone; label: string; pulsing: boolean } {
  const { summary } = agent;
  switch (agent.attention) {
    case "blocked":
      return { tone: "error", label: "Needs you", pulsing: true };
    case "done":
      return failed(summary)
        ? { tone: "error", label: "Failed", pulsing: false }
        : { tone: "success", label: "Finished", pulsing: false };
    case "working":
      return stalledFor(summary, now, STALL_MS) === null
        ? { tone: "accent", label: phaseLabel(summary), pulsing: true }
        : {
            tone: "warning",
            label: `Silent for ${duration(now - (summary.status.kind === "running" ? summary.status.lastEventAt : now))}`,
            pulsing: false,
          };
    case "idle":
      return { tone: "neutral", label: summary.run === null ? "Idle" : "Idle (live)", pulsing: false };
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

export function formatTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);
}

/** A CLI's version number out of whatever it prints ("codex-cli 0.155.1", "2.1.284 (Claude Code)"). */
export function versionNumber(version: string): string {
  return /\d+(?:\.\d+)+(?:-[\w.]+)?/.exec(version)?.[0] ?? version;
}
