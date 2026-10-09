// Coach's actions (D-045): what a proposal freezes, and how a confirmed one runs and is checked.
// A proposal holds everything Confirm will do (the target, every parameter, the exact text), so
// what runs is what the card showed. Running one says what happened only from what rowrow itself
// saw: the workspace it registered, the input its log recorded and how the runtime took it. A
// result rowrow can't vouch for is "uncertain", and nothing here ever retries.
import {
  ACTION_COPY,
  ACTION_SUMMARIES,
  type CoachActionStatus,
  type CoachProposal,
} from "../../shared/coach-actions.ts";
import type { Actor } from "../../shared/entries.ts";
import { newInputId } from "../../shared/ids.ts";
import type { AgentState, SendResult, Workspace } from "../../shared/schemas.ts";
import type { AgentLog } from "../agents/log.ts";
import type { Runtimes } from "../agents/runtimes.ts";
import type { AgentService } from "../agents/service.ts";
import type { GitOps } from "../api/router.ts";
import { UserError } from "../errors.ts";
import type { Workspaces } from "../workspaces/service.ts";

export interface ActionDeps {
  readonly agents: AgentService;
  readonly log: AgentLog;
  readonly workspaces: Workspaces;
  readonly runtimes: Runtimes;
  readonly git: () => Pick<GitOps, "createWorktree" | "worktreeSetup">;
}

/** What became of a confirmed action, in rowrow's words. */
export interface Receipt {
  readonly status: Exclude<CoachActionStatus, "pending" | "executing" | "cancelled">;
  readonly detail: string;
  /** Create worktree: the workspace it made. */
  readonly workspaceId?: string;
}

// ─── Proposals ────────────────────────────────────────────────────────────

export async function proposeWorktree(
  deps: ActionDeps,
  ws: Workspace,
  args: { branch: string },
): Promise<CoachProposal> {
  if (ws.git === null) throw new UserError(`${ws.label} isn't a git repository.`, "PRECONDITION_FAILED");
  return {
    id: newInputId(),
    kind: "create_worktree",
    workspaceId: ws.id,
    workspaceLabel: ws.label,
    params: {
      branch: args.branch.trim(),
      base: ACTION_COPY.base,
      setupHook: await deps.git().worktreeSetup(ws.id),
      sourcePath: ws.path,
    },
    summary: ACTION_SUMMARIES.create_worktree,
  };
}

export function proposeAgent(
  deps: ActionDeps,
  ws: Workspace,
  args: { runtime: string; prompt: string; title?: string | undefined },
): CoachProposal {
  const runtime = deps.runtimes.info(args.runtime);
  if (runtime === undefined || !runtime.installed)
    throw new UserError(
      `There is no runtime "${args.runtime}" installed here: use one agents_status lists under runtimes.`,
      "PRECONDITION_FAILED",
    );
  const title = args.title?.trim();
  return {
    id: newInputId(),
    kind: "start_agent",
    workspaceId: ws.id,
    workspaceLabel: ws.label,
    params: {
      runtime: runtime.id,
      runtimeName: runtime.name,
      title: title === undefined || title === "" ? null : title,
      prompt: args.prompt,
    },
    summary: ACTION_SUMMARIES.start_agent,
  };
}

export function proposePrompt(agent: AgentState, ws: Workspace, args: { prompt: string }): CoachProposal {
  return {
    id: newInputId(),
    kind: "send_prompt",
    workspaceId: ws.id,
    workspaceLabel: ws.label,
    agentId: agent.id,
    agentTitle: agent.summary.title,
    params: { prompt: args.prompt },
    summary: ACTION_SUMMARIES.send_prompt,
  };
}

// ─── Running one ──────────────────────────────────────────────────────────

/** Run a confirmed proposal exactly as frozen, and say what rowrow saw happen. */
export async function execute(deps: ActionDeps, proposal: CoachProposal, by: Actor): Promise<Receipt> {
  switch (proposal.kind) {
    case "create_worktree":
      return createWorktree(deps, proposal);
    case "start_agent":
      return startAgent(deps, proposal, by);
    case "send_prompt":
      return sendPrompt(deps, proposal, by);
  }
}

async function createWorktree(deps: ActionDeps, proposal: CoachProposal): Promise<Receipt> {
  const branch = proposal.params.branch ?? "";
  let created: Awaited<ReturnType<GitOps["createWorktree"]>>;
  try {
    created = await deps.git().createWorktree(proposal.workspaceId, {
      branch,
      newBranch: true,
      setup: proposal.params.setupHook ?? null,
    });
  } catch (error) {
    // rowrow's refusals (a taken branch, a bad name, git failing to add it) leave nothing behind.
    return error instanceof UserError
      ? { status: "failed", detail: `No worktree was created: ${error.message}` }
      : {
          status: "uncertain",
          detail: `rowrow couldn't tell whether the worktree was created (${messageOf(error)}). Check ${proposal.workspaceLabel}'s worktrees before proposing it again.`,
        };
  }
  const ws = deps.workspaces.get(created.workspace.id);
  if (ws === undefined || ws.git?.branch !== branch)
    return {
      status: "uncertain",
      detail: `git made the worktree, but rowrow couldn't verify a workspace on branch ${branch}. Check ${proposal.workspaceLabel}'s worktrees before proposing it again.`,
    };
  const hook =
    created.hook === null
      ? "The repository has no setup hook."
      : !created.hook.ran
        ? created.hook.output
        : created.hook.ok
          ? "Its setup hook ran and succeeded."
          : `Its setup hook failed: ${tail(created.hook.output)}`;
  return {
    status: "succeeded",
    workspaceId: ws.id,
    detail: `Created worktree ${ws.label} (${ws.id}) on new branch ${branch} at ${ws.path}. ${hook}`,
  };
}

async function startAgent(deps: ActionDeps, proposal: CoachProposal, by: Actor): Promise<Receipt> {
  const { params } = proposal;
  let agent: AgentState;
  try {
    agent = deps.agents.create({
      workspaceId: proposal.workspaceId,
      runtime: params.runtime ?? "",
      by,
      ...(params.title === null || params.title === undefined ? {} : { title: params.title }),
    });
  } catch (error) {
    return { status: "failed", detail: `No agent was started: ${messageOf(error)}` };
  }
  const name = `${agent.summary.title ?? params.title ?? "The new agent"} (${agent.id})`;
  return delivered(deps, proposal, agent.id, by, {
    prompted: `Started ${name} on ${params.runtimeName ?? params.runtime} in ${proposal.workspaceLabel}; its runtime took the exact first message and started its first turn.`,
    queued: `Started ${name}; rowrow holds its first message and sends it when its runtime is ready.`,
    notSent: `Started ${name}, but its first message wasn't sent`,
    unknown: `Started ${name}, but rowrow couldn't tell whether its first message was sent`,
  });
}

async function sendPrompt(deps: ActionDeps, proposal: CoachProposal, by: Actor): Promise<Receipt> {
  const agentId = proposal.agentId ?? "";
  const name = `${deps.agents.get(agentId)?.summary.title ?? proposal.agentTitle ?? "The agent"} (${agentId})`;
  return delivered(deps, proposal, agentId, by, {
    prompted: `${name} took the exact prompt and started a turn.`,
    queued: `${name} was working: rowrow holds the exact prompt and sends it when that turn ends. You can take it back from its queue until then.`,
    notSent: `The prompt wasn't sent to ${name}`,
    unknown: `Delivery to ${name} is unverified`,
  });
}

/**
 * Send the proposal's exact text, its id as the input's (so it can never go twice), and say how
 * it landed: the runtime's answer, read back from the agent's log.
 */
async function delivered(
  deps: ActionDeps,
  proposal: CoachProposal,
  agentId: string,
  by: Actor,
  words: { prompted: string; queued: string; notSent: string; unknown: string },
): Promise<Receipt> {
  let sent: SendResult;
  try {
    sent = await deps.agents.send(agentId, {
      inputId: proposal.id,
      text: proposal.params.prompt ?? "",
      mode: "auto",
      by,
    });
  } catch (error) {
    if (error instanceof UserError) return { status: "failed", detail: `${words.notSent}: ${error.message}` };
    return {
      status: "uncertain",
      detail: `${words.unknown} (${messageOf(error)}). Check the agent before sending it again.`,
    };
  }
  const recorded = deps.log.findInput(agentId, proposal.id).input !== undefined;
  const reason = sent.reason === undefined ? "" : `: ${sent.reason}`;
  if (!recorded)
    return {
      status: "uncertain",
      detail: `${words.unknown}: its log has no record of it. Check the agent before sending it again.`,
    };
  switch (sent.landed) {
    case "prompted":
    case "steered":
      return { status: "succeeded", detail: words.prompted };
    case "queued":
      return { status: "succeeded", detail: words.queued };
    case "rejected":
      return { status: "failed", detail: `${words.notSent}: its runtime refused it${reason}.` };
    case "failed":
      return sent.code === "uncertain"
        ? {
            status: "uncertain",
            detail: `${words.unknown}${reason}. Check the agent before sending it again.`,
          }
        : { status: "failed", detail: `${words.notSent}${reason}.` };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The end of a hook's output, for a receipt. */
function tail(output: string): string {
  const text = output.trim();
  return text.length <= 600 ? text || "(no output)" : `…${text.slice(-600)}`;
}
