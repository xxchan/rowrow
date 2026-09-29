// The server end to end, in-process: real HTTP and WebSocket, real oar sessions (the
// scripted runtime), the real database on a throwaway home. What these prove is what a
// browser, the CLI and agents can rely on.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Entry } from "../src/shared/entries.ts";
import { newInputId } from "../src/shared/ids.ts";
import { renderText } from "../src/shared/render-text.ts";
import type { StateMessage } from "../src/shared/schemas.ts";
import { timelineOf } from "../src/shared/timeline.ts";
import { eventually, input, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function agentIn(server: TestServer, text?: string) {
  const ws = await server.client.workspaces.add({ path: server.repo() });
  return server.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    ...(text === undefined ? {} : { input: input(text) }),
  });
}

describe("agents", () => {
  it("runs a turn and reports it done, then idle once seen", async () => {
    t = await startTestServer();
    const { agent, sent } = await agentIn(t, "/echo hello");
    expect(sent?.landed).toBe("prompted");
    const waited = await t.client.agents.wait({
      agentId: agent.id,
      afterSeq: sent?.seq ?? -1,
      timeoutMs: 5000,
    });
    expect(waited.timedOut).toBe(false);
    expect(waited.agent.attention).toBe("done");
    expect(waited.agent.summary.preview).toBe("hello");
    expect(waited.agent.summary.title).toBe("/echo hello");

    await t.client.agents.markSeen({ agentId: agent.id, seq: waited.agent.summary.headSeq });
    const { state } = await t.client.state.get();
    expect(state.agents[agent.id]?.attention).toBe("idle");

    const view = await t.client.agents.view({ agentId: agent.id });
    expect(view.text).toContain("> [local CLI] /echo hello");
    expect(view.text).toContain("✓ turn completed");
  });

  it("waits for the turn it was asked about, not an earlier unseen one", async () => {
    t = await startTestServer();
    const { agent, sent } = await agentIn(t, "/echo one");
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const second = await t.client.agents.send({
      agentId: agent.id,
      inputId: newInputId(),
      text: "/sleep 300",
      mode: "auto",
    });
    const started = Date.now();
    const waited = await t.client.agents.wait({ agentId: agent.id, afterSeq: second.seq, timeoutMs: 5000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(waited.agent.summary.preview).toBe("Slept 300 ms.");
  });

  it("treats a retried send (same inputId) as the same input", async () => {
    t = await startTestServer();
    const { agent } = await agentIn(t);
    const same = { agentId: agent.id, inputId: newInputId(), text: "/echo once", mode: "auto" as const };
    const first = await t.client.agents.send(same);
    const again = await t.client.agents.send(same);
    expect(again).toEqual(first);
    const page = await t.client.agents.entries({ agentId: agent.id, after: -1 });
    expect(page.entries.filter((e) => e.kind === "input")).toHaveLength(1);
  });

  it("steers a running turn and reports where the input landed", async () => {
    t = await startTestServer();
    const { agent, sent } = await agentIn(t, "/sleep 400");
    const steer = await t.client.agents.send({
      agentId: agent.id,
      inputId: newInputId(),
      text: "also this",
      mode: "auto",
    });
    expect(steer.landed).toBe("steered");
    const queued = await t.client.agents.send({
      agentId: agent.id,
      inputId: newInputId(),
      text: "/echo next",
      mode: "queue",
    });
    expect(queued.landed).toBe("queued");
    await eventually(async () => {
      const { entries } = await t!.client.agents.entries({ agentId: agent.id, after: sent?.seq ?? -1 });
      const text = renderText(timelineOf(entries));
      return text.includes("next") && text.split("✓ turn completed").length === 3 ? true : undefined;
    });
  });

  it("aborts a running turn; an aborted turn is not a completion to look at", async () => {
    t = await startTestServer();
    const { agent } = await agentIn(t, "/sleep 5000");
    await eventually(async () =>
      (await t!.client.state.get()).state.agents[agent.id]?.attention === "working" ? true : undefined,
    );
    const aborted = await t.client.agents.abort({ agentId: agent.id });
    expect(aborted.accepted).toBe(true);
    const settled = await eventually(async () => {
      const a = (await t!.client.state.get()).state.agents[agent.id];
      return a?.summary.lastTurn?.outcome.kind === "aborted" ? a : undefined;
    });
    expect(settled.attention).toBe("idle");
  });

  it("reports a failed turn as done with the runtime's reason", async () => {
    t = await startTestServer();
    const { agent, sent } = await agentIn(t, "/fail the build is red");
    const waited = await t.client.agents.wait({
      agentId: agent.id,
      afterSeq: sent?.seq ?? -1,
      timeoutMs: 5000,
    });
    expect(waited.agent.attention).toBe("done");
    expect(waited.agent.summary.lastTurn?.outcome).toMatchObject({
      kind: "failed",
      reason: "the build is red",
    });
    expect(waited.agent.summary.lastError).toBe("the build is red");
  });

  it("writes files in its workspace", async () => {
    t = await startTestServer();
    const { agent, sent } = await agentIn(t, "/write src/a.txt\nhello file");
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const ws = (await t.client.state.get()).state.workspaces[agent.summary.workspaceId];
    expect(fs.readFileSync(path.join(ws?.path ?? "", "src/a.txt"), "utf8")).toBe("hello file\n");
    const refreshed = await t.client.workspaces.refresh({ id: ws?.id ?? "" });
    expect(refreshed.git?.changed).toBe(1);
  });

  it("stops idle runs and resumes the conversation on the next input", async () => {
    t = await startTestServer({ idleTimeoutMs: 200 });
    const { agent, sent } = await agentIn(t, "/echo first");
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    await eventually(async () =>
      (await t!.client.state.get()).state.agents[agent.id]?.summary.run === null ? true : undefined,
    );
    const second = await t.client.agents.send({
      agentId: agent.id,
      inputId: newInputId(),
      text: "/echo second",
      mode: "auto",
    });
    await t.client.agents.wait({ agentId: agent.id, afterSeq: second.seq, timeoutMs: 5000 });
    const { entries } = await t.client.agents.entries({ agentId: agent.id, after: -1 });
    const runs = entries.filter(
      (e): e is Extract<Entry, { kind: "run.started" }> => e.kind === "run.started",
    );
    expect(runs).toHaveLength(2);
    expect(runs[1]?.resume).toBe(runs[0]?.sessionId);
    expect(entries.some((e) => e.kind === "run.ended" && e.reason === "idle")).toBe(true);
  });

  it("closes a run the previous server left open as crashed", async () => {
    t = await startTestServer();
    const { agent } = await agentIn(t, "/sleep 10000");
    await eventually(async () =>
      (await t!.client.state.get()).state.agents[agent.id]?.attention === "working" ? true : undefined,
    );
    // Simulate a crash: keep the log as it was while the run was live, drop what a clean
    // shutdown wrote after that (the dispose, the exit, the run's end).
    const head = (await t.client.agents.entries({ agentId: agent.id, after: -1 })).headSeq;
    const home = t.home;
    await t.server.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path.join(home, "test", "rowrow.db"));
    raw.prepare("delete from entries where agent_id = ? and seq > ?").run(agent.id, head);
    raw.close();
    t = await startTestServer({ home });
    const loaded = (await t.client.state.get()).state.agents[agent.id];
    expect(loaded?.summary.run).toBeNull();
    expect(loaded?.attention).toBe("done");
    expect(loaded?.summary.lastError).toBe("rowrow stopped while this agent was running");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("streams", () => {
  it("state.watch sends a snapshot, then patches", async () => {
    t = await startTestServer();
    const { client, close } = await t.websocket();
    const iterator = (await client.state.watch())[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as StateMessage;
    expect(first.kind).toBe("snapshot");
    await t.client.workspaces.add({ path: t.repo() });
    const next = (await iterator.next()).value as StateMessage;
    expect(next.kind).toBe("patches");
    await iterator.return?.();
    close();
  });

  it("agents.watch resumes after a cursor without loss or duplicates", async () => {
    t = await startTestServer();
    const { agent, sent } = await agentIn(t, "/stream 5");
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const all = (await t.client.agents.entries({ agentId: agent.id, after: -1 })).entries;
    const cut = all[Math.floor(all.length / 2)]?.seq ?? 0;
    const { client, close } = await t.websocket();
    const seen: number[] = [];
    const iterator = (await client.agents.watch({ agentId: agent.id, after: cut }))[Symbol.asyncIterator]();
    while (seen.length < all.length - cut - 1) {
      const batch = (await iterator.next()).value as { entries: Entry[] };
      seen.push(...batch.entries.map((e) => e.seq));
    }
    expect(seen).toEqual(all.filter((e) => e.seq > cut).map((e) => e.seq));
    await iterator.return?.();
    close();
  });

  it("serves slim entries unless asked for full ones", async () => {
    t = await startTestServer();
    const { agent, sent } = await agentIn(t, "/echo x");
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const frame = (entries: Entry[]) => entries.find((e) => e.kind === "oar" && e.record.kind === "frame");
    const slim = frame((await t.client.agents.entries({ agentId: agent.id, after: -1 })).entries);
    const full = frame((await t.client.agents.entries({ agentId: agent.id, after: -1, full: true })).entries);
    expect(
      slim?.kind === "oar" && slim.record.kind === "frame" ? slim.record.body.native : "missing",
    ).toBeNull();
    expect(
      full?.kind === "oar" && full.record.kind === "frame" ? full.record.body.native : null,
    ).not.toBeNull();
  });
});

describe("auth", () => {
  it("refuses requests without a credential, and revoked devices", async () => {
    t = await startTestServer();
    const anonymous = await fetch(`${t.server.url}/api/app/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);
    const code = new URL(t.server.loginLink()).searchParams.get("code") ?? "";
    const redeemed = await fetch(`${t.server.url}/auth/redeem?code=${code}`, { redirect: "manual" });
    expect(redeemed.status).toBe(302);
    const again = await fetch(`${t.server.url}/auth/redeem?code=${code}`, { redirect: "manual" });
    expect(again.status).toBe(400);
    const cookie = (redeemed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const ok = await fetch(`${t.server.url}/api/devices/whoami`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    const me = (await ok.json()) as { id: string; kind: string };
    expect(me.kind).toBe("browser");
    await t.client.devices.revoke({ id: me.id });
    const revoked = await fetch(`${t.server.url}/api/devices/whoami`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(revoked.status).toBe(401);
  });

  it("refuses a WebSocket from another origin", async () => {
    t = await startTestServer();
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`${t.server.url.replace("http", "ws")}/rpc`, {
      headers: { origin: "https://evil.example", authorization: `Bearer ${t.token}` },
    });
    const status = await new Promise<number>((resolve) =>
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(403);
  });
});

describe("git", () => {
  it("shows what the last turn changed, apart from earlier uncommitted work", async () => {
    t = await startTestServer();
    const repo = t.repo();
    const ws = await t.client.workspaces.add({ path: repo });
    fs.writeFileSync(path.join(repo, "before.txt"), "already here\n"); // not the turn's doing
    const { agent, sent } = await t.client.agents.create({
      workspaceId: ws.id,
      runtime: "scripted",
      input: input("/write src/new.txt\nhello"),
    });
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });

    const turn = await t.client.git.changes({ workspaceId: ws.id, scope: "turn" });
    expect(turn.files.map((f) => f.path)).toEqual(["src/new.txt"]);
    const working = await t.client.git.changes({ workspaceId: ws.id, scope: "working" });
    expect(working.files.map((f) => f.path).sort()).toEqual(["before.txt", "src/new.txt"]);
    const diff = await t.client.git.diff({ workspaceId: ws.id, scope: "turn", path: "src/new.txt" });
    expect(diff.patch).toContain("+hello");
  });

  it("keeps each agent's last turn apart, even when they take turns in one checkout", async () => {
    t = await startTestServer();
    const repo = t.repo();
    const ws = await t.client.workspaces.add({ path: repo });
    const a = await t.client.agents.create({
      workspaceId: ws.id,
      runtime: "scripted",
      input: input("/write a.txt\nfrom a"),
    });
    await t.client.agents.wait({ agentId: a.agent.id, afterSeq: a.sent?.seq ?? -1, timeoutMs: 5000 });
    const b = await t.client.agents.create({
      workspaceId: ws.id,
      runtime: "scripted",
      input: input("/write b.txt\nfrom b"),
    });
    await t.client.agents.wait({ agentId: b.agent.id, afterSeq: b.sent?.seq ?? -1, timeoutMs: 5000 });
    // Each turn's end is snapshotted right after it ends; wait for both before touching the checkout.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(t.home, "test", "rowrow.db"), { readOnly: true });
    await eventually(() => {
      const ended = db.prepare("select count(*) as n from agent_turns where end_tree is not null").get() as {
        n: number;
      };
      return ended.n === 2 ? true : undefined;
    });
    db.close();
    fs.writeFileSync(path.join(repo, "later.txt"), "after both turns\n"); // nobody's turn

    const files = async (agentId?: string) =>
      (
        await t!.client.git.changes({
          workspaceId: ws.id,
          scope: "turn",
          ...(agentId === undefined ? {} : { agentId }),
        })
      ).files.map((f) => f.path);
    await eventually(async () => ((await files(a.agent.id)).length === 1 ? true : undefined));
    expect(await files(a.agent.id)).toEqual(["a.txt"]);
    expect(await files(b.agent.id)).toEqual(["b.txt"]);
    expect(await files()).toEqual(["b.txt"]); // the workspace's latest turn
    const diff = await t.client.git.diff({
      workspaceId: ws.id,
      scope: "turn",
      path: "a.txt",
      agentId: a.agent.id,
    });
    expect(diff.patch).toContain("+from a");
  });

  it("creates a worktree grouped under its repository, and removes it", async () => {
    t = await startTestServer();
    const ws = await t.client.workspaces.add({ path: t.repo() });
    const { workspace: wt, hook } = await t.client.workspaces.createWorktree({
      id: ws.id,
      branch: "feature/x",
    });
    expect(hook).toBeNull();
    expect(wt.parentId).toBe(ws.id);
    expect(wt.git?.branch).toBe("feature/x");
    expect(wt.git?.linked).toBe(true);
    expect(wt.label).toBe("feature/x");

    fs.writeFileSync(path.join(wt.path, "wip.txt"), "unsaved work\n");
    await expect(t.client.workspaces.removeWorktree({ id: wt.id })).rejects.toThrow(/uncommitted changes/);
    await t.client.workspaces.removeWorktree({ id: wt.id, force: true });
    expect(fs.existsSync(wt.path)).toBe(false);
    expect((await t.client.state.get()).state.workspaces[wt.id]?.archived).toBe(true);
  });
});

describe("files", () => {
  it("stores an upload privately and returns a path an agent can read, over HTTP and WebSocket", async () => {
    t = await startTestServer();
    const viaHttp = await t.client.files.upload({
      file: new File(["hello image"], "Screen Shot 1.png", { type: "image/png" }),
    });
    expect(viaHttp.path.startsWith(path.join(t.home, "test", "uploads"))).toBe(true);
    expect(path.basename(viaHttp.path)).toMatch(/^[0-9a-f]{8}-Screen-Shot-1\.png$/);
    expect(fs.readFileSync(viaHttp.path, "utf8")).toBe("hello image");
    expect(fs.statSync(viaHttp.path).mode & 0o777).toBe(0o600);

    const { client, close } = await t.websocket();
    const viaWs = await client.files.upload({
      file: new File([new Uint8Array([1, 2, 3])], "log.txt", { type: "text/plain" }),
    });
    expect(fs.readFileSync(viaWs.path)).toEqual(Buffer.from([1, 2, 3]));
    close();
  });
});

describe("settings", () => {
  it("keeps quick replies across restarts and shows every client the change", async () => {
    t = await startTestServer();
    const before = await t.client.state.get();
    expect(before.state.settings.quickReplies.length).toBeGreaterThan(0);

    const ws = await t.websocket();
    const seen: StateMessage[] = [];
    const watching = (async () => {
      for await (const message of await ws.client.state.watch()) seen.push(message);
    })();
    const saved = await t.client.settings.update({ quickReplies: ["  Ship it.  ", "Try again."] });
    expect(saved.quickReplies).toEqual(["Ship it.", "Try again."]);
    await eventually(() =>
      seen.some((m) => m.kind === "patches" && m.patches.some((p) => p.path[0] === "settings")),
    );
    ws.close();
    await watching.catch(() => undefined);

    await expect(t.client.settings.update({ quickReplies: ["x".repeat(501)] })).rejects.toThrow();
    t = await t.restart();
    expect((await t.client.state.get()).state.settings.quickReplies).toEqual(["Ship it.", "Try again."]);
  });
});
