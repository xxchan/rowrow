// Coach (docs/decisions.md, D-044): rowrow's assistant, which reads the crew of agents in the
// workspaces you allow and helps you keep track of them; it does no coding itself. A Coach chat
// is an agent with role "coach" whose runtime runs with Coach's system prompt, its built-in
// tools turned off, and only these tools, over MCP (`rowrow mcp coach`). This module is what
// the server, the CLI's MCP server and the web app share: the tools, their bounds, and which
// runtimes can be Coach. Phase 2 (D-045): it proposes actions you confirm (a worktree, a new
// agent, a message to an agent), or, with Full access, takes them itself (coach-actions.ts).
// Phase 3 (D-050): a chat proposes scheduled tasks; a task's run may notify you (coach-tasks.ts).
import { z } from "zod";
import { MAX_PROMPT_CHARS } from "./coach-actions.ts";
import { MAX_INTERVAL_MINUTES, MAX_TITLE_CHARS, MIN_INTERVAL_MINUTES } from "./coach-tasks.ts";

/** The tools' server, as the runtime knows it: claude calls its tools `mcp__rowrow__<tool>`. */
export const COACH_MCP_SERVER = "rowrow";

/**
 * Runtimes that can be Coach: they take a system prompt of ours, MCP servers, and a list of
 * built-in tools to turn off (oar's SessionOptions). Codex can't turn its built-in tools off,
 * cursor, kimi and antigravity refuse a system prompt, grok, kimi and opencode refuse the
 * list (oar's docs/spec/runtime-matrix.md). The scripted runtime is for tests and dev.
 */
const COACH_RUNTIMES = new Set(["claude", "pi", "scripted"]);

export function canCoach(runtime: string): boolean {
  return COACH_RUNTIMES.has(runtime);
}

export const CANT_COACH = "This runtime can't turn off its built-in tools, so it can't be Coach.";

/** The code of the `host.error` a chat gets when its runtime reports tools besides rowrow's. */
export const COACH_TOOLS_LEAKED = "coach_tools_leaked";

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** Items (agents, files, commands) one read returns at most. */
export const MAX_ITEMS = 80;
/** Characters of one message, command output or file name list entry at most. */
export const MAX_MESSAGE_CHARS = 8000;
/** Characters of one read's text (a transcript, a diff) at most. */
export const MAX_PAYLOAD_CHARS = 32_000;
/** What a read says when it left something out. */
export const TRUNCATED_WARNING =
  "Some data was truncated. This is partial evidence; do not infer that omitted records do not exist.";

/** The first `max` items, and whether there were more. */
export function firstItems<T>(items: readonly T[], max = MAX_ITEMS): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, max), truncated: items.length > max };
}

/** Text cut to `max` characters, keeping its start (a message) or its end (output, a transcript). */
export function clipText(
  text: string,
  max: number,
  keep: "start" | "end" = "start",
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const note = `[${text.length - max} characters cut]`;
  return keep === "start"
    ? { text: `${text.slice(0, max)}\n${note}`, truncated: true }
    : { text: `${note}\n${text.slice(text.length - max)}`, truncated: true };
}

/** A read's result with when it was read, and the warning when anything was cut. */
export function stamped<T extends object>(
  result: T,
  truncated: boolean,
  now = Date.now(),
): T & { readAt: string; truncated: boolean; warning?: string } {
  return {
    readAt: new Date(now).toISOString(),
    ...result,
    truncated,
    ...(truncated ? { warning: TRUNCATED_WARNING } : {}),
  };
}

// ─── Tools ──────────────────────────────────────────────────────────────────

const agentId = z.string().describe("An agent id (ag_…) from agents_status.");

/** A task's schedule (D-050), as the form, the CLI and Coach's tool give it; the server checks it further. */
export const TaskScheduleArgs = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    at: z.string().describe("When it runs: a future UTC ISO 8601 timestamp ending in Z."),
  }),
  z.object({
    type: z.literal("daily"),
    time: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
      .describe("The wall-clock time it runs each day, HH:mm."),
    timeZone: z.string().min(1).max(100).describe("The IANA time zone of that time, like Europe/London."),
  }),
  z.object({
    type: z.literal("interval"),
    minutes: z
      .number()
      .int()
      .min(MIN_INTERVAL_MINUTES)
      .max(MAX_INTERVAL_MINUTES)
      .describe("Minutes between runs; the first is that long after it's enabled."),
  }),
]);

export const TaskNotifyArgs = z
  .enum(["every", "coach"])
  .describe(
    "every: a notification when each run finishes (the default); coach: Coach notifies only when the outcome matters or needs the user (a failed run still notifies).",
  );

/** Each tool's arguments: the procedure's input, less `chatId` (the token says whose turn it is). */
export const CoachToolArgs = {
  agents_status: z.object({
    workspaceId: z
      .string()
      .optional()
      .describe("One authorized workspace (ws_…); omit it to list the whole authorized scope."),
  }),
  agent_history: z.object({
    agentId,
    turns: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("How many of the latest turns to read (default 3)."),
    before: z
      .number()
      .int()
      .optional()
      .describe("Read the turns before this position: the `before` an earlier call returned."),
  }),
  agent_changes: z.object({
    agentId,
    scope: z
      .enum(["working", "branch", "turn"])
      .optional()
      .describe(
        "working: uncommitted changes (default); branch: everything since the default branch; turn: what the agent's latest turn changed.",
      ),
    path: z.string().optional().describe("A path the list returned: read that file's diff."),
  }),
  agent_background: z.object({ agentId }),
  propose_worktree_create: z.object({
    workspaceId: z.string().describe("The authorized workspace whose repository gets the worktree (ws_…)."),
    branch: z.string().min(1).max(200).describe("The new branch, which also names the worktree's directory."),
  }),
  propose_agent_start: z.object({
    workspaceId: z.string().describe("The authorized workspace the agent works in (ws_…)."),
    runtime: z.string().describe("A runtime id agents_status lists under `runtimes`."),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS).describe("The exact first message."),
    title: z.string().max(200).optional().describe("A short name for the agent."),
  }),
  propose_agent_prompt: z.object({
    agentId,
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS).describe("The exact message."),
  }),
  list_coach_tasks: z.object({}),
  propose_coach_task: z.object({
    title: z.string().trim().min(1).max(MAX_TITLE_CHARS).describe("A short name for the task."),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PROMPT_CHARS)
      .describe(
        "The exact message each run sends Coach: what to check, and what counts as success, failure or needed input.",
      ),
    schedule: TaskScheduleArgs,
    notify: TaskNotifyArgs.optional(),
  }),
  send_user_notification: z.object({
    eventKey: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "Names the agent and the observed outcome; the same key for the same unchanged event across runs.",
      ),
    kind: z
      .enum(["completed", "attention"])
      .describe("completed: verified success; attention: a failure or input the user must give."),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(400),
  }),
} as const;

export type CoachToolName = keyof typeof CoachToolArgs;

export const COACH_TOOLS: readonly {
  readonly name: CoachToolName;
  /** What the UI calls it (a proposal shows its own name, as roamgate does). */
  readonly label: string;
  readonly description: string;
  /** The contract procedure it calls: coach.<procedure>. */
  readonly procedure:
    | "agentsStatus"
    | "agentHistory"
    | "agentChanges"
    | "agentBackground"
    | "proposeWorktree"
    | "proposeAgent"
    | "proposePrompt"
    | "listTasks"
    | "proposeTask"
    | "notify";
  /** A proposal: with Full access its description says it executes (coachToolDescription). */
  readonly proposal?: true;
  /** Only in a chat (the task tools), or only in a scheduled task's run (its notification tool). */
  readonly only?: "chat" | "run";
}[] = [
  {
    name: "agents_status",
    label: "Agent status",
    procedure: "agentsStatus",
    description:
      "List the agents in the authorized workspaces and their status: what each is doing, how its last turn ended, and the end of what it last said, and the runtimes an agent can start on. Omit workspaceId to list the whole authorized scope.",
  },
  {
    name: "agent_history",
    label: "Agent history",
    procedure: "agentHistory",
    description:
      "Read an agent's conversation as text, oldest first: messages, tool calls and their output cut short, and how each turn ended. Use agent ids from agents_status. Results keep at most 32,000 newest characters; pass the returned `before` to read older turns.",
  },
  {
    name: "agent_changes",
    label: "Agent changes",
    procedure: "agentChanges",
    description:
      "Read the changes in an agent's workspace. Use agent ids from agents_status. Omit path to list changed files, then pass a listed path to read its diff (at most 32,000 characters).",
  },
  {
    name: "agent_background",
    label: "Background output",
    procedure: "agentBackground",
    description:
      "Read the commands an agent runs in the background (dev servers, builds, watchers) and the end of their output. Use agent ids from agents_status.",
  },
  {
    name: "propose_worktree_create",
    label: "propose_worktree_create",
    procedure: "proposeWorktree",
    proposal: true,
    description:
      "Propose creating a Git worktree from an authorized source workspace. Returns a pending proposal for the user to confirm; does not create it.",
  },
  {
    name: "propose_agent_start",
    label: "propose_agent_start",
    procedure: "proposeAgent",
    proposal: true,
    description:
      "Propose starting an agent in an authorized workspace with an exact first message. Returns a pending proposal for the user to confirm; does not start it.",
  },
  {
    name: "propose_agent_prompt",
    label: "propose_agent_prompt",
    procedure: "proposePrompt",
    proposal: true,
    description:
      "Propose sending a prompt to an agent in an authorized workspace. Returns a pending proposal for the user to confirm; does not send it.",
  },
  {
    name: "list_coach_tasks",
    label: "Coach tasks",
    procedure: "listTasks",
    only: "chat",
    description:
      "List scheduled Coach tasks and the current time and timezone. Use the current time before interpreting relative dates.",
  },
  {
    name: "propose_coach_task",
    label: "propose_coach_task",
    procedure: "proposeTask",
    proposal: true,
    only: "chat",
    description:
      "Propose a Coach task with an exact prompt and schedule. A once schedule uses a future UTC ISO 8601 timestamp ending in Z. A daily schedule uses HH:mm and an IANA timezone; skipped DST times do not run and repeated times run once. An interval starts the given number of minutes after confirmation. Each run is a new chat that reads the workspaces Coach may read when it runs. Choose notify coach for monitoring and follow-up requests: Coach can notify only on meaningful requested outcomes or needed input, with its own title and body. The default every mode sends a fixed notification when each run finishes. Returns a pending preview: the task is enabled only when the user clicks Confirm. Scheduled tasks may read and propose operations; they never automatically confirm management actions. Ask the user if their schedule or timezone is ambiguous.",
  },
  {
    name: "send_user_notification",
    label: "Notify the user",
    procedure: "notify",
    only: "run",
    description:
      "Request a notification for a meaningful outcome or needed user input covered by this confirmed task. Use completed for verified success and attention for failure or required user input. eventKey must identify the same agent and observed outcome across runs; reuse the exact key for an unchanged event and consult prior notification receipts. Use a concise title and body grounded in fresh agent evidence, without credentials or authorization URLs. The server chooses the recipient and task link. A receipt records acceptance or deduplication, never proof of device delivery. Stay quiet while the monitored state is unchanged or non-actionable.",
  },
];

/**
 * A tool's description for the model. With Full access a proposal executes, and says so the way
 * roamgate's high-permission mode rewrites its tools: the same tool, with execution receipts.
 */
export function coachToolDescription(tool: (typeof COACH_TOOLS)[number], fullAccess: boolean): string {
  if (tool.proposal !== true || !fullAccess) return tool.description;
  // Ranger's high-permission task tool: enabled directly, with a receipt.
  if (tool.name === "propose_coach_task")
    return `${tool.description.split("Returns a pending preview:")[0] ?? ""}Enables the task directly when permission is still active and returns a confirmed receipt; a pending receipt requires manual confirmation. Ask the user if their schedule or timezone is ambiguous.`;
  const what = (tool.description.split("Returns a pending proposal")[0] ?? "").replace(
    /^Propose /,
    "Execute ",
  );
  return `${what}Use workspace and agent identifiers from agents_status. Returns an execution receipt: succeeded is verified, uncertain must be inspected before any retry, and pending requires manual confirmation. Read agents_status after creating a worktree or starting an agent to discover the new workspace or agent.`;
}

/** What the UI calls a tool Coach called: its label, or the runtime's name for it. */
export function coachToolLabel(tool: string): string {
  const name = tool.startsWith(`mcp__${COACH_MCP_SERVER}__`)
    ? tool.slice(`mcp__${COACH_MCP_SERVER}__`.length)
    : tool;
  return COACH_TOOLS.find((t) => t.name === name)?.label ?? tool;
}

// ─── What the tools return ──────────────────────────────────────────────────

interface Read {
  /** When rowrow read it (ISO 8601). */
  readonly readAt: string;
  readonly truncated: boolean;
  /** TRUNCATED_WARNING, when something was left out. */
  readonly warning?: string;
}

export interface AgentsStatusResult extends Read {
  readonly workspaces: readonly {
    readonly workspaceId: string;
    readonly label: string;
    readonly path: string;
    readonly branch: string | null;
  }[];
  readonly agents: readonly {
    readonly agentId: string;
    readonly title: string | null;
    readonly workspaceId: string;
    readonly runtime: string;
    /** blocked (asks you something), done (finished, not seen), working or idle. */
    readonly attention: string;
    /** In words, as rowrow shows it: "Running a command", "Finished", "Needs you"… */
    readonly state: string;
    readonly lastTurn: { readonly outcome: string; readonly reason?: string; readonly at: string } | null;
    /** The end of what it last said. */
    readonly preview: string | null;
    readonly queued: number;
    readonly backgroundCommands: number;
    readonly updatedAt: string;
  }[];
  /** The runtimes installed here, for propose_agent_start (signedIn: null when rowrow can't ask). */
  readonly runtimes: readonly {
    readonly runtime: string;
    readonly name: string;
    readonly signedIn: boolean | null;
  }[];
}

export interface AgentHistoryResult extends Read {
  readonly agentId: string;
  readonly title: string | null;
  readonly workspaceId: string;
  readonly text: string;
  /** Pass as `before` to read the turns before these; null at the start of the conversation. */
  readonly before: number | null;
  readonly historyWindow: string;
}

export type AgentChangesResult = Read & {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly scope: string;
} & (
    | {
        readonly base: string | null;
        readonly files: readonly {
          readonly path: string;
          readonly oldPath: string | null;
          readonly status: string;
          readonly additions: number | null;
          readonly deletions: number | null;
          readonly staged?: boolean;
          readonly unstaged?: boolean;
        }[];
        readonly total: number;
        readonly note: string | null;
      }
    | { readonly path: string; readonly diff: string }
  );

export interface AgentBackgroundResult extends Read {
  readonly agentId: string;
  readonly commands: readonly {
    readonly taskId: string;
    readonly type: string;
    readonly description: string | null;
    readonly status: string;
    readonly startedAt: string | null;
    readonly summary: string | null;
    readonly error: string | null;
    /** The end of its output, when the runtime writes it to a file rowrow can read. */
    readonly outputTail: string | null;
  }[];
}

/** A Coach chat in History. */
export interface CoachChat {
  readonly id: string;
  readonly title: string | null;
  readonly runtime: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Messages you sent (a task's run: its prompt). */
  readonly messages: number;
  readonly current: boolean;
  /** A scheduled task's run (D-050): that task's id; its title is the chat's. */
  readonly taskId: string | null;
}
