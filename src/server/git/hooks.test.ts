import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveHooks, runHook } from "./hooks.ts";
import { isolateGit, removeDir, tempDir, write } from "./testing.ts";

beforeAll(isolateGit);

let tmp: string;
let target: string;
let source: string;

beforeEach(() => {
  tmp = tempDir();
  target = path.join(tmp, "worktree");
  source = path.join(tmp, "repo");
  fs.mkdirSync(target);
  fs.mkdirSync(source);
});

afterEach(() => removeDir(tmp));

const config = (setup: string): string => JSON.stringify({ worktree: { setup } });

describe("resolveHooks", () => {
  it("takes the first existing file: rowrow, roamgate, paseo; target before source", async () => {
    const order = [
      [target, "rowrow.json"],
      [source, "rowrow.json"],
      [target, "roamgate.json"],
      [source, "roamgate.json"],
      [target, "paseo.json"],
      [source, "paseo.json"],
    ] as const;
    for (const [dir, name] of order) write(dir, name, config(`${path.basename(dir)}/${name}`));
    for (const [dir, name] of order) {
      const resolved = await resolveHooks({ target, source });
      expect(resolved).toEqual({
        path: path.join(dir, name),
        legacy: name !== "rowrow.json",
        worktree: { setup: `${path.basename(dir)}/${name}` },
      });
      fs.rmSync(path.join(dir, name));
    }
    expect(await resolveHooks({ target, source })).toBeNull();
  });

  it("never merges or falls back past a valid file without the hook", async () => {
    write(target, "rowrow.json", JSON.stringify({ worktree: { teardown: "make clean" } }));
    write(source, "rowrow.json", JSON.stringify({ worktree: { setup: "make", teardown: "other" } }));
    expect(await resolveHooks({ target, source })).toEqual({
      path: path.join(target, "rowrow.json"),
      legacy: false,
      worktree: { teardown: "make clean" },
    });
    write(target, "rowrow.json", "{}");
    expect((await resolveHooks({ target, source }))?.worktree).toEqual({});
  });

  it("reads the source once the target is gone", async () => {
    write(source, "rowrow.json", JSON.stringify({ worktree: { removed: "echo bye" } }));
    fs.rmSync(target, { recursive: true });
    expect((await resolveHooks({ target, source }))?.worktree).toEqual({ removed: "echo bye" });
  });

  it("throws on invalid JSON, wrong types, unknown hooks and unreadable files instead of falling back", async () => {
    write(source, "rowrow.json", config("fine"));
    write(target, "rowrow.json", "{ not json");
    await expect(resolveHooks({ target, source })).rejects.toThrow(/rowrow\.json is not valid JSON/);
    write(target, "rowrow.json", JSON.stringify({ worktree: { setup: 1 } }));
    await expect(resolveHooks({ target, source })).rejects.toThrow(/"worktree.setup" must be a string/);
    write(target, "rowrow.json", JSON.stringify({ worktree: ["make"] }));
    await expect(resolveHooks({ target, source })).rejects.toThrow(/"worktree" must be an object/);
    write(target, "rowrow.json", "[]");
    await expect(resolveHooks({ target, source })).rejects.toThrow(/expected a JSON object/);
    write(target, "rowrow.json", JSON.stringify({ worktree: { setpu: "make" } }));
    await expect(resolveHooks({ target, source })).rejects.toThrow(/unknown hook "worktree.setpu"/);
    fs.rmSync(path.join(target, "rowrow.json"));
    fs.mkdirSync(path.join(target, "rowrow.json"));
    await expect(resolveHooks({ target, source })).rejects.toThrow(/cannot read/);
  });

  it("ignores other tools' extra hooks in their files, and blank commands", async () => {
    write(
      target,
      "paseo.json",
      JSON.stringify({ other: true, worktree: { setup: "make", archive: "x", teardown: " " } }),
    );
    expect(await resolveHooks({ target, source })).toEqual({
      path: path.join(target, "paseo.json"),
      legacy: true,
      worktree: { setup: "make" },
    });
  });
});

describe("runHook", () => {
  const base = () => ({ event: "setup" as const, cwd: target, worktreePath: target, sourcePath: source });

  it("runs in cwd with the hook environment and captures stdout and stderr", async () => {
    const run = await runHook({
      ...base(),
      command:
        'echo "$ROWROW_HOOK_EVENT|$ROWROW_WORKTREE_PATH|$ROWROW_SOURCE_PATH|$EXTRA"; pwd -P; echo oops >&2',
      env: { EXTRA: "x" },
    });
    expect(run).toMatchObject({ ok: true, code: 0, timedOut: false });
    expect(run.output).toContain(`setup|${target}|${source}|x\n`);
    expect(run.output).toContain(`${target}\n`);
    expect(run.output).toContain("oops\n");
  });

  it("reports a failure with its exit code and output", async () => {
    const run = await runHook({ ...base(), command: "echo boom; exit 3" });
    expect(run).toMatchObject({ ok: false, code: 3, timedOut: false, output: "boom\n" });
  });

  it("kills the whole process group on timeout", async () => {
    const pidFile = path.join(tmp, "pid");
    const run = await runHook({
      ...base(),
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      timeoutMs: 300,
    });
    expect(run).toMatchObject({ ok: false, timedOut: true });
    expect(run.ms).toBeLessThan(5000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });

  it("doesn't wait for background processes that keep the output open", async () => {
    const run = await runHook({ ...base(), command: "sleep 3 & echo started" });
    expect(run).toMatchObject({ ok: true, output: "started\n" });
    expect(run.ms).toBeLessThan(2500);
  });

  it("keeps only the tail of very long output", async () => {
    const run = await runHook({
      ...base(),
      command: "head -c 300000 /dev/zero | tr '\\0' a; echo; echo last",
    });
    expect(run.ok).toBe(true);
    expect(run.output.length).toBeLessThan(200 * 1024 + 100);
    expect(run.output).toMatch(/^\[\d+ earlier bytes of output dropped\]\n/);
    expect(run.output.endsWith("a\nlast\n")).toBe(true);
  });

  it("fails cleanly when the directory doesn't exist", async () => {
    const run = await runHook({ ...base(), cwd: path.join(tmp, "missing"), command: "true" });
    expect(run.ok).toBe(false);
    expect(run.output).toContain("cannot run the hook");
  });
});
