// The built-in tools each Coach runtime is told to turn off (SessionOptions.disallowedTools,
// D-044), so Coach has only rowrow's. Names are the runtime's own and case-sensitive: claude
// and pi accept a name that matches nothing without a word and turn nothing off (oar's
// docs/runtimes/claude.md and pi.md, "Disallowed tools"), so these lists are pinned by a test.
// Claude's was checked against the tools its init frame listed (2.1.292, 2026-10-08): with the
// names below off, it had DesignSync, ListAgents, PushNotification, RemoteTrigger,
// ReportFindings, ScheduleWakeup and Workflow left, which are now off too, plus the user's MCP
// servers (docs/upstream.md).

import { COACH_MCP_SERVER } from "../../shared/coach.ts";
import type { Entry } from "../../shared/entries.ts";

/** Claude Code's built-ins, past and present names (an unknown one is harmless). */
const CLAUDE = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "KillBash",
  "KillShell",
  "LS",
  "LSP",
  "ListAgents",
  "ListMcpResourcesTool",
  "Monitor",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "PushNotification",
  "Read",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SendMessage",
  "Skill",
  "SlashCommand",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
] as const;

/** Pi's (pi-coding-agent's allToolNames). */
const PI = ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"] as const;

/** The scripted runtime's (it ignores the list; tests check it arrives). */
const SCRIPTED = ["Bash", "Write"] as const;

export const BUILTIN_TOOLS: Readonly<Record<string, readonly string[]>> = {
  claude: CLAUDE,
  pi: PI,
  scripted: SCRIPTED,
};

/**
 * Environment for a Coach runtime beyond rowrow's own: claude loads the connectors of the
 * user's claude.ai account as MCP servers unless told not to (its init frame listed them).
 */
export const COACH_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  claude: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
};

/**
 * The tools a run's runtime says it has besides rowrow's own, from claude's `system/init` frame
 * (its native `tools` list): null when the entry isn't one. A misspelled or new built-in, or an
 * MCP server of the user's, shows up here instead of going unnoticed. Read from claude's native
 * format until oar reports a session's effective tools itself (oar#253, docs/upstream.md).
 */
export function leakedTools(entry: Entry): string[] | null {
  if (entry.kind !== "oar" || entry.record.kind !== "frame") return null;
  const native = entry.record.body.native;
  if (typeof native !== "object" || native === null) return null;
  const init = native as { type?: unknown; subtype?: unknown; tools?: unknown };
  if (init.type !== "system" || init.subtype !== "init" || !Array.isArray(init.tools)) return null;
  return init.tools.filter(
    (tool): tool is string => typeof tool === "string" && !tool.startsWith(`mcp__${COACH_MCP_SERVER}__`),
  );
}
