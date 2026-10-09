// Words and colors for an agent's state, the same on every screen of every client (the web
// app imports them, the iOS app gets them through the kit), so an agent reads the same
// everywhere (docs/architecture.md, "Attention and notifications").
import type { CredentialProblem, FailureClass } from "@botiverse/oar";
import type { ConversationInput } from "@botiverse/oar/observe";
import { classifyTool, failureAdvice, toolActionLabel } from "@botiverse/oar/observe";
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

/** What a person can do about a failed turn whose cause needs them (oar's failureAdvice). */
const FAILURE_STEPS: Partial<Record<FailureClass, string>> = {
  billing: "Check the account's plan or billing with the provider, then send it again.",
  model_unavailable: "This account can't use that model now: pick another one, then send it again.",
  input_too_large: "That was more than the model takes: send something shorter, or fewer attachments.",
};

/**
 * What to do after a turn failed, by oar's failure class: the step it needs from you, wait
 * for a limit, or just send it again. Null when nothing helps, and for a missing sign-in,
 * which has its own steps (sign-in.ts): a credential the provider rejected (an API key that
 * no longer works) isn't fixed by signing in.
 */
export function failureHint(failure: FailureClass, credential?: CredentialProblem): string | null {
  if (failure === "auth") {
    return credential === "rejected"
      ? "The provider rejected its credentials: if it uses an API key, check or replace it."
      : null;
  }
  const advice = failureAdvice(failure);
  if (advice.userAction) return FAILURE_STEPS[failure] ?? null;
  if (advice.retry === "later")
    return "A usage limit ran out: it resets later (Settings → Subscription usage says when).";
  if (advice.retry === "now") return "This usually passes: send it again in a moment.";
  return null;
}

/**
 * Why an input the runtime took was never read (oar's dropped state), and what to do. Never "not
 * delivered": it was, and after its process exited a resumed conversation may hold it after all.
 */
export function droppedWords(reason: ConversationInput["reason"]): string {
  switch (reason) {
    case "runtime_exited":
      return "Not read by the agent: its process exited first. Send it again if it still matters.";
    case "runtime_refused":
      return "Not read by the agent: it refused input mid-turn. Send it again once the turn ends.";
    case "turn_interrupted":
    case undefined:
      return "Not read by the agent: the turn ended first. Send it again if it still matters.";
  }
}
