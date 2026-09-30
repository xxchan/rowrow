// What the Mac app relies on from a server (docs/desktop.md): it pairs like the iOS app (a
// sign-in code traded for a bearer token) and holds notify.watch open, turning alerts into the
// system's notifications and `seen` into clearing them; a focused window of the same device
// gets the badge instead of an alert, as Web Push skips a device you're using.
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { afterEach, describe, expect, it } from "vitest";
import type { Notice } from "../src/shared/schemas.ts";
import { eventually, input, startTestServer, type Client, type TestServer } from "./helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** The app's device: a bearer token for a fresh sign-in code, and a typed client with it. */
async function pairDesktop(server: TestServer): Promise<{ id: string; token: string; client: Client }> {
  const code = new URL(server.server.loginLink()).searchParams.get("code") ?? "";
  const response = await fetch(`${server.server.url}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "rowrow for Mac" }),
  });
  const body = (await response.json()) as { token: string; device: { id: string } };
  const client = createORPCClient<Client>(
    new RPCLink({ url: `${server.server.url}/rpc`, headers: { authorization: `Bearer ${body.token}` } }),
  );
  return { id: body.device.id, token: body.token, client };
}

/** Notices as they arrive, read one at a time. */
async function watchNotices(client: Client): Promise<{ next(): Promise<Notice>; stop(): void }> {
  const controller = new AbortController();
  const stream = await client.notify.watch(undefined, { signal: controller.signal });
  const iterator = stream[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await iterator.next();
      if (result.done === true) throw new Error("notify.watch ended");
      return result.value;
    },
    stop: () => controller.abort(),
  };
}

describe("notify.watch", () => {
  it("says the badge, alerts when an agent finishes, and clears it once seen", async () => {
    t = await startTestServer();
    const desktop = await pairDesktop(t);
    const notices = await watchNotices(desktop.client);
    expect(await notices.next()).toEqual({ kind: "badge", badge: 0 });

    const ws = await t.client.workspaces.add({ path: t.repo() });
    const { agent } = await t.client.agents.create({
      workspaceId: ws.id,
      runtime: "scripted",
      title: "Echo",
      input: input("/echo all done here"),
    });
    const alert = await notices.next();
    expect(alert).toMatchObject({
      kind: "alert",
      agentId: agent.id,
      attention: "done",
      title: "Echo finished",
      url: `/a/${agent.id}`,
      badge: 1,
    });
    expect(alert.kind === "alert" && alert.body).toContain("all done here");

    // Marking it seen (from any device) clears it everywhere.
    await t.client.agents.markSeen({ agentId: agent.id, seq: alert.kind === "alert" ? alert.seq : 0 });
    expect(await notices.next()).toEqual({ kind: "seen", agentIds: [agent.id], badge: 0 });
    const devices = await desktop.client.devices.list();
    expect(devices.find((d) => d.id === desktop.id)?.push).toBe(true);
    notices.stop();
  });

  it("gives a device with a focused window the badge instead of an alert", async () => {
    t = await startTestServer();
    const desktop = await pairDesktop(t);
    const notices = await watchNotices(desktop.client);
    await notices.next();

    // The app's window is focused: its web app reports presence under the same device.
    const controller = new AbortController();
    const state = await desktop.client.state.watch(
      { connection: "desktop-window-1" },
      { signal: controller.signal },
    );
    await state[Symbol.asyncIterator]().next();
    await desktop.client.presence.update({
      connection: "desktop-window-1",
      route: "/",
      agentId: null,
      visible: true,
      focused: true,
    });

    const ws = await t.client.workspaces.add({ path: t.repo() });
    await t.client.agents.create({ workspaceId: ws.id, runtime: "scripted", input: input("/echo hi") });
    expect(await notices.next()).toEqual({ kind: "badge", badge: 1 });
    controller.abort();
    notices.stop();
  });

  it("sends a test alert to this device only", async () => {
    t = await startTestServer();
    const desktop = await pairDesktop(t);
    const other = await pairDesktop(t);
    const mine = await watchNotices(desktop.client);
    const theirs = await watchNotices(other.client);
    await mine.next();
    await theirs.next();
    expect(await desktop.client.notify.test()).toEqual({ sent: 1 });
    expect(await mine.next()).toMatchObject({ kind: "alert", agentId: "", url: "/", title: "rowrow" });
    // Nothing reached the other device: the next thing it hears is the badge of a real alert.
    const ws = await t.client.workspaces.add({ path: t.repo() });
    await t.client.agents.create({ workspaceId: ws.id, runtime: "scripted", input: input("/echo hi") });
    await eventually(async () => ((await theirs.next()).kind === "alert" ? true : undefined));
    mine.stop();
    theirs.stop();
  });
});

describe("the Mac app's connection to a server", () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, file: null };

  async function connectTo(server: TestServer, options: { mint: boolean; token?: string | null }) {
    const { Connection } = await import("../src/desktop/connection.ts");
    let token: string | null = options.token ?? null;
    const statuses: string[] = [];
    const notices: Notice[] = [];
    const online: { version: string; restarted: boolean }[] = [];
    let origin = server.server.url;
    const connection = new Connection({
      id: "test",
      origin: async () => origin,
      token: () => token,
      saveToken: (value) => (token = value),
      mintCode: options.mint
        ? async () => new URL(server.server.loginLink()).searchParams.get("code") ?? ""
        : null,
      redeemInBrowser: async () => null,
      deviceName: "rowrow for Mac (test)",
      onStatus: (status) => statuses.push(status.kind),
      onNotice: (notice) => notices.push(notice),
      onOnline: (info) => online.push(info),
      log: quiet,
    });
    connection.start();
    return {
      connection,
      statuses,
      notices,
      online,
      token: () => token,
      moveTo: (url: string) => (origin = url),
    };
  }

  it("pairs by itself where it can mint a code, and hears the server's notices", async () => {
    t = await startTestServer();
    const c = await connectTo(t, { mint: true });
    await eventually(() => (c.connection.status.kind === "online" ? true : undefined));
    expect(c.token()).toMatch(/^rr_/);
    await eventually(() => (c.notices[0]?.kind === "badge" ? true : undefined));
    const devices = await t.client.devices.list();
    expect(devices.find((d) => d.name === "rowrow for Mac (test)")?.kind).toBe("app");

    const ws = await t.client.workspaces.add({ path: t.repo() });
    await t.client.agents.create({ workspaceId: ws.id, runtime: "scripted", input: input("/echo done") });
    await eventually(() => (c.notices.some((n) => n.kind === "alert") ? true : undefined));
    expect(c.connection.badge).toBe(1);

    // Revoked from Settings → Devices: it signs in again, as a new device.
    const first = c.token();
    const me = devices.find((d) => d.name === "rowrow for Mac (test)");
    await t.client.devices.revoke({ id: me?.id ?? "" });
    c.connection.kick();
    await eventually(
      () => (c.token() !== first && c.connection.status.kind === "online" ? true : undefined),
      10_000,
    );
    c.connection.stop();
  });

  it("says signed out when it can't mint a code (a server added by link)", async () => {
    t = await startTestServer();
    const c = await connectTo(t, { mint: false, token: "rr_revoked" });
    await eventually(() => (c.connection.status.kind === "signed-out" ? true : undefined));
    c.connection.stop();
  });

  it("goes offline when the server does, and says it restarted when it's back", async () => {
    t = await startTestServer();
    const c = await connectTo(t, { mint: true });
    await eventually(() => (c.connection.status.kind === "online" ? true : undefined));
    t = await t.restart();
    c.moveTo(t.server.url);
    await eventually(() => (c.statuses.includes("offline") ? true : undefined), 10_000);
    c.connection.kick();
    await eventually(() => (c.online.some((o) => o.restarted) ? true : undefined), 20_000);
    expect(c.connection.status.kind).toBe("online");
    c.connection.stop();
  });
});
