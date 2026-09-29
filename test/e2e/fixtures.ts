// Each test gets its own rowrow server (a child process on a throwaway ROWROW_HOME, with
// the scripted runtime), an API client for setting things up, and a page signed in
// through a one-time login link, the way a person signs in.
import { test as base, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type Client } from "../../src/cli/client.ts";

interface Rowrow {
  readonly url: string;
  readonly client: Client;
  /** A git repository to use as a workspace. */
  repo(): string;
  /** Sign `page` in and open `route`. */
  open(page: Page, route?: string): Promise<void>;
}

const root = path.resolve(import.meta.dirname, "../..");

export const test = base.extend<{ rowrow: Rowrow }>({
  rowrow: async ({}, use) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-e2e-"));
    const child: ChildProcess = spawn(process.execPath, ["src/cli/main.ts", "serve", "--profile", "e2e", "--port", "0", "--test-runtime"], {
      cwd: root,
      env: { ...process.env, ROWROW_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const serverFile = path.join(home, "e2e", "server.json");
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(serverFile)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`rowrow did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const info = JSON.parse(fs.readFileSync(serverFile, "utf8")) as { url: string; token: string };
    const { client } = connect({ url: info.url, token: info.token, source: serverFile });
    const repos: string[] = [];
    await use({
      url: info.url,
      client,
      repo() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-e2e-repo-"));
        const git = (...args: string[]): void => {
          execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd: dir, stdio: "ignore" });
        };
        git("init", "-q", "-b", "main");
        fs.writeFileSync(path.join(dir, "README.md"), "# e2e\n");
        git("add", ".");
        git("commit", "-q", "-m", "init");
        repos.push(dir);
        return fs.realpathSync(dir);
      },
      async open(page, route = "/") {
        const link = await client.devices.pair({ name: "e2e browser" });
        await page.goto(link.url);
        if (route !== "/") await page.goto(`${info.url}${route}`);
      },
    });
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(home, { recursive: true, force: true });
    for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
  },
});

export { expect } from "@playwright/test";
