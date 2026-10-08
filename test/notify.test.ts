// Notifications an agent sends you itself (notify.send, `rowrow notify`): where they show in
// the transcript (the fold), and on a real server how they're logged, delivered whether or not
// anyone is looking at the agent, deduplicated across restarts and limited.
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import { renderText } from "../src/shared/render-text.ts";
import { summaryOf } from "../src/shared/summary.ts";
import { timelineOf } from "../src/shared/timeline.ts";
import { TranscriptProjector, type TranscriptItem } from "../src/shared/transcript-model.ts";
import { NOTICE_LIMITS, noticeLimit } from "../src/server/notify/notifier.ts";
import { eventually, input, startTestServer, type Client, type TestServer } from "./helpers.ts";

// ─── The fold ────────────────────────────────────────────────────────────────

let seq = 0;
const entry = (body: unknown): Entry => ({ ...(body as EntryBody), seq: seq++, at: 1000 + seq });
const notified = (title: string, body = ""): Entry =>
  entry({ kind: "notification.sent", title, body, by: { kind: "agent", agentId: "ag_1" } });

describe("the fold", () => {
  const log = (): Entry[] => [
    entry({ kind: "agent.created", workspaceId: "w1", runtime: "pi", by: { kind: "system" } }),
    notified("Build is red", "3 checks failed on main"),
    notified("Look at this one"),
  ];

  it("shows a notification sent with no run live as a line of its own", () => {
    const timeline = timelineOf(log());
    expect(timeline.blocks.map((block) => block.kind)).toEqual(["notice", "notice"]);
    expect(renderText(timeline)).toBe(
      "· notified you: Build is red · 3 checks failed on main (agent ag_1)\n· notified you: Look at this one (agent ag_1)\n",
    );
    const items = new TranscriptProjector("pi")
      .update(timeline)
      .items.map((json) => JSON.parse(json) as TranscriptItem);
    expect(items.map((item) => (item.kind === "notice" ? item.text : item.kind))).toEqual([
      "Notified you: Build is red",
      "Notified you: Look at this one",
    ]);
  });

  it("keeps the latest in the summary, for clients to show as it arrives", () => {
    const summary = summaryOf(log());
    expect(summary.lastNotification).toMatchObject({ title: "Look at this one", body: "" });
    expect(summary.lastNotification?.seq).toBe(summary.headSeq);
  });
});

describe("the limits", () => {
  const minute = 60_000;

  it("allows one every 10 s", () => {
    expect(noticeLimit([], 0)).toBeNull();
    expect(noticeLimit([1000], 5000)).toMatch(/sent one 4 s ago.*Try again in 6 s/);
    expect(noticeLimit([1000], 1000 + NOTICE_LIMITS.burstMs)).toBeNull();
  });

  it("and 30 an hour, saying when the next one may go", () => {
    const sent = Array.from({ length: 30 }, (_, i) => i * 2 * minute);
    const now = 59 * minute;
    expect(noticeLimit(sent.slice(1), now)).toBeNull();
    expect(noticeLimit(sent, now)).toMatch(/sent 30 in the last hour.*Try again in 1 min/);
    // The oldest ages out of the hour: one more may go.
    expect(noticeLimit(sent, 60 * minute + 1)).toBeNull();
  });
});

// ─── On a server ─────────────────────────────────────────────────────────────

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A client that calls as the agent does: the agents' token, and its id (ROWROW_AGENT_ID). */
function asAgent(server: TestServer, agentId: string): Client {
  return createORPCClient<Client>(
    new RPCLink({
      url: `${server.server.url}/rpc`,
      headers: { authorization: `Bearer ${server.server.agentToken}`, "x-rowrow-agent": agentId },
    }),
  );
}

async function agentIn(server: TestServer, text?: string) {
  const ws = await server.client.workspaces.add({ path: server.repo() });
  return server.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "watcher",
    ...(text === undefined ? {} : { input: input(text) }),
  });
}

describe("notify.send", () => {
  it("logs it as the agent's, and sends it even to someone looking at that agent", async () => {
    t = await startTestServer();
    const { agent, sent } = await agentIn(t, "/echo watching");
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    // A browser has the agent on screen; another device (here the CLI's) holds notify.watch.
    const browser = await t.websocket();
    await browser.client.presence.update({
      route: `/a/${agent.id}`,
      agentId: agent.id,
      visible: true,
      focused: true,
    });
    const watch = (await t.client.notify.watch())[Symbol.asyncIterator]();
    expect((await watch.next()).value).toMatchObject({ kind: "badge" });

    const result = await asAgent(t, agent.id).notify.send({
      title: "Build is red",
      body: "3 checks failed on main",
    });
    expect(result.sent).toBe(true);
    expect((await watch.next()).value).toEqual({
      kind: "alert",
      agentId: agent.id,
      attention: "notice",
      title: "Build is red",
      subtitle: "watcher",
      body: "3 checks failed on main",
      url: `/a/${agent.id}`,
      seq: result.seq,
      badge: 1,
    });
    await watch.return?.();
    browser.close();

    const { entries } = await t.client.agents.entries({ agentId: agent.id, after: result.seq - 1 });
    expect(entries[0]).toMatchObject({
      kind: "notification.sent",
      seq: result.seq,
      title: "Build is red",
      by: { kind: "agent", agentId: agent.id },
    });
    const { state } = await t.client.state.get();
    expect(state.agents[agent.id]?.summary.lastNotification).toMatchObject({
      seq: result.seq,
      title: "Build is red",
    });
    // It isn't attention: the agent stays as it was.
    expect(state.agents[agent.id]?.attention).toBe("done");
    const view = await t.client.agents.view({ agentId: agent.id });
    expect(view.text).toContain("· notified you: Build is red · 3 checks failed on main");
  });

  it("shows in the transcript where it was sent: after that turn, or after the run", async () => {
    const server = await startTestServer();
    t = server;
    const { agent, sent } = await agentIn(server, '/run 1500 rowrow notify "Build is red"');
    // While the tool call runs, as `rowrow notify` would from inside it.
    await eventually(async () => {
      const { state } = await server.client.state.get();
      return state.agents[agent.id]?.summary.status.kind === "running" ? true : undefined;
    });
    const notice = await asAgent(server, agent.id).notify.send({ title: "Build is red" });
    await server.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const next = await server.client.agents.send({
      agentId: agent.id,
      ...input("/echo still red"),
      mode: "auto",
    });
    await server.client.agents.wait({ agentId: agent.id, afterSeq: next.seq, timeoutMs: 5000 });

    const { text } = await server.client.agents.view({ agentId: agent.id });
    const order = ["✓ turn completed", "· notified you: Build is red", "> [local CLI] /echo still red"];
    const at = order.map((line) => text.indexOf(line));
    expect(
      at.every((i) => i !== -1),
      text,
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The iOS app's items, in the same place: after the first turn's outcome, before the next input.
    const { entries } = await server.client.agents.entries({ agentId: agent.id, after: -1 });
    const delta = new TranscriptProjector("scripted").update(timelineOf(entries));
    const items = delta.items.map((json) => JSON.parse(json) as TranscriptItem);
    const ids = delta.order ?? [];
    const noted = ids.indexOf(`notice:${notice.seq}`);
    expect(items.find((item) => item.id === `notice:${notice.seq}`)).toMatchObject({
      kind: "notice",
      text: "Notified you: Build is red",
      turn: null,
    });
    const firstOutcome = ids.indexOf(items.find((item) => item.kind === "outcome")?.id ?? "");
    const secondInput = ids.indexOf(items.filter((item) => item.kind === "input")[1]?.id ?? "");
    expect(firstOutcome).toBeGreaterThan(-1);
    expect(firstOutcome).toBeLessThan(noted);
    expect(noted).toBeLessThan(secondInput);

    // About an agent whose run has ended: after that run.
    const other = await agentIn(server, "/echo hi");
    await server.client.agents.wait({
      agentId: other.agent.id,
      afterSeq: other.sent?.seq ?? -1,
      timeoutMs: 5000,
    });
    await server.client.agents.stop({ agentId: other.agent.id });
    await server.client.notify.send({ agentId: other.agent.id, title: "Look at this one" });
    const after = (await server.client.agents.view({ agentId: other.agent.id })).text;
    expect(after.indexOf("· notified you: Look at this one")).toBeGreaterThan(after.indexOf("run ended"));
  });

  it("needs to know which agent it's about, outside an agent", async () => {
    t = await startTestServer();
    const { agent } = await agentIn(t);
    await expect(t.client.notify.send({ title: "Hello" })).rejects.toThrow(/Say which agent/);
    await expect(t.client.notify.send({ agentId: "ag_nope", title: "Hello" })).rejects.toThrow(/not found/);
    await expect(t.client.notify.send({ agentId: agent.id, title: "  " })).rejects.toThrow();
    const sent = await t.client.notify.send({ agentId: agent.id, title: "About it" });
    const { entries } = await t.client.agents.entries({ agentId: agent.id, after: sent.seq - 1 });
    expect(entries[0]).toMatchObject({ by: { kind: "device", name: "local CLI" } });
  });

  it("sends a dedupKey once, across a restart", async () => {
    t = await startTestServer();
    const { agent } = await agentIn(t);
    const first = await asAgent(t, agent.id).notify.send({ title: "Deploy failed", dedupKey: "deploy-abc" });
    const again = await asAgent(t, agent.id).notify.send({ title: "Deploy failed", dedupKey: "deploy-abc" });
    expect(first.sent).toBe(true);
    expect(again).toEqual({ sent: false, seq: first.seq, at: first.at });

    const home = t.home;
    await t.server.close();
    t = await startTestServer({ home });
    const restarted = await asAgent(t, agent.id).notify.send({
      title: "Deploy failed",
      dedupKey: "deploy-abc",
    });
    expect(restarted).toEqual({ sent: false, seq: first.seq, at: first.at });
    const { entries } = await t.client.agents.entries({ agentId: agent.id, after: -1 });
    expect(entries.filter((e) => e.kind === "notification.sent")).toHaveLength(1);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses one too soon after the last, saying when to try again", async () => {
    t = await startTestServer();
    const { agent } = await agentIn(t);
    const client = asAgent(t, agent.id);
    await client.notify.send({ title: "One" });
    await expect(client.notify.send({ title: "Two" })).rejects.toThrow(
      /Too many notifications.*Try again in/,
    );
    // Another agent has its own allowance.
    const other = await agentIn(t);
    expect((await asAgent(t, other.agent.id).notify.send({ title: "Mine" })).sent).toBe(true);
  });

  it("is what `rowrow notify` does from inside an agent", async () => {
    const server = await startTestServer();
    t = server;
    const { agent } = await agentIn(server);
    const rowrow = async (...args: string[]): Promise<string> => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [path.resolve(import.meta.dirname, "../src/cli/main.ts"), ...args],
        {
          env: {
            ...process.env,
            ROWROW_URL: server.server.url,
            ROWROW_TOKEN: server.server.agentToken,
            ROWROW_AGENT_ID: agent.id,
          },
        },
      );
      return stdout.trim();
    };
    expect(await rowrow("notify", "Tests pass", "all 212 of them", "--key", "green")).toBe(
      "Notified you: Tests pass",
    );
    expect(await rowrow("notify", "Tests pass", "--key", "green")).toMatch(
      /^Not sent: --key green already notified you \d+s ago/,
    );
    const { state } = await server.client.state.get();
    expect(state.agents[agent.id]?.summary.lastNotification).toMatchObject({
      title: "Tests pass",
      body: "all 212 of them",
    });
  });
});
