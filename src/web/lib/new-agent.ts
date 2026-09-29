// Starting an agent from the browser: the remembered setup (D-023) and the calls that start
// one. The new-agent dialog, the home page's composer and the command menu all come here.
import type { Attachment } from "../../shared/entries.ts";
import { newInputId } from "../../shared/ids.ts";
import type { Client } from "./connection.ts";
import {
  NO_PREFS,
  parsePrefs,
  remember,
  type AgentSetup,
  type NewAgentContext,
  type NewAgentPrefs,
} from "./new-agent-setup.ts";
import type { Route } from "./router.ts";
import { report } from "./telemetry.ts";

const PREFS = "rowrow.newAgent";
/** Written by earlier versions: only the runtime was remembered. */
const LAST_RUNTIME = "rowrow.lastRuntime";

export function loadPrefs(): NewAgentPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS), localStorage.getItem(LAST_RUNTIME));
  } catch (error) {
    report("warn", "new_agent.prefs_unreadable", error);
    return NO_PREFS;
  }
}

function savePrefs(prefs: NewAgentPrefs): void {
  try {
    localStorage.setItem(PREFS, JSON.stringify(prefs));
  } catch (error) {
    report("warn", "new_agent.prefs_unsaved", error);
  }
}

/** The page a new agent is started from decides its defaults. */
export function contextOf(route: Route): NewAgentContext {
  if (route.name === "agent") return { kind: "agent", agentId: route.agentId };
  if (route.name === "workspace") return { kind: "workspace", workspaceId: route.workspaceId };
  return { kind: "anywhere" };
}

export interface StartRequest extends AgentSetup {
  readonly workspaceId: string;
  readonly runtime: string;
  /** For a new worktree; empty picks a name. */
  readonly branch: string;
  /** The first message; empty (with no attachments) starts it without one. */
  readonly text: string;
  readonly attachments?: readonly Attachment[];
}

/** Start an agent (in a new worktree first, when asked) and remember its setup. Returns its id. */
export async function startAgent(client: Client, request: StartRequest): Promise<string> {
  let target = request.workspaceId;
  if (request.isolate) {
    const created = await client.workspaces.createWorktree({
      id: request.workspaceId,
      ...(request.branch === "" ? {} : { branch: request.branch }),
    });
    target = created.workspace.id;
    if (created.hook !== null && !created.hook.ok)
      report("warn", "worktree.setup_hook_failed", undefined, { output: created.hook.output.slice(-500) });
  }
  const { agent, sent } = await client.agents.create({
    workspaceId: target,
    runtime: request.runtime,
    ...(request.model === null ? {} : { model: request.model }),
    ...(request.effort === null ? {} : { effort: request.effort }),
    ...(request.text === "" && (request.attachments?.length ?? 0) === 0
      ? {}
      : {
          input: {
            inputId: newInputId(),
            text: request.text,
            ...(request.attachments === undefined || request.attachments.length === 0
              ? {}
              : { attachments: [...request.attachments] }),
          },
        }),
  });
  if (sent !== null && (sent.landed === "failed" || sent.landed === "rejected"))
    report("warn", "agent.first_input_not_delivered", undefined, {
      landed: sent.landed,
      reason: sent.reason,
    });
  savePrefs(
    remember(loadPrefs(), request.workspaceId, {
      runtime: request.runtime,
      model: request.model,
      effort: request.effort,
      isolate: request.isolate,
    }),
  );
  return agent.id;
}
