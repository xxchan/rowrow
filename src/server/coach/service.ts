// Coach (docs/decisions.md, D-044): rowrow's assistant. A chat is an agent with role "coach",
// so it has a log, runs, a transcript, stop, model and effort like any agent. What makes it
// Coach is here: what a message sends (the workspaces it may read, captured now and fixed for
// the turn), how its runs open (Coach's system prompt, the runtime's built-in tools off,
// rowrow's MCP server with a token for that run, and none of the user's own MCP servers,
// settings or CLAUDE.md), and the reads its tools make, each checked
// against the turn's workspaces and bounded like roamgate's (80 items, 8,000 characters a
// message, 32,000 a read). Its actions (D-045) live here too: a proposal is frozen in the
// chat's log and waits for your Confirm (or, with Full access, runs at once); each one runs
// alone, is recorded as executing before anything happens, and ends with rowrow's receipt.
import type { SessionOptions } from "@botiverse/oar";
import fs from "node:fs/promises";
import {
  ACTION_COPY,
  actionView,
  coachActionsOf,
  MAX_PROPOSALS_PER_TURN,
  receiptsFor,
  statusWord,
  type CoachActionState,
  type CoachActionView,
  type CoachProposal,
} from "../../shared/coach-actions.ts";
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
import type { AgentState, DiffScope, SendResult, Settings, Workspace } from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { timelineOf } from "../../shared/timeline.ts";
import type { AgentLog } from "../agents/log.ts";
import type { Runtimes } from "../agents/runtimes.ts";
import type { AgentService } from "../agents/service.ts";
import type { GitOps } from "../api/router.ts";
import { UserError } from "../errors.ts";
import type { SettingsService } from "../settings.ts";
import { log, serializeError, withContext } from "../telemetry/log.ts";
import type { Workspaces } from "../workspaces/service.ts";
import { execute, proposeAgent, proposePrompt, proposeWorktree, type Receipt } from "./actions.ts";
import { claudeSignIn } from "./claude-settings.ts";
import { coachSystemPrompt, turnText } from "./prompt.ts";
import type { CoachTokens } from "./tokens.ts";
import { BUILTIN_TOOLS, LAUNCH_ARGS, leakedTools } from "./tools.ts";

export interface CoachDeps {
  readonly agents: AgentService;
  readonly log: AgentLog;
  readonly workspaces: Workspaces;
  readonly settings: SettingsService;
  readonly runtimes: Runtimes;
  readonly git: () => Pick<GitOps, "changes" | "diff" | "createWorktree" | "worktreeSetup">;
  readonly tokens: CoachTokens;
  /** The `rowrow` launcher of this server's own CLI: Coach's MCP server is `rowrow mcp coach`. */
  readonly cli: string;
  /** Where the MCP server reaches this server. */
  readonly url: () => string;
  /** The user's claude settings file, whose sign-in Coach's claude keeps (claude-settings.ts). */
  readonly claudeSettings: string;
}

const HISTORY_CHATS = 200;
const BUSY = "Coach is still working on your last message: stop it, or wait for its answer.";
const EXECUTING = "Coach is executing an action you confirmed: wait for its result.";
const WAIT_TO_DECIDE = "Wait for Coach to finish before confirming or cancelling an action.";

/** Coach itself, as the author of what it proposes (and, with Full access, does). */
function coachActor(chatId: string): Actor {
  return { kind: "agent", agentId: chatId };
}

export class CoachService {
  private readonly deps: CoachDeps;
  /** coach.send, one at a time: a second one sees the first's chat. */
  private sending: Promise<unknown> = Promise.resolve();

  /** The action running now: one at a time, everywhere. */
  private executing: { readonly chatId: string; readonly actionId: string } | null = null;
  /** Full access runs its actions in the order Coach asks, one after another. */
  private acting: Promise<unknown> = Promise.resolve();
  /** Whether each live run opened with Full access: its prompt and tools say so. */
  private readonly runModes = new Map<string, boolean>();
  /** Coach's own settings change (a worktree you confirmed becomes readable) expires nothing. */
  private ownSettingsChange = false;

  constructor(deps: CoachDeps) {
    this.deps = deps;
    deps.log.onAppend((agentId, entry) => {
      // A run's token works as long as the run.
      if (entry.kind === "run.ended" || entry.kind === "run.failed") {
        deps.tokens.revoke(entry.runId);
        this.runModes.delete(entry.runId);
      }
      if (entry.kind === "oar") this.checkTools(agentId, entry);
    });
    let before = deps.settings.get().coach;
    deps.settings.onChange((keys) => {
      if (!keys.includes("coach")) return;
      const after = deps.settings.get().coach;
      if (!this.ownSettingsChange && narrowed(before, after)) this.expireCurrent(ACTION_COPY.configChanged);
      before = after;
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
    const send = async (chatId: string, scope: readonly string[], fullAccess = false) => ({
      chatId,
      ...(await agents.send(chatId, {
        inputId: input.inputId,
        text: input.text,
        mode: "auto",
        by: input.by,
        scope,
        ...(fullAccess ? { fullAccess: true as const } : {}),
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
    if (this.executing !== null) throw new UserError(EXECUTING, "CONFLICT");
    const runtime = this.deps.runtimes.info(settings.runtime);
    if (runtime === undefined || !runtime.installed)
      throw new UserError(
        `${runtime?.name ?? settings.runtime} isn't installed here: pick another runtime in Coach's settings.`,
        "PRECONDITION_FAILED",
      );
    // Captured now, fixed for the turn: what you allowed that still exists (with Full access,
    // every workspace; the turn may also use ones made while it runs).
    const scope = this.available(settings.fullAccess ? undefined : settings.workspaces);
    if (scope.length === 0)
      throw new UserError(
        settings.fullAccess
          ? "Add a workspace to rowrow first: Coach reads agents in workspaces."
          : "Choose the workspaces Coach may read in its settings first.",
        "PRECONDITION_FAILED",
      );
    if (chat !== null && busy(chat)) throw new UserError(BUSY, "CONFLICT");
    // A chat runs on one runtime: another one starts a new chat.
    if (chat !== null && chat.summary.runtime !== settings.runtime) {
      this.expire(chat.id, ACTION_COPY.left, input.by);
      await agents.update(chat.id, { archived: true }, input.by);
      chat = null;
    }
    // A new question replaces the previews of the last one.
    if (chat !== null) this.expire(chat.id, ACTION_COPY.replaced, input.by);
    // A run opened with the other permission mode has the other prompt and tools: start a new one.
    const live = chat?.summary.run?.runId;
    if (chat !== null && live !== undefined && this.runModes.get(live) !== settings.fullAccess)
      await agents.stop(chat.id, "restart");
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
    log.info("coach.send", { chat: chat.id, workspaces: scope.length, fullAccess: settings.fullAccess });
    return send(chat.id, scope, settings.fullAccess);
  }

  /** Leave the current chat; the next message starts a new one. */
  async newChat(by: Actor): Promise<void> {
    const chat = this.deps.agents.currentCoach();
    if (chat === null) return;
    if (busy(chat)) throw new UserError(BUSY, "CONFLICT");
    if (this.executing !== null) throw new UserError(EXECUTING, "CONFLICT");
    this.expire(chat.id, ACTION_COPY.left, by);
    await this.deps.agents.update(chat.id, { archived: true }, by);
  }

  /** Stop Coach's answer; its previews still waiting belonged to that question. */
  async stop(chatId: string, by: Actor): Promise<{ accepted: boolean; reason?: string }> {
    this.chat(chatId);
    this.expire(chatId, ACTION_COPY.stopped, by);
    return this.deps.agents.abort(chatId);
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
    if (this.executing !== null) throw new UserError(EXECUTING, "CONFLICT");
    if (chat !== null) {
      this.expire(chat.id, ACTION_COPY.left, by);
      await agents.update(chat.id, { archived: true }, by);
    }
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

  /**
   * How a Coach chat's run opens; nothing for other agents. Its `env` is the user's claude
   * settings' own, under the run's (the agent's environment wins).
   */
  async runOptions(
    agentId: string,
    runId: string,
  ): Promise<Pick<SessionOptions, "systemPrompt" | "disallowedTools" | "mcpServers" | "launchArgs" | "env">> {
    const { summary } = this.deps.agents.get(agentId) ?? {};
    if (summary?.role !== "coach") return {};
    // The message that opens the run is in the log already: its permission mode is the run's.
    const fullAccess = summary.fullAccess;
    this.runModes.set(runId, fullAccess);
    const signIn = summary.runtime === "claude" ? await claudeSignIn(this.deps.claudeSettings) : null;
    const launchArgs = [
      ...(LAUNCH_ARGS[summary.runtime] ?? []),
      ...(signIn === null || signIn.helpers === null ? [] : ["--settings", JSON.stringify(signIn.helpers)]),
    ];
    return {
      systemPrompt: coachSystemPrompt(fullAccess),
      disallowedTools: BUILTIN_TOOLS[summary.runtime] ?? [],
      ...(launchArgs.length === 0 ? {} : { launchArgs }),
      ...(signIn === null || Object.keys(signIn.env).length === 0 ? {} : { env: signIn.env }),
      mcpServers: [
        {
          name: COACH_MCP_SERVER,
          command: this.deps.cli,
          args: ["mcp", "coach"],
          env: {
            ROWROW_URL: this.deps.url(),
            ROWROW_TOKEN: this.deps.tokens.mint(agentId, runId),
            ...(fullAccess ? { ROWROW_COACH_FULL_ACCESS: "1" } : {}),
          },
        },
      ],
    };
  }

  /**
   * What the runtime reads for a message to Coach: the turn's workspaces, what became of its
   * latest actions there (rowrow's receipts: how the model learns what you confirmed), then the text.
   */
  promptText(agentId: string, inputId: string, text: string): string {
    if (this.deps.agents.get(agentId)?.summary.role !== "coach") return text;
    const entry = this.deps.log.findInput(agentId, inputId).input;
    const scope = entry?.kind === "input" ? (entry.scope ?? []) : [];
    return turnText(
      scope.map((id) => ({ workspaceId: id, label: this.deps.workspaces.get(id)?.label ?? id })),
      receiptsFor(this.actions(agentId), scope),
      text,
    );
  }

  // ─── Coach's tools ────────────────────────────────────────────────────────

  private chat(chatId: string): AgentState {
    const chat = this.deps.agents.get(chatId);
    if (chat === undefined || chat.summary.role !== "coach")
      throw new UserError(`no Coach chat ${chatId}`, "NOT_FOUND");
    return chat;
  }

  /**
   * The workspaces a chat's current turn may read and act on (still registered): those captured
   * when you sent it and, while Full access lasts, any made since.
   */
  private scopeOf(chatId: string): string[] {
    const chat = this.chat(chatId);
    const captured = (chat.summary.scope ?? []).filter((id) => this.deps.workspaces.get(id) !== undefined);
    if (!this.fullAccess(chat)) return captured;
    return [...new Set([...captured, ...this.available()])];
  }

  /** The workspaces (these ones, or all) that are there to read: not archived, not missing. */
  private available(ids?: readonly string[]): string[] {
    const all = ids ?? this.deps.workspaces.list().map((ws) => ws.id);
    return all.filter((id) => {
      const ws = this.deps.workspaces.get(id);
      return ws !== undefined && !this.deps.workspaces.archived(id) && !ws.missing;
    });
  }

  /** Its turn was sent with Full access, and you haven't turned it off since. */
  private fullAccess(chat: AgentState): boolean {
    return chat.summary.fullAccess && this.deps.settings.get().coach.fullAccess;
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
        runtimes: this.deps.runtimes
          .list()
          .filter((runtime) => runtime.installed)
          .map((runtime) => ({
            runtime: runtime.id,
            name: runtime.name,
            signedIn: runtime.auth === null ? null : runtime.auth.kind !== "logged_out",
          })),
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

  // ─── Actions (D-045) ──────────────────────────────────────────────────────

  /** A chat's actions as its log has them. */
  private actions(chatId: string): ReadonlyMap<string, CoachActionState> {
    return coachActionsOf(this.deps.log.ofKinds(chatId, ["coach.proposal", "coach.action"]));
  }

  private record(
    chatId: string,
    actionId: string,
    status: "executing" | "cancelled" | Receipt["status"],
    detail: string,
    by: Actor,
  ): void {
    withContext({ agent: chatId }, () => {
      this.deps.log.append(chatId, { kind: "coach.action", actionId, status, detail, by });
      log.info("coach.action", { action: actionId, status });
    });
  }

  /** Previews still waiting are cancelled, saying why; one that is running goes on. */
  private expire(chatId: string, detail: string, by: Actor): void {
    for (const action of this.deps.agents.get(chatId)?.summary.coachActions ?? [])
      if (action.status === "pending") this.record(chatId, action.proposal.id, "cancelled", detail, by);
  }

  private expireCurrent(detail: string): void {
    const chat = this.deps.agents.currentCoach();
    if (chat !== null) this.expire(chat.id, detail, { kind: "system" });
  }

  /**
   * After a restart: no preview outlives the server, and one that was running is never run
   * again; what it did is unknown, so it is uncertain.
   */
  recover(): void {
    for (const chat of this.deps.agents.coachChats())
      for (const action of chat.summary.coachActions)
        if (action.status === "executing")
          this.record(chat.id, action.proposal.id, "uncertain", ACTION_COPY.restartedExecuting, {
            kind: "system",
          });
        else this.record(chat.id, action.proposal.id, "cancelled", ACTION_COPY.restarted, { kind: "system" });
  }

  /** Coach's tool propose_worktree_create. */
  async proposeWorktree(
    chatId: string,
    args: { workspaceId: string; branch: string },
    by: Actor,
  ): Promise<CoachActionView> {
    const ws = this.workspaceIn(chatId, args.workspaceId);
    return this.propose(chatId, await proposeWorktree(this.actionDeps(), ws, args), by);
  }

  /** Coach's tool propose_agent_start. */
  async proposeAgent(
    chatId: string,
    args: { workspaceId: string; runtime: string; prompt: string; title?: string | undefined },
    by: Actor,
  ): Promise<CoachActionView> {
    const ws = this.workspaceIn(chatId, args.workspaceId);
    return this.propose(chatId, proposeAgent(this.actionDeps(), ws, args), by);
  }

  /** Coach's tool propose_agent_prompt. */
  async proposePrompt(
    chatId: string,
    args: { agentId: string; prompt: string },
    by: Actor,
  ): Promise<CoachActionView> {
    const agent = this.agentIn(chatId, args.agentId);
    if (agent.summary.archived)
      throw new UserError(`Agent ${agent.id} is archived: it takes no messages.`, "PRECONDITION_FAILED");
    const ws = this.workspaceIn(chatId, agent.summary.workspaceId);
    return this.propose(chatId, proposePrompt(agent, ws, args), by);
  }

  /** A workspace this turn may act on. Out of scope and unknown read the same. */
  private workspaceIn(chatId: string, workspaceId: string): Workspace {
    const ws = this.deps.workspaces.get(workspaceId);
    if (
      ws === undefined ||
      this.deps.workspaces.archived(workspaceId) ||
      ws.missing ||
      !this.scopeOf(chatId).includes(workspaceId)
    )
      throw new UserError(
        `Workspace ${workspaceId} isn't in this turn's authorized workspaces.`,
        "FORBIDDEN",
      );
    return ws;
  }

  /** Freeze a proposal in the chat's log: pending, or with Full access, run at once. */
  private async propose(chatId: string, proposal: CoachProposal, by: Actor): Promise<CoachActionView> {
    const chat = this.chat(chatId);
    if (this.proposedThisTurn(chatId) >= MAX_PROPOSALS_PER_TURN)
      throw new UserError(
        `This turn already has ${MAX_PROPOSALS_PER_TURN} action previews.`,
        "PRECONDITION_FAILED",
      );
    withContext({ agent: chatId }, () => {
      this.deps.log.append(chatId, { kind: "coach.proposal", proposal, by });
      log.info("coach.proposal", { action: proposal.id, kind: proposal.kind, ws: proposal.workspaceId });
    });
    if (!this.fullAccess(chat)) return this.view(chatId, proposal.id);
    // In the order Coach asked, one at a time; turning Full access off meanwhile leaves it pending.
    const run = this.acting.then(async () =>
      this.fullAccess(this.chat(chatId))
        ? this.run(chatId, proposal.id, coachActor(chatId))
        : this.view(chatId, proposal.id),
    );
    this.acting = run.catch(() => undefined);
    return run;
  }

  /** Proposals since the message that started this turn. */
  private proposedThisTurn(chatId: string): number {
    const entries = this.deps.log.ofKinds(chatId, ["input", "coach.proposal"]);
    const turn = entries.findLastIndex((entry) => entry.kind === "input");
    return entries.slice(turn + 1).length;
  }

  private view(chatId: string, actionId: string): CoachActionView {
    const action = this.actions(chatId).get(actionId);
    if (action === undefined) throw new UserError(`no action ${actionId} in this chat`, "NOT_FOUND");
    return actionView(action);
  }

  /** Your Confirm on a card: run it exactly as shown, once. */
  async confirm(chatId: string, actionId: string, by: Actor): Promise<CoachActionView> {
    this.decidable(chatId, actionId);
    if (this.executing !== null)
      throw new UserError("Another action is executing: wait for its result.", "CONFLICT");
    return this.run(chatId, actionId, by);
  }

  /** Your Cancel on a card: nothing runs. */
  cancel(chatId: string, actionId: string, by: Actor): CoachActionView {
    this.decidable(chatId, actionId);
    this.record(chatId, actionId, "cancelled", ACTION_COPY.cancelled, by);
    return this.view(chatId, actionId);
  }

  /** A pending action you may decide on now: not while Coach answers. */
  private decidable(chatId: string, actionId: string): CoachActionState {
    const chat = this.chat(chatId);
    const action = this.actions(chatId).get(actionId);
    if (action === undefined) throw new UserError(`no action ${actionId} in this chat`, "NOT_FOUND");
    if (action.status !== "pending")
      throw new UserError(
        `This action is ${statusWord(action.proposal.kind, action.status).toLowerCase()} already: it never runs twice.`,
        "CONFLICT",
      );
    if (busy(chat)) throw new UserError(WAIT_TO_DECIDE, "CONFLICT");
    return action;
  }

  /**
   * Run an action: its target checked again, `executing` recorded before anything happens,
   * then the receipt. A worktree you confirmed becomes one Coach may read.
   */
  private async run(chatId: string, actionId: string, by: Actor): Promise<CoachActionView> {
    const action = this.actions(chatId).get(actionId);
    if (action?.status !== "pending")
      throw new UserError(`Action ${actionId} isn't waiting to run.`, "CONFLICT");
    const { proposal } = action;
    if (!this.targetAllowed(proposal)) {
      this.record(chatId, actionId, "cancelled", ACTION_COPY.unavailable, by);
      return this.view(chatId, actionId);
    }
    this.executing = { chatId, actionId };
    this.record(chatId, actionId, "executing", ACTION_COPY.executing, by);
    let receipt: Receipt;
    try {
      receipt = await withContext({ agent: chatId }, () => execute(this.actionDeps(), proposal, by));
    } catch (error) {
      log.error("coach.action_failed", { action: actionId, err: serializeError(error) });
      receipt = {
        status: "uncertain",
        detail: `rowrow couldn't tell what happened (${error instanceof Error ? error.message : String(error)}). Check the target before proposing it again.`,
      };
    } finally {
      this.executing = null;
    }
    this.record(chatId, actionId, receipt.status, receipt.detail, by);
    if (receipt.workspaceId !== undefined) this.allow(receipt.workspaceId);
    return this.view(chatId, actionId);
  }

  /** The target is still there, and still one Coach may act on. */
  private targetAllowed(proposal: CoachProposal): boolean {
    const settings = this.deps.settings.get().coach;
    const ws = this.deps.workspaces.get(proposal.workspaceId);
    if (ws === undefined || this.deps.workspaces.archived(ws.id) || ws.missing) return false;
    if (!settings.fullAccess && !settings.workspaces.includes(ws.id)) return false;
    if (proposal.agentId === undefined) return true;
    const agent = this.deps.agents.get(proposal.agentId);
    return (
      agent !== undefined &&
      agent.summary.role === "agent" &&
      !agent.summary.archived &&
      agent.summary.workspaceId === ws.id
    );
  }

  /** A worktree made from an allowed workspace may be read too, from your next message. */
  private allow(workspaceId: string): void {
    const coach = this.deps.settings.get().coach;
    if (coach.fullAccess || coach.workspaces.includes(workspaceId)) return;
    this.ownSettingsChange = true;
    try {
      this.deps.settings.update({ coach: { ...coach, workspaces: [...coach.workspaces, workspaceId] } });
    } finally {
      this.ownSettingsChange = false;
    }
  }

  private actionDeps() {
    return {
      agents: this.deps.agents,
      log: this.deps.log,
      workspaces: this.deps.workspaces,
      runtimes: this.deps.runtimes,
      git: this.deps.git,
    };
  }
}

/** Coach may read less, or act differently: previews made under the old settings go. */
function narrowed(before: Settings["coach"], after: Settings["coach"]): boolean {
  return (
    before.fullAccess !== after.fullAccess ||
    before.runtime !== after.runtime ||
    before.workspaces.some((id) => !after.workspaces.includes(id))
  );
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
