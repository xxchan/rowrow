// Coach's actions (docs/decisions.md, D-045): what it proposes (a worktree, a new agent, a
// message to an agent, and a scheduled task, D-050), frozen when proposed, and what became of each. Both are entries of its
// chat's log (`coach.proposal`, `coach.action`); this is their fold, with the words every
// client shows. No zod here: the kit (src/kit) folds these too.
import type { TaskNotify, TaskSchedule } from "./coach-tasks.ts";
import type { Actor, Entry } from "./entries.ts";

/** A message Coach proposes to send (a first message or a prompt) has at most this many characters. */
export const MAX_PROMPT_CHARS = 20_000;
/** Proposals one turn may make at most. */
export const MAX_PROPOSALS_PER_TURN = 8;
/** Receipts a message carries to the model: the latest in its scope. */
export const RECEIPTS_PER_TURN = 8;

export type CoachActionKind = "create_worktree" | "start_agent" | "send_prompt" | "create_task";
export type CoachActionStatus = "pending" | "executing" | "succeeded" | "failed" | "uncertain" | "cancelled";

/** Everything an action will do, frozen when Coach proposed it: what Confirm runs, exactly. */
export interface CoachProposal {
  /** A UUID: also the inputId of the message it sends, so a send never happens twice. */
  readonly id: string;
  readonly kind: CoachActionKind;
  /** "" for a task, which reads whatever Coach may read when it runs. */
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  /** Send prompt: the agent it goes to. */
  readonly agentId?: string;
  readonly agentTitle?: string | null;
  readonly params: {
    /** Create worktree. */
    readonly branch?: string;
    readonly base?: string;
    /** The repository's setup hook, which runs in the new worktree; null when it has none. */
    readonly setupHook?: string | null;
    readonly sourcePath?: string;
    /** Start agent. */
    readonly runtime?: string;
    readonly runtimeName?: string;
    /** Start agent: its name; create task: the task's. */
    readonly title?: string | null;
    /** Start agent (its first message), send prompt and create task (what each run sends): the exact text. */
    readonly prompt?: string;
    /** Create task. */
    readonly schedule?: TaskSchedule;
    readonly notify?: TaskNotify;
  };
  readonly summary: string;
}

export const ACTION_NAMES: Readonly<Record<CoachActionKind, string>> = {
  create_worktree: "Create worktree",
  start_agent: "Start agent",
  send_prompt: "Send prompt",
  create_task: "Create task",
};

export const ACTION_SUMMARIES: Readonly<Record<CoachActionKind, string>> = {
  create_worktree:
    "Fetch origin's default branch, create a worktree on a new branch, add it as a workspace, and run the displayed setup hook.",
  start_agent:
    "Start a new agent in this workspace and send it the exact displayed first message. It may change files.",
  send_prompt:
    "Send the exact displayed prompt to this agent. It may trigger work or change files. Delivery will not be automatically retried.",
  create_task:
    "Enable a task that sends Coach the exact displayed prompt on its schedule, each run in a new chat that reads the workspaces Coach may read then.",
};

/** What each state's card says until a receipt says more. */
export const ACTION_COPY = {
  pending: "Waiting for your confirmation. Nothing has been executed.",
  executing: "Executing the confirmed operation and checking its result...",
  cancelled: "Cancelled. Nothing was executed.",
  replaced: "A new question replaced this preview. Ask Coach to propose it again if needed.",
  stopped: "The question was stopped. Ask Coach for a fresh preview.",
  left: "This chat was left. Ask Coach for a fresh preview.",
  restarted: "rowrow restarted. Ask Coach for a fresh preview.",
  restartedExecuting:
    "rowrow restarted during execution. Check the target before proposing another operation; this action will not be replayed.",
  configChanged: "Coach's settings changed. Ask for a fresh preview.",
  unavailable: "The approved target is no longer available. Ask Coach for a fresh preview.",
  base: "Latest origin default branch (fetched at confirmation)",
} as const;

/** A status as its card's pill says it ("Unverified": a message whose delivery isn't known). */
export function statusWord(kind: CoachActionKind, status: CoachActionStatus): string {
  switch (status) {
    case "pending":
      return "Needs confirmation";
    case "executing":
      return "Executing";
    case "succeeded":
      return kind === "create_task" ? "Enabled" : "Succeeded";
    case "failed":
      return "Failed";
    case "uncertain":
      return kind === "send_prompt" ? "Unverified" : "Outcome uncertain";
    case "cancelled":
      return "Cancelled";
  }
}

/** One action as its chat's log says it is now. */
export interface CoachActionState {
  readonly proposal: CoachProposal;
  readonly status: CoachActionStatus;
  readonly detail: string;
  /** Who confirmed, cancelled or ran it last (Coach itself, with Full access). */
  readonly by: Actor;
  readonly proposedAt: number;
  readonly updatedAt: number;
}

/** A chat's actions from its log's `coach.proposal` and `coach.action` entries. */
export function coachActionsOf(entries: Iterable<Entry>): ReadonlyMap<string, CoachActionState> {
  let actions: ReadonlyMap<string, CoachActionState> = new Map();
  for (const entry of entries) actions = reduceCoachActions(actions, entry);
  return actions;
}

/** The actions fold: a proposal is pending until an outcome entry moves it on. */
export function reduceCoachActions(
  actions: ReadonlyMap<string, CoachActionState>,
  entry: Entry,
): ReadonlyMap<string, CoachActionState> {
  if (entry.kind === "coach.proposal") {
    return new Map(actions).set(entry.proposal.id, {
      proposal: entry.proposal,
      status: "pending",
      detail: ACTION_COPY.pending,
      by: entry.by,
      proposedAt: entry.at,
      updatedAt: entry.at,
    });
  }
  if (entry.kind !== "coach.action") return actions;
  const action = actions.get(entry.actionId);
  if (action === undefined) return actions;
  return new Map(actions).set(entry.actionId, {
    ...action,
    status: entry.status,
    detail: entry.detail,
    by: entry.by,
    updatedAt: entry.at,
  });
}

/** Not decided yet: waiting for you, or running. */
export function openAction(action: CoachActionState): boolean {
  return action.status === "pending" || action.status === "executing";
}

/** An action as the model reads it: what it does, where, and how it went. */
export function actionView(action: CoachActionState): CoachActionView {
  const { proposal } = action;
  return {
    id: proposal.id,
    kind: proposal.kind,
    workspaceId: proposal.workspaceId,
    workspaceLabel: proposal.workspaceLabel,
    ...(proposal.agentId === undefined
      ? {}
      : { agentId: proposal.agentId, agentTitle: proposal.agentTitle ?? null }),
    params: proposal.params,
    summary: proposal.summary,
    status: action.status,
    detail: action.detail,
    proposedAt: new Date(action.proposedAt).toISOString(),
  };
}

export interface CoachActionView {
  readonly id: string;
  readonly kind: CoachActionKind;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly agentId?: string;
  readonly agentTitle?: string | null;
  readonly params: CoachProposal["params"];
  readonly summary: string;
  readonly status: CoachActionStatus;
  readonly detail: string;
  readonly proposedAt: string;
}

/** What the next message tells the model happened: the latest receipts whose target is in its scope. */
export function receiptsFor(
  actions: ReadonlyMap<string, CoachActionState>,
  scope: readonly string[],
): CoachActionView[] {
  return [...actions.values()]
    .filter((action) => scope.includes(action.proposal.workspaceId))
    .slice(-RECEIPTS_PER_TURN)
    .map(actionView);
}
