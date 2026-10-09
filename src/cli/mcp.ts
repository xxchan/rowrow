// `rowrow mcp coach`: Coach's tools as an MCP server on stdio (D-044). A Coach chat's runtime
// starts it (SessionOptions.mcpServers) with ROWROW_URL and its run's own ROWROW_TOKEN, and each
// tool call is one call of the contract's coach.* reads and proposals (D-045), which check the
// turn's workspaces on the server. ROWROW_COACH_FULL_ACCESS=1 says the run has Full access: its
// proposals' descriptions say they execute, as roamgate rewrites them. MCP over stdio is JSON-RPC 2.0, one message per line: initialize, tools/list,
// tools/call and ping are all a server of tools needs, so this is that, without a dependency.
// stdout carries only the protocol; anything else goes to stderr.
import { ORPCError } from "@orpc/client";
import readline from "node:readline";
import { z } from "zod";
import {
  COACH_MCP_SERVER,
  COACH_TOOLS,
  CoachToolArgs,
  coachToolDescription,
  type CoachToolName,
} from "../shared/coach.ts";
import type { Client } from "./client.ts";

/** Protocol versions this server speaks; it answers with the client's when it knows it. */
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Request {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

type Reply = { result: unknown } | { error: { code: number; message: string } };

export async function serveCoachMcp(client: Client, version: string): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const write = (message: object): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      write({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    // A notification (initialized, cancelled) wants no answer.
    if (request.id === undefined) continue;
    const id = request.id;
    const task = answer(client, version, request).then(
      (reply) => write({ id, ...reply }),
      (error: unknown) =>
        write({
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        }),
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}

export async function answer(
  client: Client,
  version: string,
  request: Request,
  fullAccess = process.env["ROWROW_COACH_FULL_ACCESS"] === "1",
): Promise<Reply> {
  switch (request.method) {
    case "initialize": {
      const asked = request.params?.["protocolVersion"];
      return {
        result: {
          protocolVersion: typeof asked === "string" && VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: COACH_MCP_SERVER, version },
        },
      };
    }
    case "ping":
      return { result: {} };
    case "tools/list":
      return {
        result: {
          tools: COACH_TOOLS.map((tool) => {
            const { $schema: _schema, ...inputSchema } = z.toJSONSchema(CoachToolArgs[tool.name]);
            return { name: tool.name, description: coachToolDescription(tool, fullAccess), inputSchema };
          }),
        },
      };
    case "tools/call": {
      const name = request.params?.["name"];
      const tool = COACH_TOOLS.find((t) => t.name === name);
      if (tool === undefined) return { error: { code: -32602, message: `Unknown tool: ${String(name)}` } };
      return { result: await callTool(client, tool.name, request.params?.["arguments"] ?? {}) };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${request.method}` } };
  }
}

/** One tool call: its result as JSON text, or what went wrong as a tool error the model reads. */
async function callTool(
  client: Client,
  name: CoachToolName,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[]; isError?: true }> {
  try {
    const result = await call(client, name, args);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof z.ZodError) return toolError(`Invalid arguments: ${z.prettifyError(error)}`);
    // rowrow's own refusals say what to do; anything else stays out of the model's context.
    if (error instanceof ORPCError && error.code !== "INTERNAL_SERVER_ERROR") return toolError(error.message);
    process.stderr.write(`rowrow mcp coach: ${name} failed: ${String(error)}\n`);
    return toolError(
      name.startsWith("propose_")
        ? "Action proposal unavailable, stale, or outside the authorized scope."
        : "Context unavailable, stale, or outside the authorized scope.",
    );
  }
}

function call(client: Client, name: CoachToolName, args: unknown): Promise<unknown> {
  switch (name) {
    case "agents_status":
      return client.coach.agentsStatus(CoachToolArgs.agents_status.parse(args));
    case "agent_history":
      return client.coach.agentHistory(CoachToolArgs.agent_history.parse(args));
    case "agent_changes":
      return client.coach.agentChanges(CoachToolArgs.agent_changes.parse(args));
    case "agent_background":
      return client.coach.agentBackground(CoachToolArgs.agent_background.parse(args));
    case "propose_worktree_create":
      return client.coach.proposeWorktree(CoachToolArgs.propose_worktree_create.parse(args));
    case "propose_agent_start":
      return client.coach.proposeAgent(CoachToolArgs.propose_agent_start.parse(args));
    case "propose_agent_prompt":
      return client.coach.proposePrompt(CoachToolArgs.propose_agent_prompt.parse(args));
  }
}

function toolError(text: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}
