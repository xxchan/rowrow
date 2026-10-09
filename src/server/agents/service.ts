// Agents: creation, the actors that run them, and their summaries (docs/architecture.md).
// The service folds every appended entry into that agent's summary, derives attention
// against your seen marker, and publishes both to AppState: at once when something you
// would notice changed (status, attention, a request, a run), otherwise at most once a
// second (the preview and activity time while text streams). Coach's chats (D-044) are agents
// too, with role "coach": they run in their own directory, and are published as AppState's
// `coach.chat` rather than among the agents, so no list, count or notification sees them.
import fs from "node:fs";
import type { Actor, Attachment, Entry, RunEndReason } from "../../shared/entries.ts";
import { newId } from "../../shared/ids.ts";
import type { AgentState, SendResult } from "../../shared/schemas.ts";
import {
  attentionOf,
  initialSummary,
  reduceSummary,
  summaryOf,
  type AgentSummary,
  type Attention,
} from "../../shared/summary.ts";
import type { StateStore } from "../state/store.ts";
import type { Db } from "../store/db.ts";
import { notFound, UserError } from "../errors.ts";
import { log, withContext } from "../telemetry/log.ts";
import type { Workspaces } from "../workspaces/service.ts";
import { AgentActor, waiting, type ActorDeps, type SendInput } from "./actor.ts";
import type { AgentLog } from "./log.ts";
import type { Runtimes } from "./runtimes.ts";

interface Agent {
  readonly id: string;
  readonly actor: AgentActor;
  summary: AgentSummary;
  seenSeq: number;
  attention: Attention;
  /** When you pinned it (D-046): kept beside the seen marker, not in the log. */
  pinnedAt: number | null;
  /** When the summary was last copied into AppState. */
  publishedAt: number;
  publishTimer: NodeJS.Timeout | null;
}

export interface AttentionChange {
  readonly agentId: string;
  readonly from: Attention;
  readonly to: Attention;
  readonly summary: AgentSummary;
  /** The entry that caused the change. */
  readonly entry: Entry | null;
}

export interface AgentServiceDeps {
  readonly db: Db;
  readonly log: AgentLog;
  readonly state: StateStore;
  readonly runtimes: Runtimes;
  readonly workspaces: Workspaces;
  readonly idleTimeoutMs: number;
  /** Tests: how long a stop waits behind stuck work (the actor's STOP_WAIT_MS otherwise). */
  readonly stopWaitMs?: number;
  readonly env: (agentId: string) => Record<string, string>;
  /** A turn is about to start / has ended: snapshot the workspace ("last turn" diffs, git). */
  readonly turnStarted?: (workspaceId: string, agentId: string) => Promise<void>;
  readonly turnEnded?: (agentId: string) => Promise<void>;
  /** Where Coach's chats run: a directory of their own (created when one starts). */
  readonly coachDir: string;
  /** Coach's session options and the framing of its prompts (the actor's hooks). */
  readonly runOptions?: ActorDeps["runOptions"];
  readonly promptText?: ActorDeps["promptText"];
}

const PUBLISH_EVERY_MS = 1000;

export class AgentService {
  private readonly agents = new Map<string, Agent>();
  private readonly attentionListeners = new Set<(change: AttentionChange) => void>();
  private readonly deps: AgentServiceDeps;

  constructor(deps: AgentServiceDeps) {
    this.deps = deps;
    deps.log.onAppend((agentId, entry) => this.onEntry(agentId, entry));
  }

  /** Load every agent: fold its log, and close any run the last server left open (it crashed). */
  load(): void {
    const rows = this.deps.db.all<{ id: string; seen_seq: number; pinned_at: number | null }>(
      "select id, seen_seq, pinned_at from agents order by created_at",
    );
    for (const row of rows) {
      const summary = summaryOf(this.deps.log.iterate(row.id));
      this.register(row.id, summary, row.seen_seq, row.pinned_at);
      // Inputs held when the last server went away wait for you, not for a turn nobody asked for.
      if (waiting(summary))
        withContext({ agent: row.id }, () =>
          this.deps.log.append(row.id, { kind: "queue.paused", reason: "restarted" }),
        );
      if (summary.run !== null) {
        withContext({ agent: row.id }, () => {
          log.warn("agent.run.crashed", { run: summary.run?.runId });
          this.deps.log.append(row.id, {
            kind: "run.ended",
            runId: summary.run?.runId ?? "",
            reason: "crashed",
          });
        });
      }
    }
    log.info("agents.loaded", { count: rows.length });
  }

  private register(
    id: string,
    summary: AgentSummary,
    seenSeq: number,
    pinnedAt: number | null = null,
  ): Agent {
    const actor = new AgentActor(id, {
      log: this.deps.log,
      runtimes: this.deps.runtimes,
      summary: (agentId) => this.require(agentId).summary,
      cwd: (agentId) => {
        const { summary: s } = this.require(agentId);
        if (s.role === "coach") {
          fs.mkdirSync(this.deps.coachDir, { recursive: true, mode: 0o700 });
          return this.deps.coachDir;
        }
        const ws = this.deps.workspaces.get(s.workspaceId);
        return ws === undefined || ws.missing ? null : ws.path;
      },
      env: this.deps.env,
      idleTimeoutMs: this.deps.idleTimeoutMs,
      ...(this.deps.stopWaitMs === undefined ? {} : { stopWaitMs: this.deps.stopWaitMs }),
      beforeTurn: async (agentId) => this.beforeTurn(agentId),
      ...(this.deps.runOptions === undefined ? {} : { runOptions: this.deps.runOptions }),
      ...(this.deps.promptText === undefined ? {} : { promptText: this.deps.promptText }),
    });
    const agent: Agent = {
      id,
      actor,
      summary,
      seenSeq,
      attention: attentionOf(summary, seenSeq),
      pinnedAt,
      publishedAt: 0,
      publishTimer: null,
    };
    this.agents.set(id, agent);
    this.publish(agent);
    return agent;
  }

  private require(id: string): Agent {
    const agent = this.agents.get(id);
    if (agent === undefined) throw notFound(`agent ${id}`);
    return agent;
  }

  get(id: string): AgentState | undefined {
    const agent = this.agents.get(id);
    return agent === undefined ? undefined : stateOf(agent);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  /** Every agent, Coach's chats aside. */
  list(): AgentState[] {
    return [...this.agents.values()].filter((a) => a.summary.role !== "coach").map(stateOf);
  }

  /** Coach's chats, oldest first. */
  coachChats(): AgentState[] {
    return [...this.agents.values()].filter((a) => a.summary.role === "coach").map(stateOf);
  }

  /** Coach's current chat: the newest one not archived (leaving a chat archives it). */
  currentCoach(): AgentState | null {
    const agent = this.currentCoachAgent();
    return agent === undefined ? null : stateOf(agent);
  }

  private currentCoachAgent(): Agent | undefined {
    let current: Agent | undefined;
    for (const agent of this.agents.values()) {
      const { summary } = agent;
      if (summary.role !== "coach" || summary.archived) continue;
      if (current === undefined || summary.createdAt >= current.summary.createdAt) current = agent;
    }
    return current;
  }

  summary(id: string): AgentSummary {
    return this.require(id).summary;
  }

  liveRuns(): { agentId: string; runId: string; runtime: string; since: number; status: string }[] {
    const runs = [];
    for (const agent of this.agents.values()) {
      const { run, runtime, status } = agent.summary;
      if (run !== null)
        runs.push({ agentId: agent.id, runId: run.runId, runtime, since: run.since, status: status.kind });
    }
    return runs;
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  create(input: {
    workspaceId: string;
    runtime: string;
    model?: string;
    effort?: string;
    serviceTier?: string;
    title?: string;
    by: Actor;
  }): AgentState {
    const ws = this.deps.workspaces.require(input.workspaceId);
    if (this.deps.workspaces.archived(ws.id))
      throw new UserError(
        `${ws.label} is archived: unarchive the workspace to start an agent there`,
        "PRECONDITION_FAILED",
      );
    if (this.deps.runtimes.info(input.runtime) === undefined)
      throw new UserError(`unknown runtime "${input.runtime}"`);
    if (input.serviceTier !== undefined) this.takesServiceTier(input.runtime);
    const id = newId("ag");
    const now = Date.now();
    this.deps.db.run("insert into agents (id, workspace_id, created_at) values (?, ?, ?)", id, ws.id, now);
    const agent = this.register(id, initialSummary(), -1);
    withContext({ agent: id, ws: ws.id }, () => {
      this.deps.log.append(id, {
        kind: "agent.created",
        workspaceId: ws.id,
        runtime: input.runtime,
        by: input.by,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
        ...(input.title === undefined ? {} : { title: input.title }),
      });
      log.info("agent.created", {
        runtime: input.runtime,
        model: input.model,
        effort: input.effort,
        serviceTier: input.serviceTier,
      });
    });
    return stateOf(agent);
  }

  /**
   * A Coach chat (D-044): an agent in no workspace, on a runtime that can be Coach. A scheduled
   * task's run (D-050) starts archived: it waits in History rather than taking the place of the
   * chat you're having, until you open it.
   */
  createCoach(input: {
    runtime: string;
    model?: string;
    effort?: string;
    by: Actor;
    task?: { taskId: string; runId: string; title: string };
  }): AgentState {
    if (this.deps.runtimes.info(input.runtime) === undefined)
      throw new UserError(`unknown runtime "${input.runtime}"`);
    const id = newId("ag");
    this.deps.db.run(
      "insert into agents (id, workspace_id, created_at) values (?, ?, ?)",
      id,
      "",
      Date.now(),
    );
    // Known as Coach's from the start, so it is never published among the agents.
    const agent = this.register(id, { ...initialSummary(), role: "coach" }, -1);
    const { task } = input;
    withContext({ agent: id }, () => {
      this.deps.log.append(id, {
        kind: "agent.created",
        workspaceId: "",
        role: "coach",
        runtime: input.runtime,
        by: input.by,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(task === undefined
          ? {}
          : { task: { taskId: task.taskId, runId: task.runId }, title: task.title }),
      });
      if (task !== undefined)
        this.deps.log.append(id, { kind: "agent.updated", changes: { archived: true }, by: input.by });
      log.info("coach.chat.created", {
        runtime: input.runtime,
        model: input.model,
        effort: input.effort,
        ...(task === undefined ? {} : { task: task.taskId }),
      });
    });
    return stateOf(agent);
  }

  /** A scheduled task's prompt to its run's chat (D-050), which is archived until you open it. */
  sendTaskRun(agentId: string, input: SendInput): Promise<SendResult> {
    const agent = this.require(agentId);
    if (agent.summary.role !== "coach" || agent.summary.task === null)
      throw new UserError(`${agentId} isn't a Coach task's run`, "PRECONDITION_FAILED");
    return agent.actor.send(input);
  }

  /**
   * Forget a Coach task's run (D-050): its chat, log included, as Ranger forgets a task's older
   * runs. Only for one that's over: its run is stopped first.
   */
  async forget(agentId: string): Promise<void> {
    const agent = this.require(agentId);
    if (agent.summary.role !== "coach" || agent.summary.task === null)
      throw new UserError(`${agentId} isn't a Coach task's run`, "PRECONDITION_FAILED");
    await agent.actor.close("archived");
    if (agent.publishTimer !== null) clearTimeout(agent.publishTimer);
    this.agents.delete(agentId);
    this.deps.db.transaction(() => {
      this.deps.db.run("delete from agents where id = ?", agentId);
      this.deps.log.forget(agentId);
    });
    log.info("coach.chat.forgotten", { agent: agentId, task: agent.summary.task.taskId });
    this.publish(agent);
  }

  async send(agentId: string, input: SendInput): Promise<SendResult> {
    const agent = this.require(agentId);
    this.refuseArchived(agent);
    if (agent.summary.title === null && agent.summary.inputs === 0) {
      this.deps.log.append(agentId, {
        kind: "agent.updated",
        changes: {
          title: titleFrom(input.text.trim() === "" ? (input.attachments?.[0]?.name ?? "") : input.text),
        },
        by: { kind: "system" },
      });
    }
    return agent.actor.send(input);
  }

  /** Nothing is sent to an archived agent, or to one in an archived workspace (D-047). */
  private refuseArchived(agent: Agent): void {
    if (agent.summary.archived)
      throw new UserError("this agent is archived; unarchive it to send", "PRECONDITION_FAILED");
    const { workspaceId } = agent.summary;
    if (agent.summary.role !== "coach" && this.deps.workspaces.archived(workspaceId))
      throw new UserError(
        `its workspace, ${this.deps.workspaces.get(workspaceId)?.label ?? workspaceId}, is archived: unarchive the workspace to send`,
        "PRECONDITION_FAILED",
      );
  }

  /** Take a held input back (D-035). */
  withdraw(
    agentId: string,
    inputId: string,
    by: Actor,
  ): Promise<{ text: string; attachments: readonly Attachment[] }> {
    return this.require(agentId).actor.withdraw(inputId, by);
  }

  /** Send a held input now: steered into the running turn, or as the next turn. */
  sendNow(agentId: string, inputId: string): Promise<SendResult> {
    const agent = this.require(agentId);
    this.refuseArchived(agent);
    return agent.actor.sendNow(inputId);
  }

  /** Send held inputs again after a pause. */
  resume(agentId: string, by: Actor): Promise<void> {
    const agent = this.require(agentId);
    this.refuseArchived(agent);
    return agent.actor.resume(by);
  }

  abort(agentId: string): Promise<{ accepted: boolean; reason?: string }> {
    return this.require(agentId).actor.abort();
  }

  stop(agentId: string, reason: RunEndReason = "stopped"): Promise<void> {
    return this.require(agentId).actor.stop(reason);
  }

  /** `reason`: why, when the change follows from something else (its workspace was removed). */
  async update(
    agentId: string,
    changes: {
      title?: string | null;
      model?: string | null;
      effort?: string | null;
      serviceTier?: string | null;
      archived?: boolean;
      pinned?: boolean;
    },
    by: Actor,
    reason?: string,
  ): Promise<AgentState> {
    const agent = this.require(agentId);
    const s = agent.summary;
    if (changes.serviceTier !== undefined && changes.serviceTier !== null) this.takesServiceTier(s.runtime);
    // A pin keeps an agent in sight, so it can't also be archived (roamgate's pinned tabs can't close).
    if (changes.pinned === true && s.role === "coach")
      throw new UserError("Coach's chats aren't in the agent lists, so they can't be pinned");
    if ((changes.pinned ?? agent.pinnedAt !== null) && (changes.archived ?? s.archived))
      throw new UserError(
        changes.pinned === true
          ? "this agent is archived; unarchive it to pin it"
          : "this agent is pinned; unpin it before archiving it",
        "PRECONDITION_FAILED",
      );
    if (changes.pinned !== undefined && changes.pinned !== (agent.pinnedAt !== null)) {
      agent.pinnedAt = changes.pinned ? Date.now() : null;
      this.deps.db.run("update agents set pinned_at = ? where id = ?", agent.pinnedAt, agentId);
      log.info("agent.pinned", { agent: agentId, pinned: changes.pinned });
      this.publish(agent);
    }
    const effective = {
      ...(changes.title === undefined || changes.title === s.title ? {} : { title: changes.title }),
      ...(changes.model === undefined || changes.model === s.model ? {} : { model: changes.model }),
      ...(changes.effort === undefined || changes.effort === s.effort ? {} : { effort: changes.effort }),
      ...(changes.serviceTier === undefined || changes.serviceTier === s.serviceTier
        ? {}
        : { serviceTier: changes.serviceTier }),
      ...(changes.archived === undefined || changes.archived === s.archived
        ? {}
        : { archived: changes.archived }),
    };
    if (Object.keys(effective).length > 0)
      this.deps.log.append(agentId, {
        kind: "agent.updated",
        changes: effective,
        by,
        ...(reason === undefined ? {} : { reason }),
      });
    // A new model, effort or tier takes effect in a new run, resuming the conversation on the next input.
    if (
      effective.model !== undefined ||
      effective.effort !== undefined ||
      effective.serviceTier !== undefined
    )
      await agent.actor.stop("restart");
    if (effective.archived === true) await agent.actor.stop("archived");
    return stateOf(agent);
  }

  /** Refuse a tier for a runtime that can't take one now, rather than fail its next run. */
  private takesServiceTier(runtime: string): void {
    const refusal = this.deps.runtimes.refusal(runtime, "serviceTier");
    if (refusal !== null)
      throw new UserError(
        `${this.deps.runtimes.info(runtime)?.name ?? runtime} has no Fast mode or other service tier, so leave serviceTier out (${refusal})`,
      );
  }

  markSeen(agentId: string, seq: number): void {
    const agent = this.require(agentId);
    const seen = Math.min(seq, agent.summary.headSeq);
    if (seen <= agent.seenSeq) return;
    agent.seenSeq = seen;
    this.deps.db.run("update agents set seen_seq = ? where id = ?", seen, agentId);
    this.refreshAttention(agent, null);
    this.publish(agent);
  }

  /**
   * Resolve when the agent's attention is one of `until`, reached after log position
   * `afterSeq` (-1: any time). "Reached after" matters: waiting on the input you just sent
   * must not be satisfied by an earlier turn you haven't looked at yet.
   */
  wait(
    agentId: string,
    until: readonly Attention[],
    afterSeq: number,
    timeoutMs: number,
  ): Promise<{ agent: AgentState; timedOut: boolean }> {
    const agent = this.require(agentId);
    const satisfied = (): boolean =>
      until.includes(agent.attention) && reachedAfter(agent.summary, agent.attention, afterSeq);
    if (satisfied()) return Promise.resolve({ agent: stateOf(agent), timedOut: false });
    return new Promise((resolve) => {
      const finish = (timedOut: boolean): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve({ agent: stateOf(agent), timedOut });
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      const unsubscribe = this.deps.log.onAppend((id) => {
        if (id === agentId && satisfied()) finish(false);
      });
    });
  }

  /** Snapshot the workspace before this agent's turn starts, so "last turn" shows what the turn changed. */
  private async beforeTurn(agentId: string): Promise<void> {
    const { summary } = this.require(agentId);
    if (summary.role === "coach") return; // no workspace to snapshot
    await this.deps.turnStarted?.(summary.workspaceId, agentId);
  }

  /** Stop the live runs of every agent in a workspace (its checkout is about to go away, or it was archived). */
  async stopAllIn(workspaceId: string, reason: RunEndReason = "stopped"): Promise<void> {
    await Promise.all(
      [...this.agents.values()]
        .filter((a) => a.summary.workspaceId === workspaceId && a.summary.role !== "coach")
        .map(async (a) => a.actor.stop(reason)),
    );
  }

  onAttention(listener: (change: AttentionChange) => void): () => void {
    this.attentionListeners.add(listener);
    return () => this.attentionListeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.agents.values()].map(async (agent) => agent.actor.close("shutdown")));
  }

  // ─── Folding ──────────────────────────────────────────────────────────────

  private onEntry(agentId: string, entry: Entry): void {
    const agent = this.agents.get(agentId);
    if (agent === undefined) return;
    const before = agent.summary;
    agent.summary = reduceSummary(before, entry);
    this.refreshAttention(agent, entry);
    agent.actor.noteActivity(agent.summary);
    if (noticeable(before, agent.summary)) this.publish(agent);
    else this.publishLater(agent);
    if (entry.kind === "oar" && agent.summary.lastTurn?.seq === entry.seq && agent.summary.role !== "coach") {
      // A turn ended: snapshot its end, and its files probably changed.
      void this.deps.turnEnded?.(agentId);
      this.deps.workspaces.refreshSoon(agent.summary.workspaceId);
    }
  }

  private refreshAttention(agent: Agent, entry: Entry | null): void {
    const next = attentionOf(agent.summary, agent.seenSeq);
    if (next === agent.attention) return;
    const change: AttentionChange = {
      agentId: agent.id,
      from: agent.attention,
      to: next,
      summary: agent.summary,
      entry,
    };
    agent.attention = next;
    // Coach's chats tell you nothing: you're looking at them when they answer.
    if (agent.summary.role === "coach") return;
    log.info("agent.attention", { agent: agent.id, from: change.from, to: change.to });
    for (const listener of this.attentionListeners) {
      try {
        listener(change);
      } catch (error) {
        log.error("agent.attention_listener_failed", { agent: agent.id, err: error });
      }
    }
  }

  private publish(agent: Agent): void {
    if (agent.publishTimer !== null) {
      clearTimeout(agent.publishTimer);
      agent.publishTimer = null;
    }
    agent.publishedAt = Date.now();
    if (agent.summary.role === "coach") {
      const current = this.currentCoachAgent();
      const chat = current === undefined ? null : stateOf(current);
      this.deps.state.update("coach.chat", (draft) => {
        draft.coach.chat = chat as never;
      });
      return;
    }
    const state = stateOf(agent);
    this.deps.state.update("agents.summary", (draft) => {
      draft.agents[agent.id] = state as never;
    });
  }

  private publishLater(agent: Agent): void {
    if (agent.publishTimer !== null) return;
    const wait = Math.max(0, PUBLISH_EVERY_MS - (Date.now() - agent.publishedAt));
    agent.publishTimer = setTimeout(() => {
      agent.publishTimer = null;
      this.publish(agent);
    }, wait);
    agent.publishTimer.unref();
  }
}

/** Whether the agent got into `attention` after log position `afterSeq`. */
function reachedAfter(s: AgentSummary, attention: Attention, afterSeq: number): boolean {
  if (afterSeq < 0) return true;
  switch (attention) {
    case "blocked":
      return s.pending.some((p) => p.seq > afterSeq);
    case "done":
      return s.lastCompletionSeq > afterSeq;
    case "idle":
      return Math.max(s.lastTurn?.seq ?? -1, s.lastCompletionSeq) > afterSeq;
    case "working":
      return true;
  }
}

function stateOf(agent: Agent): AgentState {
  return {
    id: agent.id,
    summary: agent.summary,
    seenSeq: agent.seenSeq,
    attention: agent.attention,
    pinnedAt: agent.pinnedAt,
  };
}

/** Changes a person would notice right away in a list; everything else can wait a second. */
function noticeable(a: AgentSummary, b: AgentSummary): boolean {
  return (
    a.status.kind !== b.status.kind ||
    phaseKey(a) !== phaseKey(b) ||
    a.pending.length !== b.pending.length ||
    a.run?.runId !== b.run?.runId ||
    a.lastCompletionSeq !== b.lastCompletionSeq ||
    a.lastError !== b.lastError ||
    a.lastNotification !== b.lastNotification ||
    a.title !== b.title ||
    a.model !== b.model ||
    a.effort !== b.effort ||
    a.serviceTier !== b.serviceTier ||
    a.archived !== b.archived ||
    a.inputs !== b.inputs ||
    a.queued !== b.queued ||
    a.queuePaused !== b.queuePaused ||
    a.steering !== b.steering ||
    a.unread !== b.unread
  );
}

function phaseKey(s: AgentSummary): string {
  if (s.status.kind !== "running") return "";
  const { phase } = s.status;
  return typeof phase === "string" ? phase : `tool:${phase.tool}`;
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Untitled";
}
