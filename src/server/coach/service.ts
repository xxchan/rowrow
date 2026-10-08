// Coach (docs/decisions.md, D-044): rowrow's assistant. A chat is an agent with role "coach",
// so it has a log, runs, a transcript, stop, model and effort like any agent. What makes it
// Coach is here: what a message sends (the workspaces it may read, captured now and fixed for
// the turn), how its runs open (Coach's system prompt, the runtime's built-in tools off, and
// rowrow's MCP server with a token for that run), and the reads its tools make, each checked
// against the turn's workspaces and bounded like roamgate's (80 items, 8,000 characters a
// message, 32,000 a read).
import type { SessionOptions } from "@botiverse/oar";
import fs from "node:fs/promises";
import {
  canCoach,
  CANT_COACH,
  COACH_TOOLS_LEAKED,
  clipText,
  COACH_MCP_SERVER,
  firstItems,
  MAX_ITEMS,
  MAX_MESSAGE_CHARS,
  MAX_PAYLOAD_CHARS,
  stamped,
  type AgentBackgroundResult,
  type AgentChangesResult,
  type AgentHistoryResult,
  type AgentsStatusResult,
  type CoachChat,
} from "../../shared/coach.ts";
import { statusDot } from "../../shared/describe.ts";
import type { Actor, EntryOf } from "../../shared/entries.ts";
import { renderText } from "../../shared/render-text.ts";
import type { AgentState, DiffScope, SendResult } from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { timelineOf } from "../../shared/timeline.ts";
import type { AgentLog } from "../agents/log.ts";
import type { Runtimes } from "../agents/runtimes.ts";
import type { AgentService } from "../agents/service.ts";
import type { GitOps } from "../api/router.ts";
import { UserError } from "../errors.ts";
import type { SettingsService } from "../settings.ts";
import { log, withContext } from "../telemetry/log.ts";
import type { Workspaces } from "../workspaces/service.ts";
import { COACH_SYSTEM_PROMPT, turnText } from "./prompt.ts";
import type { CoachTokens } from "./tokens.ts";
import { BUILTIN_TOOLS, leakedTools } from "./tools.ts";

export interface CoachDeps {
  readonly agents: AgentService;
  readonly log: AgentLog;
  readonly workspaces: Workspaces;
  readonly settings: SettingsService;
  readonly runtimes: Runtimes;
  readonly git: () => Pick<GitOps, "changes" | "diff">;
  readonly tokens: CoachTokens;
  /** The `rowrow` launcher of this server's own CLI: Coach's MCP server is `rowrow mcp coach`. */
  readonly cli: string;
  /** Where the MCP server reaches this server. */
  readonly url: () => string;
}

const HISTORY_CHATS = 200;
const BUSY = "Coach is still working on your last message: stop it, or wait for its answer.";

export class CoachService {
  private readonly deps: CoachDeps;
  /** coach.send, one at a time: a second one sees the first's chat. */
  private sending: Promise<unknown> = Promise.resolve();

  constructor(deps: CoachDeps) {
    this.deps = deps;
    deps.log.onAppend((agentId, entry) => {
      // A run's token works as long as the run.
      if (entry.kind === "run.ended" || entry.kind === "run.failed") deps.tokens.revoke(entry.runId);
      if (entry.kind === "oar") this.checkTools(agentId, entry);
    });
  }

  /** Runs whose tools were already found wanting: said once a run. */
  private readonly leaks = new Set<string>();

  /**
   * Coach's runtime says what tools it has (claude's init frame): anything but rowrow's own is
   * a gap in turning its tools off, never silent: a warning in the log, and a line in the chat.
   */
  private checkTools(agentId: string, entry: EntryOf<"oar">): void {
    const leaked = leakedTools(entry);
    if (leaked === null || leaked.length === 0 || this.leaks.has(entry.runId)) return;
    if (this.deps.agents.get(agentId)?.summary.role !== "coach") return;
    this.leaks.add(entry.runId);
    withContext({ agent: agentId, run: entry.runId }, () =>
      log.warn("coach.tools_leaked", { tools: leaked }),
    );
    // After this append returns: a listener doesn't write into the append it hears.
    setImmediate(() =>
      withContext({ agent: agentId }, () =>
        this.deps.log.append(agentId, {
          kind: "host.error",
          code: COACH_TOOLS_LEAKED,
          message: `Coach's session has tools it shouldn't: ${leaked.join(", ")}`,
        }),
      ),
    );
  }

  // ─── Chats ────────────────────────────────────────────────────────────────

  send(input: {
    inputId: string;
    text: string;
    chatId?: string | null;
    by: Actor;
    trace?: string;
  }): Promise<SendResult & { chatId: string }> {
    const result = this.sending.then(async () => this.sendNow(input));
    this.sending = result.catch(() => undefined);
    return result;
  }

  private async sendNow(input: {
    inputId: string;
    text: string;
    chatId?: string | null;
    by: Actor;
    trace?: string;
  }): Promise<SendResult & { chatId: string }> {
    const { agents } = this.deps;
    let chat = agents.currentCoach();
    const send = async (chatId: string, scope: readonly string[]) => ({
      chatId,
      ...(await agents.send(chatId, {
        inputId: input.inputId,
        text: input.text,
        mode: "auto",
        by: input.by,
        scope,
        ...(input.trace === undefined ? {} : { trace: input.trace }),
      })),
    });
    // A retry of a message already taken: its first outcome stands.
    if (chat !== null && this.deps.log.findInput(chat.id, input.inputId).input !== undefined)
      return send(chat.id, []);
    if (input.chatId !== undefined && input.chatId !== (chat?.id ?? null))
      throw new UserError(
        "The current Coach chat changed in another window. Look at it again before sending.",
        "CONFLICT",
      );
    const settings = this.deps.settings.get().coach;
    if (!canCoach(settings.runtime)) throw new UserError(CANT_COACH, "PRECONDITION_FAILED");
    const runtime = this.deps.runtimes.info(settings.runtime);
    if (runtime === undefined || !runtime.installed)
      throw new UserError(
        `${runtime?.name ?? settings.runtime} isn't installed here: pick another runtime in Coach's settings.`,
        "PRECONDITION_FAILED",
      );
    // Captured now, fixed for the turn: what you allowed that still exists.
    const scope = settings.workspaces.filter((id) => {
      const ws = this.deps.workspaces.get(id);
      return ws !== undefined && !ws.archived && !ws.missing;
    });
    if (scope.length === 0)
      throw new UserError(
        "Choose the workspaces Coach may read in its settings first.",
        "PRECONDITION_FAILED",
      );
    if (chat !== null && busy(chat)) throw new UserError(BUSY, "CONFLICT");
    // A chat runs on one runtime: another one starts a new chat.
    if (chat !== null && chat.summary.runtime !== settings.runtime) {
      await agents.update(chat.id, { archived: true }, input.by);
      chat = null;
    }
    if (chat === null) {
      chat = agents.createCoach({
        runtime: settings.runtime,
        by: input.by,
        ...(settings.model === null ? {} : { model: settings.model }),
        ...(settings.effort === null ? {} : { effort: settings.effort }),
      });
    } else if (chat.summary.model !== settings.model || chat.summary.effort !== settings.effort) {
      // Idle (checked above), so the restart this takes ends no turn.
      await agents.update(chat.id, { model: settings.model, effort: settings.effort }, input.by);
    }
    log.info("coach.send", { chat: chat.id, workspaces: scope.length });
    return send(chat.id, scope);
  }

  /** Leave the current chat; the next message starts a new one. */
  async newChat(by: Actor): Promise<void> {
    const chat = this.deps.agents.currentCoach();
    if (chat === null) return;
    if (busy(chat)) throw new UserError(BUSY, "CONFLICT");
    await this.deps.agents.update(chat.id, { archived: true }, by);
  }

  /** Make an earlier chat the current one. */
  async open(chatId: string, by: Actor): Promise<void> {
    const { agents } = this.deps;
    const target = agents.get(chatId);
    if (target === undefined || target.summary.role !== "coach")
      throw new UserError(`no Coach chat ${chatId}`, "NOT_FOUND");
    const chat = agents.currentCoach();
    if (chat?.id === chatId) return;
    if (chat !== null && busy(chat)) throw new UserError(BUSY, "CONFLICT");
    if (chat !== null) await agents.update(chat.id, { archived: true }, by);
    await agents.update(chatId, { archived: false }, by);
  }

  chats(): CoachChat[] {
    const current = this.deps.agents.currentCoach()?.id;
    return this.deps.agents
      .coachChats()
      .sort((a, b) => b.summary.lastActivityAt - a.summary.lastActivityAt)
      .slice(0, HISTORY_CHATS)
      .map((chat) => ({
        id: chat.id,
        title: chat.summary.title,
        runtime: chat.summary.runtime,
        createdAt: chat.summary.createdAt,
        updatedAt: chat.summary.lastActivityAt,
        messages: chat.summary.inputs,
        current: chat.id === current,
      }));
  }

  // ─── Runs ─────────────────────────────────────────────────────────────────

  /** How a Coach chat's run opens; nothing for other agents. */
  runOptions(
    agentId: string,
    runId: string,
  ): Pick<SessionOptions, "systemPrompt" | "disallowedTools" | "mcpServers"> {
    const { summary } = this.deps.agents.get(agentId) ?? {};
    if (summary?.role !== "coach") return {};
    return {
      systemPrompt: COACH_SYSTEM_PROMPT,
      disallowedTools: BUILTIN_TOOLS[summary.runtime] ?? [],
      mcpServers: [
        {
          name: COACH_MCP_SERVER,
          command: this.deps.cli,
          args: ["mcp", "coach"],
          env: { ROWROW_URL: this.deps.url(), ROWROW_TOKEN: this.deps.tokens.mint(agentId, runId) },
        },
      ],
    };
  }

  /** What the runtime reads for a message to Coach: the turn's workspaces, then the text. */
  promptText(agentId: string, inputId: string, text: string): string {
    if (this.deps.agents.get(agentId)?.summary.role !== "coach") return text;
    const entry = this.deps.log.findInput(agentId, inputId).input;
    const scope = entry?.kind === "input" ? (entry.scope ?? []) : [];
    return turnText(
      scope.map((id) => ({ workspaceId: id, label: this.deps.workspaces.get(id)?.label ?? id })),
      text,
    );
  }

  // ─── Coach's tools ────────────────────────────────────────────────────────

  /** The workspaces a chat's current turn may read (still registered). */
  private scopeOf(chatId: string): string[] {
    const chat = this.deps.agents.get(chatId);
    if (chat === undefined || chat.summary.role !== "coach")
      throw new UserError(`no Coach chat ${chatId}`, "NOT_FOUND");
    return (chat.summary.scope ?? []).filter((id) => this.deps.workspaces.get(id) !== undefined);
  }

  /** An agent this turn may read. Out of scope and unknown read the same: nothing leaks. */
  private agentIn(chatId: string, agentId: string): AgentState {
    const scope = this.scopeOf(chatId);
    const agent = this.deps.agents.get(agentId);
    if (agent === undefined || agent.summary.role !== "agent" || !scope.includes(agent.summary.workspaceId))
      throw new UserError(`Agent ${agentId} isn't in this turn's authorized workspaces.`, "FORBIDDEN");
    return agent;
  }

  agentsStatus(chatId: string, args: { workspaceId?: string | undefined }): AgentsStatusResult {
    const scope = this.scopeOf(chatId);
    if (args.workspaceId !== undefined && !scope.includes(args.workspaceId))
      throw new UserError(
        `Workspace ${args.workspaceId} isn't in this turn's authorized workspaces.`,
        "FORBIDDEN",
      );
    const wanted = args.workspaceId === undefined ? scope : [args.workspaceId];
    const now = Date.now();
    const agents = this.deps.agents
      .list()
      .filter((a) => !a.summary.archived && wanted.includes(a.summary.workspaceId))
      .sort(
        (a, b) =>
          ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
          b.summary.lastActivityAt - a.summary.lastActivityAt,
      );
    const listed = firstItems(agents);
    const workspaces = firstItems(wanted);
    let cut = listed.truncated || workspaces.truncated;
    const rows = listed.items.map((agent) => {
      const { summary } = agent;
      const outcome = summary.lastTurn?.outcome;
      const preview = clipText(summary.preview ?? "", MAX_MESSAGE_CHARS, "end");
      cut ||= preview.truncated;
      return {
        agentId: agent.id,
        title: summary.title,
        workspaceId: summary.workspaceId,
        runtime: summary.runtime,
        attention: agent.attention,
        state: statusDot(agent, now).label,
        lastTurn:
          summary.lastTurn === null || outcome === undefined
            ? null
            : {
                outcome: outcome.kind,
                ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}),
                at: new Date(summary.lastTurn.at).toISOString(),
              },
        preview: summary.preview === null ? null : preview.text,
        queued: summary.queued.length,
        backgroundCommands: summary.tasks.length,
        updatedAt: new Date(summary.lastActivityAt).toISOString(),
      };
    });
    return stamped(
      {
        workspaces: workspaces.items.map((id) => {
          const ws = this.deps.workspaces.get(id);
          return {
            workspaceId: id,
            label: ws?.label ?? id,
            path: ws?.path ?? "",
            branch: ws?.git?.branch ?? null,
          };
        }),
        agents: rows,
      },
      cut,
      now,
    );
  }

  agentHistory(
    chatId: string,
    args: { agentId: string; turns?: number | undefined; before?: number | undefined },
  ): AgentHistoryResult {
    const agent = this.agentIn(chatId, args.agentId);
    const window = this.deps.log.read(agent.id, {
      turns: args.turns ?? 3,
      ...(args.before === undefined ? {} : { before: args.before }),
    });
    const text = renderText(timelineOf(window.entries), {
      toolChars: 300,
      textChars: MAX_MESSAGE_CHARS,
    });
    // The end of a conversation matters most: past the limit, its start goes.
    const clipped = clipText(text, MAX_PAYLOAD_CHARS, "end");
    return stamped(
      {
        agentId: agent.id,
        title: agent.summary.title,
        workspaceId: agent.summary.workspaceId,
        text: clipped.text,
        before: window.hasMore ? window.firstSeq : null,
        historyWindow:
          "The latest turns as rowrow shows them; tool calls and their output are cut short. Pass `before` for older turns.",
      },
      clipped.truncated || text.includes(" characters cut]"),
    );
  }

  async agentChanges(
    chatId: string,
    args: { agentId: string; scope?: DiffScope | undefined; path?: string | undefined },
  ): Promise<AgentChangesResult> {
    const agent = this.agentIn(chatId, args.agentId);
    const scope = args.scope ?? "working";
    const workspaceId = agent.summary.workspaceId;
    const whose = scope === "turn" ? agent.id : undefined;
    const base = { agentId: agent.id, workspaceId, scope };
    if (args.path !== undefined) {
      const { patch, truncated } = await this.deps.git().diff(workspaceId, scope, args.path, whose);
      const diff = clipText(patch, MAX_PAYLOAD_CHARS);
      return stamped({ ...base, path: args.path, diff: diff.text }, truncated || diff.truncated);
    }
    const changes = await this.deps.git().changes(workspaceId, scope, whose);
    const files = firstItems(changes.files, MAX_ITEMS);
    return stamped(
      {
        ...base,
        base: changes.baseLabel ?? changes.base,
        files: files.items.map((file) => ({
          path: file.path,
          oldPath: file.oldPath,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          ...(file.staged === undefined ? {} : { staged: file.staged }),
          ...(file.unstaged === undefined ? {} : { unstaged: file.unstaged }),
        })),
        total: changes.files.length,
        note: changes.note,
      },
      files.truncated || changes.truncated,
    );
  }

  async agentBackground(chatId: string, args: { agentId: string }): Promise<AgentBackgroundResult> {
    const agent = this.agentIn(chatId, args.agentId);
    const tasks = firstItems(agent.summary.tasks);
    let cut = tasks.truncated;
    const commands = await Promise.all(
      tasks.items.map(async (task) => {
        const tail = task.outputFile === undefined ? null : await outputTail(task.outputFile);
        if (tail?.truncated === true) cut = true;
        return {
          taskId: task.taskId,
          type: task.taskType,
          description: task.description ?? null,
          status: task.status,
          startedAt: task.startedAt === undefined ? null : new Date(task.startedAt).toISOString(),
          summary: task.summary ?? null,
          error: task.error ?? null,
          outputTail: tail?.text ?? null,
        };
      }),
    );
    return stamped({ agentId: agent.id, commands }, cut);
  }
}

/** Working, or holding messages for after the turn. */
function busy(chat: AgentState): boolean {
  return chat.summary.status.kind === "running" || chat.summary.queued.length > 0;
}

/** The end of a background command's output file, as the runtime writes it; null when it can't be read. */
async function outputTail(file: string): Promise<{ text: string; truncated: boolean } | null> {
  try {
    // Only a file: never wait on a pipe or read a device.
    if (!(await fs.stat(file)).isFile()) return null;
    const handle = await fs.open(file, "r");
    try {
      const { size } = await handle.stat();
      // Enough bytes for the characters kept, even when they are 4 bytes each.
      const length = Math.min(size, MAX_MESSAGE_CHARS * 4);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const clipped = clipText(buffer.toString("utf8"), MAX_MESSAGE_CHARS, "end");
      return { text: clipped.text, truncated: clipped.truncated || size > length };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
