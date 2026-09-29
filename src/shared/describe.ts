// Words and colors for an agent's state, the same on every screen of every client (the web
// app imports them, the iOS app gets them through the kit), so an agent reads the same
// everywhere (docs/architecture.md, "Attention and notifications").
import { classifyTool, toolActionLabel } from "@botiverse/oar/observe";
import type { AgentState } from "./schemas.ts";
import { stalledFor, type AgentSummary } from "./summary.ts";

/** A working agent silent for this long reads as stalled. */
export const STALL_MS = 3 * 60_000;

/** The color family of a state: the same everywhere a state is shown. */
export type Tone = "error" | "success" | "accent" | "warning" | "neutral";

export interface StateWords {
  readonly tone: Tone;
  readonly label: string;
  /** Something is happening right now (a live dot pulses). */
  readonly pulsing: boolean;
}

/** The latest thing worth your attention was a failure (a failed turn, a run that died or never started). */
export function failed(summary: AgentSummary): boolean {
  if (summary.lastCompletionSeq < 0) return false;
  return summary.lastTurn?.seq === summary.lastCompletionSeq
    ? summary.lastTurn.outcome.kind === "failed"
    : summary.lastError !== null;
}

export function statusDot(agent: AgentState, now = Date.now()): StateWords {
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

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
