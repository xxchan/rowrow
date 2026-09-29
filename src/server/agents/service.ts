// Agents: creation, the actors that run them, and their summaries (docs/architecture.md).
// The service folds every appended entry into that agent's summary, derives attention
// against your seen marker, and publishes both to AppState: at once when something you
// would notice changed (status, attention, a request, a run), otherwise at most once a
// second (the preview and activity time while text streams).
import type { Actor, Entry, RunEndReason } from "../../shared/entries.ts";
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
import { AgentActor, type SendInput } from "./actor.ts";
import type { AgentLog } from "./log.ts";
import type { Runtimes } from "./runtimes.ts";

interface Agent {
  readonly id: string;
  readonly actor: AgentActor;
  summary: AgentSummary;
  seenSeq: number;
  attention: Attention;
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
  readonly env: (agentId: string) => Record<string, string>;
  /** Take the "last turn" baseline of a workspace (git). */
  readonly snapshotTurn?: (workspaceId: string, agentId: string) => Promise<void>;
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
    const rows = this.deps.db.all<{ id: string; seen_seq: number }>(
      "select id, seen_seq from agents order by created_at",
    );
    for (const row of rows) {
      const summary = summaryOf(this.deps.log.iterate(row.id));
      this.register(row.id, summary, row.seen_seq);
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

  private register(id: string, summary: AgentSummary, seenSeq: number): Agent {
    const actor = new AgentActor(id, {
      log: this.deps.log,
      runtimes: this.deps.runtimes,
      summary: (agentId) => this.require(agentId).summary,
      cwd: (agentId) => {
        const ws = this.deps.workspaces.get(this.require(agentId).summary.workspaceId);
        return ws === undefined || ws.missing ? null : ws.path;
      },
      env: this.deps.env,
      idleTimeoutMs: this.deps.idleTimeoutMs,
      beforeTurn: async (agentId) => this.beforeTurn(agentId),
    });
    const agent: Agent = {
      id,
      actor,
      summary,
      seenSeq,
      attention: attentionOf(summary, seenSeq),
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

  list(): AgentState[] {
    return [...this.agents.values()].map(stateOf);
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
    title?: string;
    by: Actor;
  }): AgentState {
    const ws = this.deps.workspaces.require(input.workspaceId);
    if (this.deps.runtimes.info(input.runtime) === undefined)
      throw new UserError(`unknown runtime "${input.runtime}"`);
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
        ...(input.title === undefined ? {} : { title: input.title }),
      });
      log.info("agent.created", { runtime: input.runtime, model: input.model, effort: input.effort });
    });
    return stateOf(agent);
  }

  async send(agentId: string, input: SendInput): Promise<SendResult> {
    const agent = this.require(agentId);
    if (agent.summary.archived)
      throw new UserError("this agent is archived; unarchive it to send", "PRECONDITION_FAILED");
    if (agent.summary.title === null && agent.summary.inputs === 0) {
      this.deps.log.append(agentId, {
        kind: "agent.updated",
        changes: { title: titleFrom(input.text) },
        by: { kind: "system" },
      });
    }
    return agent.actor.send(input);
  }

  abort(agentId: string): Promise<{ accepted: boolean; reason?: string }> {
    return this.require(agentId).actor.abort();
  }

  stop(agentId: string, reason: RunEndReason = "stopped"): Promise<void> {
    return this.require(agentId).actor.stop(reason);
  }

  async update(
    agentId: string,
    changes: { title?: string | null; model?: string | null; effort?: string | null; archived?: boolean },
    by: Actor,
  ): Promise<AgentState> {
    const agent = this.require(agentId);
    const s = agent.summary;
    const effective = {
      ...(changes.title === undefined || changes.title === s.title ? {} : { title: changes.title }),
      ...(changes.model === undefined || changes.model === s.model ? {} : { model: changes.model }),
      ...(changes.effort === undefined || changes.effort === s.effort ? {} : { effort: changes.effort }),
      ...(changes.archived === undefined || changes.archived === s.archived
        ? {}
        : { archived: changes.archived }),
    };
    if (Object.keys(effective).length > 0)
      this.deps.log.append(agentId, { kind: "agent.updated", changes: effective, by });
    // A new model or effort takes effect in a new run, resuming the conversation on the next input.
    if (effective.model !== undefined || effective.effort !== undefined) await agent.actor.stop("restart");
    if (effective.archived === true) await agent.actor.stop("archived");
    return stateOf(agent);
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

  /** A workspace goes from quiet to active: snapshot it, so "last turn" shows what this activity changed. */
  private async beforeTurn(agentId: string): Promise<void> {
    const { workspaceId } = this.require(agentId).summary;
    const othersWorking = [...this.agents.values()].some(
      (a) => a.id !== agentId && a.summary.workspaceId === workspaceId && a.summary.status.kind === "running",
    );
    if (!othersWorking) await this.deps.snapshotTurn?.(workspaceId, agentId);
  }

  /** Stop the live runs of every agent in a workspace (its checkout is about to go away). */
  async stopAllIn(workspaceId: string): Promise<void> {
    await Promise.all(
      [...this.agents.values()]
        .filter((a) => a.summary.workspaceId === workspaceId)
        .map(async (a) => a.actor.stop("stopped")),
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
    if (entry.kind === "oar" && agent.summary.lastTurn?.seq === entry.seq) {
      // A turn ended: its files probably changed.
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
  return { id: agent.id, summary: agent.summary, seenSeq: agent.seenSeq, attention: agent.attention };
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
    a.title !== b.title ||
    a.model !== b.model ||
    a.effort !== b.effort ||
    a.archived !== b.archived ||
    a.inputs !== b.inputs
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
