// Commands run in a workspace (D-052): the runner on real processes (output as it prints, exit
// codes, Stop and the process group, the output cap, what it refuses), the shared words and
// text folds, and the procedures through the real server over HTTP.
import { ORPCError } from "@orpc/client";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  appendOutput,
  commandReport,
  NO_OUTPUT,
  outputSince,
  outputString,
  terminalText,
  type CommandRun,
} from "../src/shared/commands.ts";
import type { Workspace } from "../src/shared/schemas.ts";
import { commandEnv, Commands, type CommandsDeps } from "../src/server/commands/service.ts";
import { setupLog } from "../src/server/telemetry/log.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const by = { kind: "system" } as const;
beforeAll(() => setupLog({ consoleFormat: "off" }));
const open: Commands[] = [];
const dirs: string[] = [];
let t: TestServer | undefined;

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (commands) => commands.close()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await t?.close();
  t = undefined;
});

/** A runner on one throwaway folder, workspace `ws_a` (archived when `archived` says so). */
function runner(options: Partial<CommandsDeps> & { archived?: boolean } = {}): {
  commands: Commands;
  dir: string;
} {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-commands-")));
  dirs.push(dir);
  const workspace = (id: string): Workspace => ({
    id,
    path: dir,
    customLabel: null,
    label: "scratch",
    parentId: null,
    createdAt: 0,
    archived: options.archived ?? false,
    missing: false,
    git: null,
  });
  const commands = new Commands({
    workspaces: { require: workspace, archived: () => options.archived ?? false },
    // sh, whatever the shell of whoever runs the tests.
    env: () => commandEnv({ ...process.env, SHELL: "/bin/sh" }, "test"),
    graceMs: 300,
    ...options,
  });
  open.push(commands);
  return { commands, dir };
}

/** Everything a run prints, followed from the start, and how it ended. */
function finished(commands: Commands, runId: string): Promise<{ text: string; run: CommandRun }> {
  return new Promise((resolve) => {
    let output = NO_OUTPUT;
    commands.follow(runId, 0, (event) => {
      if (event.kind === "output") output = appendOutput(output, event.at, event.text);
      else resolve({ text: outputString(output), run: event.run });
    });
  });
}

/** Until `text` has been printed. */
function printed(commands: Commands, runId: string, text: string): Promise<string> {
  return new Promise((resolve) => {
    let output = NO_OUTPUT;
    let done = false;
    const stop = commands.follow(runId, 0, (event) => {
      if (event.kind !== "output" || done) return;
      output = appendOutput(output, event.at, event.text);
      if (outputString(output).includes(text)) {
        done = true;
        queueMicrotask(stop);
        resolve(outputString(output));
      }
    });
  });
}

/** Whether a process is still there (a zombie nobody reaped yet counts as gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
}

describe("the runner", () => {
  it("streams stdout and stderr as they come, in the workspace's folder, and ends with the exit code", async () => {
    const { commands, dir } = runner();
    const run = commands.start({
      workspaceId: "ws_a",
      command: "pwd; printf 'one\\n'; sleep 0.2; printf 'two\\n' >&2; exit 3",
      by,
    });
    expect(run).toMatchObject({ status: "running", cwd: dir, command: run.command, exitCode: null });
    const { text, run: ended } = await finished(commands, run.id);
    expect(text).toBe(`${dir}\none\ntwo\n`);
    expect(ended).toMatchObject({ status: "exited", exitCode: 3, signal: null, stopping: false });
    expect(ended.endedAt).toBeGreaterThanOrEqual(ended.startedAt + 150);
    expect(commands.list("ws_a").map((r) => r.status)).toEqual(["exited"]);
  });

  it("Stop ends the whole process group, and a late follower gets what was printed and the end", async () => {
    const { commands } = runner();
    const run = commands.start({ workspaceId: "ws_a", command: "sleep 60 & echo child $!; sleep 60", by });
    const shown = await printed(commands, run.id, "child ");
    const child = Number(/child (\d+)/.exec(shown)?.[1]);
    expect(alive(child)).toBe(true);
    expect(commands.stop(run.id)).toMatchObject({ status: "running", stopping: true });
    const { text, run: ended } = await finished(commands, run.id);
    expect(ended.status).toBe("stopped");
    expect(ended.signal).toBe("SIGTERM");
    expect(text).toBe(shown);
    expect(await gone(child)).toBe(true);
  });

  it("Stop sends SIGKILL after the grace period to what ignores SIGTERM", async () => {
    const { commands } = runner();
    const run = commands.start({
      workspaceId: "ws_a",
      command: "trap '' TERM; echo ready; sleep 60; echo late",
      by,
    });
    await printed(commands, run.id, "ready");
    commands.stop(run.id);
    const started = Date.now();
    const { text, run: ended } = await finished(commands, run.id);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(ended).toMatchObject({ status: "stopped", signal: "SIGKILL" });
    expect(text).not.toContain("late");
  });

  it("stops what the shell left running in its group when it exits", async () => {
    const { commands } = runner();
    const run = commands.start({ workspaceId: "ws_a", command: "sleep 60 > /dev/null & echo $!", by });
    const { text, run: ended } = await finished(commands, run.id);
    expect(ended).toMatchObject({ status: "exited", exitCode: 0 });
    expect(await gone(Number(text.trim()))).toBe(true);
  });

  it("keeps the start and the end of a long output, and says where the middle was dropped", async () => {
    const { commands } = runner({ limits: { head: 10, tail: 40 } });
    const run = commands.start({ workspaceId: "ws_a", command: "seq 1 2000", by });
    await finished(commands, run.id);
    // A follower that comes after gets what was kept: the start, a gap, the end.
    const { text } = await finished(commands, run.id);
    expect(text.startsWith("1\n2\n3\n4\n5\n")).toBe(true);
    expect(text).toContain("characters of output dropped here");
    expect(text.endsWith("1998\n1999\n2000\n")).toBe(true);
    expect(text.length).toBeLessThan(250);
  });

  it("keeps a workspace's newest runs, never one that still runs", async () => {
    const { commands } = runner({ keep: 2 });
    const long = commands.start({ workspaceId: "ws_a", command: "sleep 60", by });
    for (const n of [1, 2, 3]) {
      const run = commands.start({ workspaceId: "ws_a", command: `echo ${n}`, by });
      await finished(commands, run.id);
    }
    expect(commands.list("ws_a").map((r) => r.command)).toEqual(["echo 3", "sleep 60"]);
    expect(() => commands.start({ workspaceId: "ws_a", command: "sleep 1", by })).not.toThrow();
    expect(() => commands.start({ workspaceId: "ws_a", command: "sleep 1", by })).toThrow(/stop one/);
    commands.stop(long.id);
  });

  it("refuses an archived workspace, and says when the command can't start", async () => {
    expect(() =>
      runner({ archived: true }).commands.start({ workspaceId: "ws_a", command: "true", by }),
    ).toThrow(/scratch is archived: unarchive the workspace/);
    const { commands, dir } = runner();
    fs.rmSync(dir, { recursive: true });
    expect(() => commands.start({ workspaceId: "ws_a", command: "true", by })).toThrow(/no longer exists/);
  });

  it("gives commands the server's environment without rowrow's credentials", async () => {
    const env = commandEnv(
      {
        PATH: "/bin",
        HOME: "/h",
        ROWROW_TOKEN: "secret",
        ROWROW_URL: "http://x",
        ROWROW_AGENT_ID: "ag_1",
        ROWROW_HOME: "/r",
      },
      "work",
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", ROWROW_HOME: "/r", ROWROW_PROFILE: "work" });
    const { commands } = runner({
      env: () => commandEnv({ ...process.env, SHELL: "/bin/sh", ROWROW_TOKEN: "secret" }, "test"),
    });
    const run = commands.start({ workspaceId: "ws_a", command: 'echo "token=${ROWROW_TOKEN:-none}"', by });
    expect((await finished(commands, run.id)).text).toBe("token=none\n");
  });

  it("stops every run when the server closes", async () => {
    const { commands } = runner();
    const run = commands.start({ workspaceId: "ws_a", command: "echo started; sleep 60", by });
    await printed(commands, run.id, "started");
    const ended = finished(commands, run.id);
    await commands.close();
    expect((await ended).run.status).toBe("stopped");
    expect(() => commands.start({ workspaceId: "ws_a", command: "true", by })).toThrow(/stopping/);
  });
});

describe("what screens and agents read of a run", () => {
  const run: CommandRun = {
    id: "cmd_1",
    workspaceId: "ws_a",
    command: "pnpm test",
    cwd: "/w",
    by,
    startedAt: 1000,
    endedAt: 3500,
    status: "exited",
    exitCode: 1,
    signal: null,
    stopping: false,
    error: null,
  };

  it("shows output as a terminal would, without colors or progress redraws", () => {
    expect(terminalText("\x1b[31mred\x1b[0m plain\x1b]0;title\x07\n")).toBe("red plain\n");
    expect(terminalText("10%\r50%\r100%\ndone\r\n")).toBe("100%\ndone\n");
  });

  it("puts the command, how it ended and the end of its output in the composer", () => {
    expect(commandReport(run, "\x1b[32mok\x1b[0m 3 passed\nFAIL a.test.ts\n")).toBe(
      "`pnpm test` exited with code 1 after 2.5s. Its output:\n\n```\nok 3 passed\nFAIL a.test.ts\n```\n",
    );
    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const report = commandReport({ ...run, status: "stopped" }, long);
    expect(report).toMatch(/^`pnpm test` was stopped after 2\.5s\. The last 200 lines of its output:/);
    expect(report).toContain("line 299\n```");
    expect(report).not.toContain("line 99\n");
    expect(commandReport(run, "```js\nx\n```")).toContain("````\n```js\nx\n```\n````");
    expect(commandReport({ ...run, exitCode: 0 }, "")).toBe(
      "`pnpm test` exited with code 0 after 2.5s. It printed nothing.\n",
    );
  });

  it("follows output from a cursor, marking what the server dropped", () => {
    const limits = { head: 4, tail: 4 };
    let kept = NO_OUTPUT;
    for (const piece of ["abc", "defgh"]) kept = appendOutput(kept, kept.cursor, piece, limits);
    expect(kept).toEqual({ head: "abcd", tail: "efgh", dropped: 0, cursor: 8 });
    // A piece already had changes nothing; the tail is cut back once it's a quarter over.
    expect(appendOutput(kept, 5, "fgh", limits)).toBe(kept);
    kept = appendOutput(kept, 8, "i", limits);
    expect(kept).toEqual({ head: "abcd", tail: "efghi", dropped: 0, cursor: 9 });
    for (const piece of ["jklmnop", "qrstu"]) kept = appendOutput(kept, kept.cursor, piece, limits);
    expect(kept).toEqual({ head: "abcd", tail: "rstu", dropped: 13, cursor: 21 });
    expect(outputSince(kept, 2)).toEqual([
      { at: 2, text: "cd" },
      { at: 17, text: "rstu" },
    ]);
    let client = NO_OUTPUT;
    for (const piece of outputSince(kept, 0)) client = appendOutput(client, piece.at, piece.text);
    expect(outputString(client)).toMatch(/^abcd\n\[… 13 characters of output dropped here.*\]\nrstu$/);
  });
});

describe("over the API", () => {
  /** What a failed call says, and its code. */
  async function failure(call: Promise<unknown>): Promise<{ code: string; message: string }> {
    try {
      await call;
    } catch (error) {
      if (error instanceof ORPCError) return { code: error.code as string, message: error.message };
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  it("runs a command, streams its output to its end, and stops runs when the workspace is archived", async () => {
    t = await startTestServer();
    const ws = await t.client.workspaces.add({ path: t.repo() });
    const run = await t.client.commands.run({ workspaceId: ws.id, command: "git status --short; echo hi" });
    const events = [];
    for await (const event of await t.client.commands.output({ runId: run.id })) events.push(event);
    const text = events.flatMap((e) => (e.kind === "output" ? [e.text] : [])).join("");
    expect(text).toBe("hi\n");
    expect(events.at(-1)).toMatchObject({ kind: "end", run: { status: "exited", exitCode: 0 } });
    expect((await t.client.commands.list({ workspaceId: ws.id })).map((r) => r.id)).toEqual([run.id]);

    const long = await t.client.commands.run({ workspaceId: ws.id, command: "sleep 60" });
    // follow: false reads what is kept now, without waiting for the end.
    const now = [];
    for await (const event of await t.client.commands.output({ runId: long.id, follow: false }))
      now.push(event);
    expect(now).toEqual([]);
    await t.client.workspaces.update({ id: ws.id, archived: true });
    expect((await t.client.commands.list({ workspaceId: ws.id }))[0]).toMatchObject({
      id: long.id,
      status: "stopped",
    });
    expect(await failure(t.client.commands.run({ workspaceId: ws.id, command: "true" }))).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/is archived: unarchive the workspace/),
    });
    expect(await failure(t.client.commands.stop({ runId: "cmd_nope" }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("is what `rowrow ws run|runs|output` do, exiting with the command's status", async () => {
    const server = await startTestServer();
    t = server;
    const ws = await server.client.workspaces.add({ path: server.repo() });
    const rowrow = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          [path.resolve(import.meta.dirname, "../src/cli/main.ts"), ...args],
          { env: { ...process.env, ROWROW_URL: server.server.url, ROWROW_TOKEN: server.token } },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
      }
    };
    const ran = await rowrow("ws", "run", ws.id, "--", "echo out; echo err >&2; exit 4");
    expect(ran.code).toBe(4);
    expect(ran.stdout).toBe("out\nerr\n");
    expect(ran.stderr).toMatch(/^rowrow: exit 4 after \d/);
    expect(await rowrow("ws", "run", ws.id, "--", "printf", "%s-%s", "a", "b")).toMatchObject({
      code: 0,
      stdout: "a-b",
    });
    const [last, first] = await server.client.commands.list({ workspaceId: ws.id });
    expect((await rowrow("ws", "runs", ws.id)).stdout).toMatch(
      new RegExp(`^${last?.id} +exit 0 .*printf %s-%s a b\n${first?.id} +exit 4 .*echo out`),
    );
    expect(await rowrow("ws", "output", first?.id ?? "")).toMatchObject({ code: 0, stdout: "out\nerr\n" });
  });
});
