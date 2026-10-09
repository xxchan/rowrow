// The built-in tools each Coach runtime is told to turn off (SessionOptions.disallowedTools,
// D-044), so Coach has only rowrow's. Names are the runtime's own and case-sensitive: claude
// and pi accept a name that matches nothing without a word and turn nothing off (oar's
// docs/runtimes/claude.md and pi.md, "Disallowed tools"), so these lists are pinned by a test.
// Claude's was checked against the tools its init frame listed (2.1.292, 2026-10-08): with the
// names below off, it had DesignSync, ListAgents, PushNotification, RemoteTrigger,
// ReportFindings, ScheduleWakeup and Workflow left, which are now off too, plus the user's MCP
// servers (LAUNCH_ARGS keeps those out now).

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
 * Flags for a Coach runtime's process (SessionOptions.launchArgs, oar 0.45): left alone, claude
 * adds the user's MCP servers and claude.ai connectors to rowrow's, and loads the user's
 * settings (hooks, plugins, skills, env) and CLAUDE.md. `--strict-mcp-config` keeps only the
 * servers oar gives it, connectors included; `--setting-sources ""` reads no settings file
 * (managed policy still applies), and claude reads ~/.claude/CLAUDE.md and a project's only
 * with their source (checked in 2.1.292's code and a run, 2026-10-09). Pi refuses launchArgs.
 */
export const LAUNCH_ARGS: Readonly<Record<string, readonly string[]>> = {
  claude: ["--strict-mcp-config", "--setting-sources", ""],
};

/**
 * Environment for a Coach runtime beyond rowrow's own: claude's auto memory doesn't follow the
 * setting sources, and keys its directory on the enclosing git repository's root (a run inside
 * a checkout pointed it at that checkout's memory), so it's off.
 */
export const COACH_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  claude: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
};

/**
 * The tools a run's runtime says it has besides rowrow's own, from claude's `system/init` frame
 * (its native `tools` list): null when the entry isn't one. A misspelled or new built-in, or an
 * MCP server LAUNCH_ARGS failed to keep out, shows up here instead of going unnoticed. Read from
 * claude's native format until oar reports a session's effective tools itself (oar#253,
 * docs/upstream.md).
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
