// Coach's actions (D-045): proposals freeze what Confirm runs, an action runs once and ends with
// rowrow's receipt, previews expire when their question does, the model hears receipts on its
// next message, and Full access (only when you turn it on) runs proposals at once.
import type { Runtime, SessionOptions } from "@botiverse/oar";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client as CliClient } from "../src/cli/client.ts";
import { answer } from "../src/cli/mcp.ts";
import { COACH_TOOLS, coachToolDescription } from "../src/shared/coach.ts";
import {
  ACTION_COPY,
  coachActionsOf,
  openAction,
  receiptsFor,
  statusWord,
  type CoachProposal,
} from "../src/shared/coach-actions.ts";
import type { Entry } from "../src/shared/entries.ts";
import { newInputId } from "../src/shared/ids.ts";
import { placeProposals, timelineOf } from "../src/shared/timeline.ts";
import { scriptedDemoRuntime } from "../src/server/agents/scripted.ts";
import { coachSystemPrompt, turnText } from "../src/server/coach/prompt.ts";
import { CoachService, type CoachDeps } from "../src/server/coach/service.ts";
import { eventually, startTestServer, type Client, type TestServer } from "./helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const device = { kind: "device", deviceId: "d1", name: "Laptop" } as const;

function proposal(id: string, workspaceId = "ws_a"): CoachProposal {
  return {
    id,
    kind: "send_prompt",
    workspaceId,
    workspaceLabel: "a",
    agentId: "ag_1",
    agentTitle: "helper",
    params: { prompt: "run the tests" },
    summary: "Send the exact displayed prompt to this agent.",
  };
}

function logOf(...bodies: Record<string, unknown>[]): Entry[] {
  return bodies.map((body, seq) => ({ seq, at: Date.UTC(2026, 9, 9, 12, 0, seq), ...body }) as Entry);
}

describe("Coach's actions, folded", () => {
  it("are pending when proposed, then what their entries say", () => {
    const folded = coachActionsOf(
      logOf(
        { kind: "coach.proposal", proposal: proposal("p1"), by: { kind: "agent", agentId: "ag_chat" } },
        { kind: "coach.proposal", proposal: proposal("p2"), by: { kind: "agent", agentId: "ag_chat" } },
        {
          kind: "coach.action",
          actionId: "p1",
          status: "executing",
          detail: ACTION_COPY.executing,
          by: device,
        },
        { kind: "coach.action", actionId: "p1", status: "uncertain", detail: "unknown", by: device },
        // An outcome of nothing known changes nothing.
        { kind: "coach.action", actionId: "p9", status: "succeeded", detail: "x", by: device },
      ),
    );
    expect([...folded.keys()]).toEqual(["p1", "p2"]);
    expect(folded.get("p2")).toMatchObject({ status: "pending", detail: ACTION_COPY.pending });
    expect(folded.get("p1")).toMatchObject({ status: "uncertain", detail: "unknown", by: device });
    expect(openAction(folded.get("p2") ?? (undefined as never))).toBe(true);
    expect(openAction(folded.get("p1") ?? (undefined as never))).toBe(false);
    expect(ACTION_COPY.pending).toBe("Waiting for your confirmation. Nothing has been executed.");
    // A message whose delivery isn't known is "Unverified", as roamgate says it.
    expect(statusWord("send_prompt", "uncertain")).toBe("Unverified");
    expect(statusWord("create_worktree", "uncertain")).toBe("Outcome uncertain");
    expect(statusWord("start_agent", "pending")).toBe("Needs confirmation");
  });

  it("reach the model as the latest receipts in its scope", () => {
    const actions = coachActionsOf(
      logOf(
        ...Array.from({ length: 10 }, (_, i) => ({
          kind: "coach.proposal",
          proposal: proposal(`p${i}`),
          by: device,
        })),
        { kind: "coach.proposal", proposal: proposal("elsewhere", "ws_b"), by: device },
        { kind: "coach.action", actionId: "p9", status: "succeeded", detail: "sent", by: device },
      ),
    );
    const receipts = receiptsFor(actions, ["ws_a"]);
    expect(receipts.map((r) => r.id)).toEqual(["p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
    expect(receipts.at(-1)).toEqual({
      id: "p9",
      kind: "send_prompt",
      workspaceId: "ws_a",
      workspaceLabel: "a",
      agentId: "ag_1",
      agentTitle: "helper",
      params: { prompt: "run the tests" },
      summary: "Send the exact displayed prompt to this agent.",
      status: "succeeded",
      detail: "sent",
      proposedAt: "2026-10-09T12:00:09.000Z",
    });
    expect(
      turnText([{ workspaceId: "ws_a", label: "a" }], receipts.slice(-1), "and now?").split("\n\n")[1],
    ).toBe(
      `Recorded operation outcomes (server receipts, not proof of task completion):\n${JSON.stringify(receipts.slice(-1))}`,
    );
  });

  it("say what they do, with or without Full access", () => {
    const manual = coachSystemPrompt(false);
    expect(manual).toContain("Proposal tools only record a pending proposal.");
    expect(manual).toContain("Never claim that a pending proposal was executed or succeeded.");
    expect(manual).not.toContain("Full access");
    const full = coachSystemPrompt(true);
    expect(full).toContain("Never automatically repeat an uncertain operation");
    expect(full).toContain("a pending receipt means nothing was executed");
    const worktree = COACH_TOOLS.find((tool) => tool.name === "propose_worktree_create");
    const status = COACH_TOOLS.find((tool) => tool.name === "agents_status");
    if (worktree === undefined || status === undefined) throw new Error("missing tools");
    expect(coachToolDescription(worktree, false)).toBe(worktree.description);
    expect(coachToolDescription(worktree, true)).toBe(
      "Execute creating a Git worktree from an authorized source workspace. Use workspace and agent identifiers from agents_status. Returns an execution receipt: succeeded is verified, uncertain must be inspected before any retry, and pending requires manual confirmation. Read agents_status after creating a worktree or starting an agent to discover the new workspace or agent.",
    );
    expect(coachToolDescription(status, true)).toBe(status.description);
  });

  it("are never run again after a restart: waiting ones are cancelled, a running one is uncertain", () => {
    const appended: unknown[] = [];
    const action = (id: string, status: "pending" | "executing") => ({
      proposal: proposal(id),
      status,
      detail: "",
      by: device,
      proposedAt: 0,
      updatedAt: 0,
    });
    const service = new CoachService({
      agents: {
        coachChats: () => [
          { id: "ag_chat", summary: { coachActions: [action("p1", "pending"), action("p2", "executing")] } },
        ],
      },
      log: {
        onAppend: () => undefined,
        append: (agentId: string, body: unknown) => appended.push({ agentId, ...(body as object) }),
      },
      settings: { get: () => ({ coach: { workspaces: [] } }), onChange: () => undefined },
    } as unknown as CoachDeps);
    service.recover();
    expect(appended).toEqual([
      {
        agentId: "ag_chat",
        kind: "coach.action",
        actionId: "p1",
        status: "cancelled",
        detail: ACTION_COPY.restarted,
        by: { kind: "system" },
      },
      {
        agentId: "ag_chat",
        kind: "coach.action",
        actionId: "p2",
        status: "uncertain",
        detail: ACTION_COPY.restartedExecuting,
        by: { kind: "system" },
      },
    ]);
  });
});

describe("rowrow mcp coach's proposals", () => {
  const call = (name: string, args: unknown) =>
    ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as const;

  it("lists them, as executing with Full access, and calls the proposal", async () => {
    const list = async (fullAccess: boolean) =>
      (
        (await answer({} as CliClient, "1", { jsonrpc: "2.0", id: 1, method: "tools/list" }, fullAccess)) as {
          result: { tools: { name: string; description: string }[] };
        }
      ).result.tools.find((tool) => tool.name === "propose_agent_prompt")?.description;
    expect(await list(false)).toMatch(/^Propose sending a prompt .* does not send it\.$/);
    expect(await list(true)).toMatch(/^Execute sending a prompt .* Returns an execution receipt/);

    const calls: unknown[] = [];
    const client = {
      coach: {
        proposePrompt: async (args: unknown) => {
          calls.push(args);
          return { id: "p1", status: "pending" };
        },
        proposeWorktree: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as CliClient;
    const ok = await answer(client, "1", call("propose_agent_prompt", { agentId: "ag_1", prompt: "hi" }));
    expect(ok).toEqual({ result: { content: [{ type: "text", text: '{"id":"p1","status":"pending"}' }] } });
    expect(calls).toEqual([{ agentId: "ag_1", prompt: "hi" }]);
    expect(
      await answer(client, "1", call("propose_agent_prompt", { agentId: "ag_1", prompt: "" })),
    ).toMatchObject({ result: { isError: true } });
    // What went wrong inside rowrow stays out of the model's context.
    expect(
      await answer(client, "1", call("propose_worktree_create", { workspaceId: "ws_1", branch: "x" })),
    ).toEqual({
      result: {
        content: [
          { type: "text", text: "Action proposal unavailable, stale, or outside the authorized scope." },
        ],
        isError: true,
      },
    });
  });
});

// ─── The server ───────────────────────────────────────────────────────────────

function spyRuntime(): { runtime: Runtime; opened: SessionOptions[] } {
  const base = scriptedDemoRuntime();
  const opened: SessionOptions[] = [];
  return {
    opened,
    runtime: {
      ...base,
      session: async (installation, options) => {
        opened.push(options);
        return base.session(installation, options);
      },
    },
  };
}

/** Send Coach a message and wait for its answer; the token its run's MCP server holds. */
async function ask(
  server: TestServer,
  spy: { opened: SessionOptions[] },
  text: string,
): Promise<{ chatId: string; as: Client }> {
  const sent = await server.client.coach.send({ inputId: newInputId(), text });
  expect(sent.landed).toBe("prompted");
  const waited = await server.client.agents.wait({
    agentId: sent.chatId,
    afterSeq: sent.seq,
    timeoutMs: 15_000,
  });
  expect(waited.timedOut).toBe(false);
  const mcp = spy.opened.at(-1)?.mcpServers?.[0];
  const token = mcp !== undefined && "env" in mcp ? (mcp.env?.["ROWROW_TOKEN"] ?? "") : "";
  const as = createORPCClient<Client>(
    new RPCLink({ url: `${server.server.url}/rpc`, headers: { authorization: `Bearer ${token}` } }),
  );
  return { chatId: sent.chatId, as };
}

async function actionsOf(server: TestServer, chatId: string) {
  return coachActionsOf((await server.client.agents.entries({ agentId: chatId, full: true })).entries);
}

async function inputsOf(server: TestServer, agentId: string) {
  return (await server.client.agents.entries({ agentId, full: true })).entries.flatMap((entry) =>
    entry.kind === "input" ? [entry] : [],
  );
}

async function setUp(spy: { runtime: Runtime }) {
  t = await startTestServer({ extraRuntimes: [spy.runtime] });
  const a = await t.client.workspaces.add({ path: t.repo("a") });
  const b = await t.client.workspaces.add({ path: t.repo("b") });
  const inA = (await t.client.agents.create({ workspaceId: a.id, runtime: "scripted", title: "in a" })).agent;
  const inB = (await t.client.agents.create({ workspaceId: b.id, runtime: "scripted", title: "in b" })).agent;
  const coach = { workspaces: [a.id], runtime: "scripted", model: null, effort: null, fullAccess: false };
  await t.client.settings.update({ coach });
  return { server: t, a, b, inA, inB, coach };
}

describe("Coach's actions", () => {
  it("send a message only when you confirm it, exactly once, and tell Coach what happened", async () => {
    const spy = spyRuntime();
    const { server, inA, inB } = await setUp(spy);
    const { chatId, as } = await ask(server, spy, "/echo looking");

    const proposed = await as.coach.proposePrompt({ agentId: inA.id, prompt: "/echo from Coach" });
    expect(proposed).toMatchObject({
      kind: "send_prompt",
      agentId: inA.id,
      agentTitle: "in a",
      params: { prompt: "/echo from Coach" },
      status: "pending",
      detail: "Waiting for your confirmation. Nothing has been executed.",
    });
    expect(await inputsOf(server, inA.id)).toEqual([]);
    // Every window sees it waiting.
    await eventually(async () =>
      (await server.client.state.get()).state.coach.chat?.summary.coachActions[0]?.status === "pending"
        ? true
        : undefined,
    );
    // On the card, after the answer that made it.
    const { entries } = await server.client.agents.entries({ agentId: chatId, full: true });
    const run = timelineOf(entries).blocks.findLast((block) => block.kind === "run");
    if (run?.kind !== "run") throw new Error("no run");
    expect(placeProposals(run).get(run.view.messages.at(-1)?.id ?? null)).toEqual([proposed.id]);
    expect((await server.client.agents.view({ agentId: chatId })).text).toMatch(
      /· Coach proposed: Send prompt \(in a in \S+\) · Needs confirmation: Waiting for your confirmation\./,
    );

    // Coach can't confirm, nor reach past its turn's workspaces or rowrow's runtimes.
    await expect(as.coach.confirm({ chatId, actionId: proposed.id })).rejects.toThrow(
      "Coach can only read and propose",
    );
    await expect(as.coach.proposePrompt({ agentId: inB.id, prompt: "/echo hi" })).rejects.toThrow(
      "isn't in this turn's",
    );
    await expect(
      as.coach.proposeAgent({ workspaceId: inA.summary.workspaceId, runtime: "nope", prompt: "/echo hi" }),
    ).rejects.toThrow('no runtime "nope"');

    const done = await server.client.coach.confirm({ chatId, actionId: proposed.id });
    expect(done.status).toBe("succeeded");
    expect(done.detail).toBe(`in a (${inA.id}) took the exact prompt and started a turn.`);
    const sent = await inputsOf(server, inA.id);
    expect(sent.map((entry) => [entry.inputId, entry.text, entry.by])).toEqual([
      [proposed.id, "/echo from Coach", expect.objectContaining({ kind: "device" })],
    ]);
    // It never runs twice.
    await expect(server.client.coach.confirm({ chatId, actionId: proposed.id })).rejects.toThrow(
      "never runs twice",
    );
    await expect(server.client.coach.cancel({ chatId, actionId: proposed.id })).rejects.toThrow(
      "never runs twice",
    );
    expect((await inputsOf(server, inA.id)).length).toBe(1);
    const statuses = (await server.client.agents.entries({ agentId: chatId, full: true })).entries.flatMap(
      (e) => (e.kind === "coach.action" ? [e.status] : []),
    );
    expect(statuses).toEqual(["executing", "succeeded"]);

    // Coach learns it from rowrow's receipt with its next message.
    await ask(server, spy, "/echo did it work?");
    const raw = JSON.stringify((await server.client.agents.entries({ agentId: chatId, full: true })).entries);
    expect(raw).toContain("Recorded operation outcomes (server receipts, not proof of task completion)");
    expect(raw).toContain(`\\"id\\":\\"${proposed.id}\\"`);
    expect(raw).toContain(`\\"status\\":\\"succeeded\\"`);
  }, 30_000);

  it("expire with their question: a new one, a stop, narrower settings, a restart", async () => {
    const spy = spyRuntime();
    const { server, a, inA, coach } = await setUp(spy);
    let { chatId, as } = await ask(server, spy, "/echo looking");
    const propose = () => as.coach.proposePrompt({ agentId: inA.id, prompt: "/echo hi" });
    const detail = async (id: string) => (await actionsOf(server, chatId)).get(id)?.detail;

    const cancelled = await propose();
    expect(await server.client.coach.cancel({ chatId, actionId: cancelled.id })).toMatchObject({
      status: "cancelled",
      detail: "Cancelled. Nothing was executed.",
    });
    const replaced = await propose();
    await ask(server, spy, "/echo something else");
    expect(await detail(replaced.id)).toBe(ACTION_COPY.replaced);

    // Not while Coach answers: you confirm what it proposed once it's done.
    const busy = await server.client.coach.send({ inputId: newInputId(), text: "/sleep 5000" });
    const during = await propose();
    await expect(server.client.coach.confirm({ chatId, actionId: during.id })).rejects.toThrow(
      "Wait for Coach to finish",
    );
    await server.client.coach.stop({ chatId: busy.chatId });
    expect(await detail(during.id)).toBe(ACTION_COPY.stopped);
    await server.client.agents.wait({ agentId: chatId, afterSeq: busy.seq, timeoutMs: 15_000 });

    ({ chatId, as } = await ask(server, spy, "/echo again"));
    const narrowed = await propose();
    await server.client.settings.update({ coach: { ...coach, model: "x" } });
    expect((await actionsOf(server, chatId)).get(narrowed.id)?.status).toBe("pending");
    await server.client.settings.update({ coach: { ...coach, workspaces: [] } });
    expect(await detail(narrowed.id)).toBe(ACTION_COPY.configChanged);

    await server.client.settings.update({ coach: { ...coach, workspaces: [a.id] } });
    ({ as } = await ask(server, spy, "/echo once more"));
    const restarted = await propose();
    t = await server.restart();
    expect((await actionsOf(t, chatId)).get(restarted.id)).toMatchObject({
      status: "cancelled",
      detail: ACTION_COPY.restarted,
    });
    expect(await inputsOf(t, inA.id)).toEqual([]);
  }, 40_000);

  it("make a worktree with the setup hook shown, then start an agent in it", async () => {
    const spy = spyRuntime();
    const { server, a } = await setUp(spy);
    fs.writeFileSync(
      path.join(a.path, "rowrow.json"),
      JSON.stringify({ worktree: { setup: "echo ok > ready" } }),
    );
    const { chatId, as } = await ask(server, spy, "/echo looking");

    const worktree = await as.coach.proposeWorktree({ workspaceId: a.id, branch: "coach/feature" });
    expect(worktree.params).toEqual({
      branch: "coach/feature",
      base: "Latest origin default branch (fetched at confirmation)",
      setupHook: "echo ok > ready",
      sourcePath: a.path,
    });
    const made = await server.client.coach.confirm({ chatId, actionId: worktree.id });
    expect(made.status).toBe("succeeded");
    expect(made.detail).toMatch(
      /^Created worktree .* on new branch coach\/feature at .*\. Its setup hook ran and succeeded\.$/,
    );
    const { state } = await server.client.state.get();
    const ws = Object.values(state.workspaces).find((w) => w.git?.branch === "coach/feature");
    if (ws === undefined) throw new Error("no worktree");
    expect(fs.readFileSync(path.join(ws.path, "ready"), "utf8")).toBe("ok\n");
    // You confirmed it from a workspace Coach may read: it may read this one too, from your next message.
    expect(state.settings.coach.workspaces).toEqual([a.id, ws.id]);

    // The same branch again is refused; a hook that changed since the card doesn't run.
    const taken = await as.coach.proposeWorktree({ workspaceId: a.id, branch: "coach/feature" });
    expect(await server.client.coach.confirm({ chatId, actionId: taken.id })).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/^No worktree was created: .*already exists/) as unknown,
    });
    const changed = await as.coach.proposeWorktree({ workspaceId: a.id, branch: "coach/other" });
    fs.writeFileSync(
      path.join(a.path, "rowrow.json"),
      JSON.stringify({ worktree: { setup: "echo surprise" } }),
    );
    const other = await server.client.coach.confirm({ chatId, actionId: changed.id });
    expect(other.status).toBe("succeeded");
    expect(other.detail).toContain("isn't the one shown (echo ok > ready), so it didn't run.");

    const { as: next } = await ask(server, spy, "/echo now start one there");
    const start = await next.coach.proposeAgent({
      workspaceId: ws.id,
      runtime: "scripted",
      prompt: "/echo hello from Coach",
      title: "helper",
    });
    expect(start.params).toEqual({
      runtime: "scripted",
      runtimeName: expect.any(String) as unknown,
      title: "helper",
      prompt: "/echo hello from Coach",
    });
    const started = await server.client.coach.confirm({ chatId, actionId: start.id });
    expect(started.status).toBe("succeeded");
    const agent = Object.values((await server.client.state.get()).state.agents).find(
      (x) => x.summary.title === "helper",
    );
    if (agent === undefined) throw new Error("no agent");
    expect(agent.summary.workspaceId).toBe(ws.id);
    expect((await inputsOf(server, agent.id)).map((entry) => [entry.inputId, entry.text])).toEqual([
      [start.id, "/echo hello from Coach"],
    ]);
  }, 40_000);

  it("run at once with Full access, which reads every workspace, until you turn it off", async () => {
    const spy = spyRuntime();
    const { server, a, b, inB, coach } = await setUp(spy);
    await server.client.settings.update({ coach: { ...coach, workspaces: [], fullAccess: true } });
    const { chatId, as } = await ask(server, spy, "/echo looking everywhere");
    const opened = spy.opened.at(-1);
    expect(opened?.systemPrompt).toBe(coachSystemPrompt(true));
    const mcp = opened?.mcpServers?.[0];
    expect(mcp !== undefined && "env" in mcp ? mcp.env?.["ROWROW_COACH_FULL_ACCESS"] : undefined).toBe("1");
    expect((await as.coach.agentsStatus({})).workspaces.map((ws) => ws.workspaceId).sort()).toEqual(
      [a.id, b.id].sort(),
    );

    const ran = await as.coach.proposePrompt({ agentId: inB.id, prompt: "/echo without asking" });
    expect(ran.status).toBe("succeeded");
    expect((await inputsOf(server, inB.id)).map((entry) => [entry.inputId, entry.by])).toEqual([
      [ran.id, { kind: "agent", agentId: chatId }],
    ]);

    // Turned off, even mid-turn: a proposal waits for you again.
    await server.client.settings.update({ coach: { ...coach, workspaces: [], fullAccess: false } });
    expect((await as.coach.proposePrompt({ agentId: inB.id, prompt: "/echo hi" })).status).toBe("pending");
    await expect(server.client.coach.send({ inputId: newInputId(), text: "/echo hi" })).rejects.toThrow(
      "Choose the workspaces",
    );
    // The next message runs with the manual prompt and tools: a new run.
    await server.client.settings.update({ coach: { ...coach, workspaces: [b.id] } });
    const runs = spy.opened.length;
    await ask(server, spy, "/echo back to asking");
    expect(spy.opened.length).toBe(runs + 1);
    expect(spy.opened.at(-1)?.systemPrompt).toBe(coachSystemPrompt(false));
  }, 40_000);
});
