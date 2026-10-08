// What the iOS app relies on, end to end on a real server (docs/ios.md): pairing by trading a
// sign-in code for a bearer token, presence carried by an HTTP state.watch stream, pushes
// through APNs (to a local HTTP/2 server standing in for Apple), and the kit, the server's own
// fold, served at /kit.js and run in a bare JavaScript context like JavaScriptCore's.
import { createDecipheriv, generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EntryPage } from "../src/shared/schemas.ts";
import { timelineOf } from "../src/shared/timeline.ts";
import { TranscriptProjector, type TranscriptItem } from "../src/shared/transcript-model.ts";
import { eventually, input, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Pair "the app": trade a fresh sign-in code for a bearer token. */
async function pairApp(
  server: TestServer,
  name = "rowrow on iPhone",
): Promise<{ token: string; id: string }> {
  const code = new URL(server.server.loginLink()).searchParams.get("code") ?? "";
  const response = await fetch(`${server.server.url}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string; device: { id: string } };
  return { token: body.token, id: body.device.id };
}

/** Call a procedure the way the app does: POST /api/<group>/<name>, JSON in and out. */
async function call<T>(server: TestServer, token: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${server.server.url}/api/${procedure}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${procedure}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

/** A server-sent event stream, as the app reads it: `event:` and `data:` lines, blank line ends one. */
async function* events(response: Response): AsyncGenerator<{ event: string; data: string }> {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (reader === undefined) return;
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (data.length > 0) yield { event, data: data.join("\n") };
        event = "message";
        data = [];
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      newline = buffer.indexOf("\n");
    }
  }
}

describe("pairing the iOS app", () => {
  it("trades a sign-in code for a bearer token, once", async () => {
    t = await startTestServer();
    const { token } = await pairApp(t);
    const me = await call<{ kind: string; name: string }>(t, token, "devices/whoami");
    expect(me).toMatchObject({ kind: "app", name: "rowrow on iPhone" });

    const code = new URL(t.server.loginLink("Work phone")).searchParams.get("code") ?? "";
    const trade = async (): Promise<Response> =>
      fetch(`${t!.server.url}/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: "ignored: the link has a name" }),
      });
    const first = (await (await trade()).json()) as { device: { name: string } };
    expect(first.device.name).toBe("Work phone");
    const again = await trade();
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe("INVALID_LINK");
  });
});

describe("presence over HTTP", () => {
  it("rides on the app's state.watch stream, and ends with it", async () => {
    t = await startTestServer();
    const { token } = await pairApp(t);
    const controller = new AbortController();
    const response = await fetch(`${t.server.url}/api/state/watch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ connection: "ios-conn-0001" }),
      signal: controller.signal,
    });
    const stream = events(response);
    const first = (await stream.next()).value as { event: string; data: string };
    expect(JSON.parse(first.data)).toMatchObject({ kind: "snapshot" });

    await call(t, token, "presence/update", {
      route: "/a/ag_x",
      agentId: "ag_x",
      visible: true,
      focused: true,
      connection: "ios-conn-0001",
    });
    // Another device naming the same connection describes nothing of this one.
    await t.client.presence.update({
      route: "/elsewhere",
      agentId: null,
      visible: true,
      focused: true,
      connection: "ios-conn-0001",
    });
    const clients = async () => (await t!.client.app.status()).clients;
    expect(await clients()).toEqual([
      expect.objectContaining({ device: "rowrow on iPhone", route: "/a/ag_x", focused: true }),
    ]);

    controller.abort();
    await eventually(async () => ((await clients()).length === 0 ? true : undefined));
  });
});

// ─── APNs ────────────────────────────────────────────────────────────────────

interface Pushed {
  readonly headers: http2.IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

/** Apple's push service, played by a local HTTP/2 server: records what it gets, answers `status`. */
async function fakeApple(answer: () => { status: number; reason?: string } = () => ({ status: 200 })) {
  const received: Pushed[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (body += chunk));
    stream.on("end", () => {
      received.push({ headers, body: JSON.parse(body) as Record<string, unknown> });
      const { status, reason } = answer();
      stream.respond({ ":status": status, "content-type": "application/json" });
      stream.end(reason === undefined ? "" : JSON.stringify({ reason }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function apnsKey(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey };
}

const DEVICE_TOKEN = "ab".repeat(32);

async function appWithPush(
  server: TestServer,
): Promise<{ token: string; id: string; publicKey: KeyObject; key: Buffer }> {
  const { pem, publicKey } = apnsKey();
  await server.client.notify.configureApns({ key: pem, keyId: "KEY1234567", teamId: "TEAM123456" });
  const app = await pairApp(server);
  // The app's own key: what its notifications say is encrypted with it.
  const key = randomBytes(32);
  await call(server, app.token, "notify/subscribeApns", {
    token: DEVICE_TOKEN,
    topic: "io.github.xxchan.rowrow",
    environment: "sandbox",
    key: key.toString("base64"),
  });
  return { ...app, publicKey, key };
}

/** What the app's notification service extension does: open `e` with the device's key. */
function open(sealed: unknown, key: Buffer): unknown {
  const bytes = Buffer.from(String(sealed), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const text = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
  return JSON.parse(text) as unknown;
}

describe("push to the iOS app", () => {
  it("refuses a key that isn't an APNs key", async () => {
    t = await startTestServer();
    await expect(
      t.client.notify.configureApns({ key: "not a key", keyId: "KEY1234567", teamId: "TEAM123456" }),
    ).rejects.toThrow(/AuthKey/);
    const { privateKey } = generateKeyPairSync("ed25519");
    await expect(
      t.client.notify.configureApns({
        key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        keyId: "KEY1234567",
        teamId: "TEAM123456",
      }),
    ).rejects.toThrow(/P-256/);
    await expect(
      t.client.notify.configureApns({ key: apnsKey().pem, keyId: "short", teamId: "TEAM123456" }),
    ).rejects.toThrow(/key id/);
  });

  it("signs with your key, tells the app an agent finished (only the app can read what), then that you saw it", async () => {
    const apple = await fakeApple();
    try {
      t = await startTestServer({ apnsOrigin: apple.origin });
      const app = await appWithPush(t);
      expect((await t.client.state.get()).state.host.apns).toBe(true);
      const devices = await t.client.devices.list();
      expect(devices.find((d) => d.id === app.id)).toMatchObject({ kind: "app", push: true });

      const ws = await t.client.workspaces.add({ path: t.repo() });
      const { agent, sent } = await t.client.agents.create({
        workspaceId: ws.id,
        runtime: "scripted",
        input: input("/echo all done"),
      });
      await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
      const alert = await eventually(() => apple.received[0], 5000);

      expect(alert.headers[":path"]).toBe(`/3/device/${DEVICE_TOKEN}`);
      expect(alert.headers["apns-topic"]).toBe("io.github.xxchan.rowrow");
      expect(alert.headers["apns-push-type"]).toBe("alert");
      expect(alert.headers["apns-collapse-id"]).toBe(agent.id);
      // Apple carries a generic alert; the words are sealed for the device.
      expect(alert.body).toMatchObject({
        aps: {
          alert: { title: "rowrow", body: "An agent finished." },
          "mutable-content": 1,
          badge: 1,
          "thread-id": agent.id,
          category: "AGENT",
        },
        agentId: agent.id,
        attention: "done",
        deviceId: app.id,
      });
      expect(typeof alert.body["seq"]).toBe("number");
      const plaintext = JSON.stringify(alert.body);
      expect(plaintext).not.toContain("all done");
      expect(plaintext).not.toContain(ws.label);
      expect(open(alert.body["e"], app.key)).toEqual({
        title: "/echo all done finished",
        subtitle: ws.label,
        body: "all done",
      });
      // The provider token is an ES256 JWT for the key and team, signed with the key.
      const jwt = String(alert.headers.authorization).replace(/^bearer /, "");
      const [header = "", claims = "", signature = ""] = jwt.split(".");
      expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
        alg: "ES256",
        kid: "KEY1234567",
      });
      expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({ iss: "TEAM123456" });
      const signed = verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: app.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      );
      expect(signed).toBe(true);

      // Seen elsewhere: the badge goes down, and the app hears which agents to clear.
      const head = (await t.client.state.get()).state.agents[agent.id]?.summary.headSeq ?? -1;
      await t.client.agents.markSeen({ agentId: agent.id, seq: head });
      const quiet = await eventually(
        () => (apple.received.length >= 3 ? apple.received.slice(1) : undefined),
        6000,
      );
      expect(quiet.map((p) => p.headers["apns-push-type"])).toEqual(["alert", "background"]);
      expect(quiet[0]?.body).toEqual({ aps: { badge: 0 }, deviceId: app.id });
      expect(quiet[1]?.body).toEqual({ aps: { "content-available": 1 }, seen: [agent.id], deviceId: app.id });
    } finally {
      await apple.close();
    }
  });

  it("holds the push while the app shows that agent", async () => {
    const apple = await fakeApple();
    try {
      t = await startTestServer({ apnsOrigin: apple.origin });
      const app = await appWithPush(t);
      const ws = await t.client.workspaces.add({ path: t.repo() });
      const { agent } = await t.client.agents.create({ workspaceId: ws.id, runtime: "scripted" });
      const controller = new AbortController();
      const response = await fetch(`${t.server.url}/api/state/watch`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" },
        body: JSON.stringify({ connection: "ios-conn-0002" }),
        signal: controller.signal,
      });
      await events(response).next();
      await call(t, app.token, "presence/update", {
        route: `/a/${agent.id}`,
        agentId: agent.id,
        visible: true,
        focused: true,
        connection: "ios-conn-0002",
      });
      const sent = await t.client.agents.send({ agentId: agent.id, ...input("/echo hi"), mode: "auto" });
      await t.client.agents.wait({ agentId: agent.id, afterSeq: sent.seq, timeoutMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(apple.received).toEqual([]);
      controller.abort();
    } finally {
      await apple.close();
    }
  });

  it("sends what an agent tells you itself, even while the app shows that agent", async () => {
    const apple = await fakeApple();
    try {
      t = await startTestServer({ apnsOrigin: apple.origin });
      const app = await appWithPush(t);
      const ws = await t.client.workspaces.add({ path: t.repo() });
      const { agent } = await t.client.agents.create({
        workspaceId: ws.id,
        runtime: "scripted",
        title: "deployer",
      });
      const controller = new AbortController();
      const response = await fetch(`${t.server.url}/api/state/watch`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" },
        body: JSON.stringify({ connection: "ios-conn-0003" }),
        signal: controller.signal,
      });
      await events(response).next();
      await call(t, app.token, "presence/update", {
        route: `/a/${agent.id}`,
        agentId: agent.id,
        visible: true,
        focused: true,
        connection: "ios-conn-0003",
      });
      const sent = await t.client.notify.send({
        agentId: agent.id,
        title: "Deploy failed",
        body: "api-7 is crash-looping",
      });
      const alert = await eventually(() => apple.received[0], 5000);
      // Its own notification: it replaces neither the agent's "finished" nor an earlier one.
      expect(alert.headers["apns-collapse-id"]).toBe(`${agent.id}:notice:${sent.seq}`);
      expect(alert.body).toMatchObject({
        aps: {
          alert: { title: "rowrow", body: "An agent notified you." },
          "thread-id": agent.id,
          category: "AGENT",
        },
        agentId: agent.id,
        notice: true,
        seq: sent.seq,
      });
      expect(JSON.stringify(alert.body)).not.toContain("crash-looping");
      expect(open(alert.body["e"], app.key)).toEqual({
        title: "Deploy failed",
        subtitle: "deployer",
        body: "api-7 is crash-looping",
      });
      controller.abort();
    } finally {
      await apple.close();
    }
  });

  it("forgets a device token Apple says is gone", async () => {
    const apple = await fakeApple(() => ({ status: 410, reason: "Unregistered" }));
    try {
      t = await startTestServer({ apnsOrigin: apple.origin });
      const app = await appWithPush(t);
      const sent = await t.client.notify.test();
      expect(sent.sent).toBe(0); // the CLI isn't subscribed
      const tested = await call<{ sent: number }>(t, app.token, "notify/test");
      expect(tested.sent).toBe(0);
      expect(apple.received).toHaveLength(1);
      const devices = await t.client.devices.list();
      expect(devices.find((d) => d.id === app.id)?.push).toBe(false);
    } finally {
      await apple.close();
    }
  });
});

// ─── The kit ─────────────────────────────────────────────────────────────────

interface Kit {
  version: number;
  open(runtime: string): number;
  load(handle: number, pageJson: string): string;
  append(handle: number, batchJson: string): string;
  prepend(handle: number, pageJson: string): string;
  item(handle: number, id: string): string;
  text(handle: number): string;
  close(handle: number): void;
  describe(agentsJson: string, now: number): string;
  resolveSetup(stateJson: string, contextJson: string, prefsJson: string | null): string;
  remember(prefsJson: string | null, workspaceId: string, setupJson: string): string;
  feedback(annotationsJson: string): string;
}

interface Delta {
  reset: boolean;
  head: number;
  hasMore: boolean;
  order: string[] | null;
  items: TranscriptItem[];
}

describe("the kit", () => {
  let dir = "";
  let kitFile = "";
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-kit-"));
    await build({
      configFile: path.resolve(import.meta.dirname, "../vite.kit.config.ts"),
      build: { outDir: dir, emptyOutDir: true },
      logLevel: "warn",
    });
    kitFile = path.join(dir, "kit.js");
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** The kit in a context with nothing but the language: no console, no timers, no Node. */
  function loadKit(): Kit {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(kitFile, "utf8"), context);
    return vm.runInContext("rowrowKit", context) as Kit;
  }

  it("is served with an ETag, so the app downloads it only when it changed", async () => {
    t = await startTestServer({ kitFile });
    const first = await fetch(`${t.server.url}/kit.js`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toMatch(/javascript/);
    const etag = first.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const again = await fetch(`${t.server.url}/kit.js`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  it("folds a transcript in a bare JavaScript context exactly as the server's code does", async () => {
    t = await startTestServer({ kitFile });
    const ws = await t.client.workspaces.add({ path: t.repo() });
    const { agent, sent } = await t.client.agents.create({
      workspaceId: ws.id,
      runtime: "scripted",
      input: input("Look around, please"),
    });
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const pageJson = await (
      await fetch(`${t.server.url}/api/agents/entries`, {
        method: "POST",
        headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" },
        body: JSON.stringify({ agentId: agent.id }),
      })
    ).text();

    const kit = loadKit();
    expect(kit.version).toBe(1);
    const handle = kit.open("scripted");
    const delta = JSON.parse(kit.load(handle, pageJson)) as Delta;
    const page = JSON.parse(pageJson) as EntryPage;
    const expected = new TranscriptProjector("scripted").update(timelineOf(page.entries));
    expect(delta.reset).toBe(true);
    expect(delta.head).toBe(page.headSeq);
    expect(delta.items).toEqual(expected.items.map((json) => JSON.parse(json) as unknown));
    expect(delta.order).toEqual(expected.order);
    expect(delta.items.map((item) => item.kind)).toEqual([
      "input",
      "turn",
      "reasoning",
      "tool",
      "text",
      "outcome",
    ]);
    expect(delta.items[0]).toMatchObject({
      kind: "input",
      text: "Look around, please",
      by: "local CLI",
      state: "sent",
    });
    const tool = delta.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ tool: "Bash", detail: "ls", result: "ok" });
    expect(JSON.parse(kit.item(handle, tool?.id ?? ""))).toMatchObject({
      kind: "tool",
      output: ".git\nREADME.md",
    });
    expect(kit.text(handle)).toContain("Look around, please");
    const unchanged = JSON.parse(kit.append(handle, JSON.stringify({ entries: page.entries }))) as Delta;
    expect(unchanged).toMatchObject({ reset: false, order: null, items: [] });
    kit.close(handle);
    expect(() => kit.text(handle)).toThrow(/no transcript/);
  });

  it("shows what you sent, text and attachments, not the text the runtime read", async () => {
    t = await startTestServer({ kitFile });
    const ws = await t.client.workspaces.add({ path: t.repo() });
    const form = new FormData();
    form.append("file", new Blob(["a log line\n"], { type: "text/plain" }), "run.log");
    const upload = await fetch(`${t.server.url}/api/files/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}` },
      body: form,
    });
    const attachment = (await upload.json()) as { path: string; name: string };
    expect(attachment.name).toBe("run.log");
    const { agent, sent } = await t.client.agents.create({
      workspaceId: ws.id,
      runtime: "scripted",
      input: { ...input("/echo read it"), attachments: [attachment as never] },
    });
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const page = await t.client.agents.entries({ agentId: agent.id });
    const kit = loadKit();
    const { items } = JSON.parse(kit.load(kit.open("scripted"), JSON.stringify(page))) as Delta;
    expect(items[0]).toMatchObject({ kind: "input", text: "/echo read it", attachments: [attachment] });
  });

  it("cuts long tool input in the list, and gives it whole on request", async () => {
    t = await startTestServer({ kitFile });
    const ws = await t.client.workspaces.add({ path: t.repo() });
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} of a long file`).join("\n");
    const { agent, sent } = await t.client.agents.create({
      workspaceId: ws.id,
      runtime: "scripted",
      input: input(`/write big.txt\n${long}`),
    });
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const page = await t.client.agents.entries({ agentId: agent.id });
    const kit = loadKit();
    const handle = kit.open("claude");
    const { items } = JSON.parse(kit.load(handle, JSON.stringify(page))) as Delta;
    const tool = items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ tool: "Write", action: "edit_file", detail: "big.txt" });
    if (tool?.kind !== "tool") throw new Error("no tool item");
    expect(tool.input?.length).toBe(2000);
    expect(tool.inputLength).toBeGreaterThan(long.length);
    const whole = JSON.parse(kit.item(handle, tool.id)) as { input: string };
    expect(whole.input).toHaveLength(tool.inputLength);
  });

  it("sends only the item that changed while text streams in", async () => {
    t = await startTestServer({ kitFile });
    const ws = await t.client.workspaces.add({ path: t.repo() });
    const { agent, sent } = await t.client.agents.create({
      workspaceId: ws.id,
      runtime: "scripted",
      input: input("/stream 6"),
    });
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const { entries } = await t.client.agents.entries({ agentId: agent.id, after: -1 });

    const kit = loadKit();
    const handle = kit.open("scripted");
    kit.load(handle, JSON.stringify({ entries: [], firstSeq: -1, headSeq: -1, hasMore: false }));
    const texts: string[] = [];
    for (const entry of entries) {
      const delta = JSON.parse(kit.append(handle, JSON.stringify({ entries: [entry] }))) as Delta;
      const streamed =
        entry.kind === "oar" &&
        entry.record.kind === "frame" &&
        entry.record.body.events.length > 0 &&
        entry.record.body.events.every((event) => event.kind === "text_delta");
      if (streamed && delta.order === null) {
        expect(delta.items).toHaveLength(1);
        const [item] = delta.items;
        if (item?.kind === "text") texts.push(item.text);
      }
    }
    expect(texts.length).toBeGreaterThanOrEqual(4);
    expect(texts.at(-1)).toContain("chunk 6");
  });

  it("words agents, starts new ones and writes review feedback like the web app", async () => {
    t = await startTestServer({ kitFile });
    const ws = await t.client.workspaces.add({ path: t.repo() });
    const { agent, sent } = await t.client.agents.create({
      workspaceId: ws.id,
      runtime: "scripted",
      input: input("/fail no network"),
    });
    await t.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 5000 });
    const { state } = await t.client.state.get();
    const kit = loadKit();
    const words = JSON.parse(kit.describe(JSON.stringify(state.agents), Date.now())) as Record<
      string,
      unknown
    >;
    expect(words[agent.id]).toEqual({ tone: "error", label: "Failed", pulsing: false });

    const setup = JSON.parse(
      kit.resolveSetup(JSON.stringify(state), JSON.stringify({ kind: "agent", agentId: agent.id }), null),
    ) as Record<string, unknown>;
    expect(setup).toMatchObject({ workspaceId: ws.id, runtime: "scripted", isolate: false });
    const prefs = kit.remember(
      null,
      ws.id,
      JSON.stringify({ runtime: "scripted", model: null, effort: null, isolate: true }),
    );
    expect(JSON.parse(prefs)).toMatchObject({ lastWorkspaceId: ws.id, lastRuntime: "scripted" });

    const feedback = kit.feedback(
      JSON.stringify([
        {
          id: "1",
          workspaceId: ws.id,
          source: { kind: "diff", path: "src/a.ts", scope: "turn", side: "new", line: 3, text: "let x = 1;" },
          comment: "Use const.",
          createdAt: 0,
        },
      ]),
    );
    expect(feedback).toBe("Review feedback:\n\n1. `src/a.ts` line 3:\n   > let x = 1;\n   Use const.\n");
  });
});
