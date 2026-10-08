// Integration-test helpers: a real server in this process, on a throwaway ROWROW_HOME with
// the scripted runtime (zero tokens), and a typed client for it over HTTP or WebSocket.
import type { Runtime } from "@botiverse/oar";
import { createORPCClient } from "@orpc/client";
import { RPCLink as FetchLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { contract } from "../src/shared/contract.ts";
import { newInputId } from "../src/shared/ids.ts";
import { startServer, type RunningServer, type ServerFile } from "../src/server/main.ts";

export type Client = ContractRouterClient<typeof contract>;

export interface TestServer {
  readonly server: RunningServer;
  readonly home: string;
  readonly token: string;
  readonly client: Client;
  /** A fresh repository to use as a workspace. */
  repo(name?: string): string;
  /** A browser-like client over WebSocket (signed in through a login link). */
  websocket(): Promise<{ client: Client; close(): void }>;
  restart(): Promise<TestServer>;
  close(): Promise<void>;
}

export async function startTestServer(
  options: {
    home?: string;
    idleTimeoutMs?: number;
    gh?: string;
    updateRegistry?: string;
    apnsOrigin?: string;
    kitFile?: string;
    webDir?: string;
    extraRuntimes?: readonly Runtime[];
  } = {},
): Promise<TestServer> {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-test-"));
  const server = await startServer(
    {
      home,
      profile: "test",
      host: "127.0.0.1",
      port: 0,
      testRuntime: true,
      probeRuntimes: false,
      idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
      ...(options.gh === undefined ? {} : { gh: options.gh }),
      ...(options.updateRegistry === undefined ? {} : { updateRegistry: options.updateRegistry }),
      ...(options.apnsOrigin === undefined ? {} : { apnsOrigin: options.apnsOrigin }),
      ...(options.kitFile === undefined ? {} : { kitFile: options.kitFile }),
      ...(options.webDir === undefined ? {} : { webDir: options.webDir }),
      ...(options.extraRuntimes === undefined ? {} : { extraRuntimes: options.extraRuntimes }),
    },
    process.env["ROWROW_TEST_LOG"] === "1" ? "pretty" : "off",
  );
  const info = JSON.parse(fs.readFileSync(path.join(home, "test", "server.json"), "utf8")) as ServerFile;
  const client = createORPCClient<Client>(
    new FetchLink({ url: `${server.url}/rpc`, headers: { authorization: `Bearer ${info.token}` } }),
  );
  const repos: string[] = [];
  const self: TestServer = {
    server,
    home,
    token: info.token,
    client,
    repo(name = "repo") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rowrow-${name}-`));
      const git = (...args: string[]): void => {
        // No background maintenance: nothing may write into the repository after the test moves on.
        const config = ["-c", "maintenance.auto=false", "-c", "gc.auto=0"];
        execFileSync(
          "git",
          [...config, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
          {
            cwd: dir,
            stdio: "ignore",
          },
        );
      };
      git("init", "-q", "-b", "main");
      fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      repos.push(dir);
      return fs.realpathSync(dir);
    },
    async websocket() {
      const code = new URL(server.loginLink()).searchParams.get("code") ?? "";
      const redeemed = await fetch(`${server.url}/auth/redeem?code=${code}`, { redirect: "manual" });
      const cookie = (redeemed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/rpc`, {
        headers: { cookie, origin: server.url },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const wsClient = createORPCClient<Client>(
        new WebSocketLink({ websocket: ws as unknown as globalThis.WebSocket }),
      );
      return { client: wsClient, close: () => ws.close() };
    },
    async restart() {
      await server.close();
      return startTestServer({ ...options, home });
    },
    async close() {
      await server.close();
      for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
      if (options.home === undefined) fs.rmSync(home, { recursive: true, force: true });
    },
  };
  return self;
}

export function input(text: string): { inputId: string; text: string } {
  return { inputId: newInputId(), text };
}

/** Poll until `check` returns a value (for eventually-consistent reads like AppState). */
export async function eventually<T>(
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
