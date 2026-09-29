// The workspace inspector end to end, in-process: file actions on the working tree (with
// the staleness check), commit history, search and file previews, and the branch's pull
// request through a fake `gh`. Driven through the real typed client over HTTP, as the web
// app, the CLI and agents use it. No network.
import { ORPCError } from "@orpc/client";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChangedFile, Changes } from "../src/shared/schemas.ts";
import { commitAll, isolateGit, removeDir, sh, tempDir, write } from "../src/server/git/testing.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

beforeAll(isolateGit);

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), "utf8");

/** What a failed call says, and its code (CONFLICT, BAD_REQUEST…). */
async function failure(call: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ORPCError) return { code: error.code as string, message: error.message };
    throw error;
  }
  throw new Error("expected the call to fail");
}

async function workspace(server: TestServer, files: Record<string, string> = {}) {
  const repo = server.repo();
  for (const [file, content] of Object.entries(files)) write(repo, file, content);
  if (Object.keys(files).length > 0) commitAll(repo, "files");
  const ws = await server.client.workspaces.add({ path: repo });
  return { repo, id: ws.id };
}

describe("file actions", () => {
  const list = async (id: string): Promise<Changes> =>
    t!.client.git.changes({ workspaceId: id, scope: "working" });
  const row = (changes: Changes, file: string): ChangedFile => {
    const found = changes.files.find((f) => f.path === file);
    if (found === undefined) throw new Error(`${file} is not in the list`);
    return found;
  };
  const seen = (file: ChangedFile) => ({ path: file.path, oldPath: file.oldPath, stamp: file.stamp ?? "" });

  it("stages, unstages, discards and deletes what the list showed", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "a.txt": "a1\n", "b.txt": "b1\n" });
    write(repo, "a.txt", "a2\n");
    write(repo, "b.txt", "b2\n");
    sh(repo, "add", "b.txt");
    write(repo, "new.txt", "new\n");
    let changes = await list(id);
    expect(changes.files.map((f) => [f.path, f.status, f.staged, f.unstaged])).toEqual([
      ["a.txt", "modified", false, true],
      ["b.txt", "modified", true, false],
      ["new.txt", "untracked", false, true],
    ]);

    ({ changes } = await t.client.git.fileAction({
      workspaceId: id,
      action: "stage",
      ...seen(row(changes, "a.txt")),
    }));
    expect(row(changes, "a.txt")).toMatchObject({ staged: true, unstaged: false });
    expect(sh(repo, "diff", "--cached", "--name-only")).toBe("a.txt\nb.txt\n");

    const unstaged = await t.client.git.fileAction({
      workspaceId: id,
      action: "unstage",
      ...seen(row(changes, "b.txt")),
    });
    expect(unstaged.paths).toEqual(["b.txt"]);
    changes = unstaged.changes;
    expect(row(changes, "b.txt")).toMatchObject({ staged: false, unstaged: true });
    expect(read(repo, "b.txt")).toBe("b2\n"); // unstaging keeps the edit

    ({ changes } = await t.client.git.fileAction({
      workspaceId: id,
      action: "discardUnstaged",
      ...seen(row(changes, "b.txt")),
    }));
    expect(read(repo, "b.txt")).toBe("b1\n");
    expect(changes.files.map((f) => f.path)).toEqual(["a.txt", "new.txt"]);

    ({ changes } = await t.client.git.fileAction({
      workspaceId: id,
      action: "deleteUntracked",
      ...seen(row(changes, "new.txt")),
    }));
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(false);
    expect(changes.files.map((f) => f.path)).toEqual(["a.txt"]);
    // AppState's git facts follow, so every client's counts update.
    expect((await t.client.state.get()).state.workspaces[id]?.git?.changed).toBe(1);
  });

  it("discarding unstaged edits keeps the staged version", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "a.txt": "v1\n" });
    write(repo, "a.txt", "v2\n");
    sh(repo, "add", "a.txt");
    write(repo, "a.txt", "v3\n");
    const changes = await list(id);
    await t.client.git.fileAction({
      workspaceId: id,
      action: "discardUnstaged",
      ...seen(row(changes, "a.txt")),
    });
    expect(read(repo, "a.txt")).toBe("v2\n");
    expect(sh(repo, "diff", "--cached", "--name-only")).toBe("a.txt\n");
  });

  it("refuses to act on a file that changed after the list was loaded, and leaves it alone", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "a.txt": "one\n" });
    write(repo, "a.txt", "two\n");
    write(repo, "notes.txt", "draft\n");
    const changes = await list(id);
    // The agent keeps working after you looked.
    write(repo, "a.txt", "two, and newer work\n");
    fs.appendFileSync(path.join(repo, "notes.txt"), "more\n");

    const discard = await failure(
      t.client.git.fileAction({ workspaceId: id, action: "discardUnstaged", ...seen(row(changes, "a.txt")) }),
    );
    expect(discard).toEqual({
      code: "CONFLICT",
      message: "a.txt changed since this list was loaded: refresh and try again",
    });
    expect(read(repo, "a.txt")).toBe("two, and newer work\n");

    const remove = await failure(
      t.client.git.fileAction({
        workspaceId: id,
        action: "deleteUntracked",
        ...seen(row(changes, "notes.txt")),
      }),
    );
    expect(remove.code).toBe("CONFLICT");
    expect(read(repo, "notes.txt")).toBe("draft\nmore\n");

    // Staging what you didn't see is refused too; a fresh list works.
    expect(
      (
        await failure(
          t.client.git.fileAction({ workspaceId: id, action: "stage", ...seen(row(changes, "a.txt")) }),
        )
      ).code,
    ).toBe("CONFLICT");
    const fresh = await list(id);
    await t.client.git.fileAction({ workspaceId: id, action: "stage", ...seen(row(fresh, "a.txt")) });
    expect(sh(repo, "diff", "--cached", "--name-only")).toBe("a.txt\n");
  });

  it("acts on both paths of a rename", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "old.txt": "same content\n" });
    sh(repo, "mv", "old.txt", "new.txt");
    let changes = await list(id);
    expect(changes.files.map((f) => [f.oldPath, f.path, f.status, f.staged])).toEqual([
      ["old.txt", "new.txt", "renamed", true],
    ]);
    const unstaged = await t.client.git.fileAction({
      workspaceId: id,
      action: "unstage",
      ...seen(row(changes, "new.txt")),
    });
    expect(unstaged.paths).toEqual(["old.txt", "new.txt"]);
    changes = unstaged.changes;
    expect(changes.files.map((f) => [f.path, f.status])).toEqual([
      ["new.txt", "untracked"],
      ["old.txt", "deleted"],
    ]);
    await t.client.git.bulkAction({ workspaceId: id, action: "stageAll", files: changes.files.map(seen) });
    expect((await list(id)).files.map((f) => [f.oldPath, f.path, f.status])).toEqual([
      ["old.txt", "new.txt", "renamed"],
    ]);
  });

  it("refuses a bulk action that would touch a file the list didn't show", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "a.txt": "a\n", "b.txt": "b\n" });
    write(repo, "a.txt", "a, edited\n");
    const changes = await list(id);
    write(repo, "b.txt", "b, edited after you looked\n");
    const refused = await failure(
      t.client.git.bulkAction({
        workspaceId: id,
        action: "discardAllUnstaged",
        files: changes.files.map(seen),
      }),
    );
    expect(refused).toEqual({
      code: "CONFLICT",
      message: "b.txt wasn't in the list you acted on: refresh and try again",
    });
    expect(read(repo, "a.txt")).toBe("a, edited\n");
    expect(read(repo, "b.txt")).toBe("b, edited after you looked\n");

    // A file the list did show, edited again since: refused as well, nothing touched.
    const shown = await list(id);
    write(repo, "a.txt", "a, edited twice\n");
    expect(
      await failure(
        t.client.git.bulkAction({
          workspaceId: id,
          action: "discardAllUnstaged",
          files: shown.files.map(seen),
        }),
      ),
    ).toEqual({
      code: "CONFLICT",
      message: "a.txt changed since this list was loaded: refresh and try again",
    });
    expect([read(repo, "a.txt"), read(repo, "b.txt")]).toEqual([
      "a, edited twice\n",
      "b, edited after you looked\n",
    ]);

    const fresh = await list(id);
    const done = await t.client.git.bulkAction({
      workspaceId: id,
      action: "discardAllUnstaged",
      files: fresh.files.map(seen),
    });
    expect(done.paths).toEqual(["a.txt", "b.txt"]);
    expect([read(repo, "a.txt"), read(repo, "b.txt")]).toEqual(["a\n", "b\n"]);
  });

  it("stages, unstages and deletes everything at once, leaving conflicts alone", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "a.txt": "a\n", "c.txt": "base\n" });
    sh(repo, "checkout", "-q", "-b", "other");
    write(repo, "c.txt", "theirs\n");
    commitAll(repo, "theirs");
    sh(repo, "checkout", "-q", "main");
    write(repo, "c.txt", "ours\n");
    commitAll(repo, "ours");
    expect(() => sh(repo, "merge", "-q", "other")).toThrow();
    write(repo, "a.txt", "a, edited\n");
    write(repo, "u1.txt", "u1\n");
    write(repo, "dir/u2.txt", "u2\n");

    let changes = await list(id);
    expect(changes.files.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "modified"],
      ["c.txt", "conflicted"],
      ["dir/u2.txt", "untracked"],
      ["u1.txt", "untracked"],
    ]);
    const staged = await t.client.git.bulkAction({
      workspaceId: id,
      action: "stageAll",
      files: changes.files.map(seen),
    });
    expect(staged.paths).toEqual(["a.txt", "dir/u2.txt", "u1.txt"]);
    changes = staged.changes;
    expect(row(changes, "c.txt").status).toBe("conflicted");

    const unstaged = await t.client.git.bulkAction({
      workspaceId: id,
      action: "unstageAll",
      files: changes.files.map(seen),
    });
    expect(unstaged.paths).toEqual(["a.txt", "dir/u2.txt", "u1.txt"]);
    changes = unstaged.changes;
    expect(row(changes, "c.txt").status).toBe("conflicted");

    const deleted = await t.client.git.bulkAction({
      workspaceId: id,
      action: "deleteAllUntracked",
      files: changes.files.map(seen),
    });
    expect(deleted.paths).toEqual(["dir/u2.txt", "u1.txt"]);
    expect(deleted.changes.files.map((f) => f.path)).toEqual(["a.txt", "c.txt"]);
    expect(read(repo, "a.txt")).toBe("a, edited\n");

    expect(
      await failure(t.client.git.bulkAction({ workspaceId: id, action: "deleteAllUntracked", files: [] })),
    ).toEqual({ code: "BAD_REQUEST", message: "There are no untracked files." });
  });

  it("marks a conflict resolved only once its markers are gone", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "c.txt": "base\n" });
    sh(repo, "checkout", "-q", "-b", "other");
    write(repo, "c.txt", "theirs\n");
    commitAll(repo, "theirs");
    sh(repo, "checkout", "-q", "main");
    write(repo, "c.txt", "ours\n");
    commitAll(repo, "ours");
    expect(() => sh(repo, "merge", "-q", "other")).toThrow();

    let changes = await list(id);
    const stage = await failure(
      t.client.git.fileAction({ workspaceId: id, action: "stage", ...seen(row(changes, "c.txt")) }),
    );
    expect(stage.message).toMatch(/merge conflict: resolve it, then mark it resolved/);
    const early = await failure(
      t.client.git.fileAction({ workspaceId: id, action: "markResolved", ...seen(row(changes, "c.txt")) }),
    );
    expect(early).toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/conflict marker on line 1/),
    });

    write(repo, "c.txt", "ours and theirs\n");
    changes = await list(id);
    ({ changes } = await t.client.git.fileAction({
      workspaceId: id,
      action: "markResolved",
      ...seen(row(changes, "c.txt")),
    }));
    expect(row(changes, "c.txt")).toMatchObject({ status: "modified", staged: true, unstaged: false });
  });

  it("takes any file name literally, and refuses paths outside the worktree", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "a.txt": "a\n" });
    const names = ["-rf.txt", "with space.txt", "naïve 日本.txt", "*.txt", ":(top)x", 'quote"d.txt'];
    for (const name of names) write(repo, name, `${name}\n`);
    write(repo, "a.txt", "a, edited\n"); // `*.txt` must not stage this one
    let changes = await list(id);
    for (const name of names) {
      ({ changes } = await t.client.git.fileAction({
        workspaceId: id,
        action: "stage",
        ...seen(row(changes, name)),
      }));
    }
    expect(sh(repo, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean).sort()).toEqual(
      [...names].sort(),
    );
    ({ changes } = await t.client.git.fileAction({
      workspaceId: id,
      action: "unstage",
      ...seen(row(changes, "-rf.txt")),
    }));
    ({ changes } = await t.client.git.fileAction({
      workspaceId: id,
      action: "deleteUntracked",
      ...seen(row(changes, "-rf.txt")),
    }));
    expect(fs.existsSync(path.join(repo, "-rf.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(true);

    const stamp = row(changes, "a.txt").stamp ?? "";
    for (const bad of [
      "../outside.txt",
      "/etc/passwd",
      "a/../a.txt",
      "./a.txt",
      "a.txt/",
      ".git/config",
      "sub/.GIT/x",
    ]) {
      const refused = await failure(
        t.client.git.fileAction({ workspaceId: id, action: "stage", path: bad, stamp }),
      );
      expect(refused.code, bad).toBe("BAD_REQUEST");
    }
    // A clean file isn't a change to act on: its state isn't what any list showed.
    const clean = await failure(
      t.client.git.fileAction({ workspaceId: id, action: "discardUnstaged", path: "README.md", stamp }),
    );
    expect(clean.code).toBe("CONFLICT");
  });

  it("works before the first commit", async () => {
    t = await startTestServer();
    const repo = t.repo();
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "add", "README.md");
    const { id } = await t.client.workspaces.add({ path: repo });
    let changes = await list(id);
    expect(row(changes, "README.md")).toMatchObject({ status: "added", staged: true });
    ({ changes } = await t.client.git.fileAction({
      workspaceId: id,
      action: "unstage",
      ...seen(row(changes, "README.md")),
    }));
    expect(row(changes, "README.md")).toMatchObject({ status: "untracked", staged: false });
  });

  it("won't empty an intent-to-add file by discarding it", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t);
    write(repo, "ita.txt", "precious\n");
    sh(repo, "add", "-N", "ita.txt");
    const changes = await list(id);
    const refused = await failure(
      t.client.git.fileAction({
        workspaceId: id,
        action: "discardUnstaged",
        ...seen(row(changes, "ita.txt")),
      }),
    );
    expect(refused.message).toMatch(/intent-to-add/);
    expect(read(repo, "ita.txt")).toBe("precious\n");
  });
});

describe("history", () => {
  it("pages through the branch's commits, even when the branch moves meanwhile", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t);
    for (let i = 1; i <= 120; i++)
      sh(repo, "commit", "-q", "--allow-empty", "-m", `commit ${i}`, "-m", `body ${i}`);
    const first = await t.client.git.log({ workspaceId: id });
    expect(first.branch).toBe("main");
    expect(first.commits).toHaveLength(50);
    expect(first.commits[0]).toMatchObject({ subject: "commit 120", authorName: "rowrow test" });
    expect(first.commits[0]?.parents).toHaveLength(1);
    expect(Math.abs((first.commits[0]?.authorDate ?? 0) - Date.now())).toBeLessThan(60_000);

    sh(repo, "commit", "-q", "--allow-empty", "-m", "pushed while you scrolled");
    const second = await t.client.git.log({ workspaceId: id, cursor: first.nextCursor ?? "" });
    expect(second.commits.map((c) => c.subject)).toEqual(
      Array.from({ length: 50 }, (_, i) => `commit ${70 - i}`),
    );
    const third = await t.client.git.log({ workspaceId: id, cursor: second.nextCursor ?? "" });
    expect(third.commits.map((c) => c.subject).at(-1)).toBe("init");
    expect(third.commits).toHaveLength(21);
    expect(third.nextCursor).toBeNull();
    expect(third.shallow).toBe(false);

    const again = await t.client.git.log({ workspaceId: id, limit: 1 });
    expect(again.commits[0]?.subject).toBe("pushed while you scrolled");
    expect((await failure(t.client.git.log({ workspaceId: id, cursor: "HEAD~3:0" }))).code).toBe(
      "BAD_REQUEST",
    );
  });

  it("compares a commit with its parent, a root commit with the empty tree, a merge with its first parent", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "cart.ts": "total = 1\n", "logo.png": "\x89PNG\0\0" });
    const root = sh(repo, "rev-list", "--max-parents=0", "HEAD").trim();
    write(repo, "cart.ts", "total = 2\n");
    sh(repo, "mv", "logo.png", "brand.png");
    const normal = commitAll(repo, "Fix totals\n\nRound to the cent.");
    sh(repo, "checkout", "-q", "-b", "feature");
    write(repo, "feature.ts", "export const on = true;\n");
    const featureTip = commitAll(repo, "Add a feature");
    sh(repo, "checkout", "-q", "main");
    write(repo, "main.ts", "main\n");
    const mainTip = commitAll(repo, "Meanwhile on main");
    sh(repo, "merge", "-q", "--no-ff", "-m", "Merge feature", "feature");
    const merge = sh(repo, "rev-parse", "HEAD").trim();
    write(repo, "cart.ts", "uncommitted, never part of history\n");

    const rootCommit = await t.client.git.commit({ workspaceId: id, sha: root });
    expect(rootCommit).toMatchObject({ base: null, baseLabel: "Root commit: compared with the empty tree" });
    expect(rootCommit.files.map((f) => [f.path, f.status])).toEqual([["README.md", "added"]]);

    const fix = await t.client.git.commit({ workspaceId: id, sha: normal.slice(0, 10) });
    expect(fix.commit).toMatchObject({
      sha: normal,
      subject: "Fix totals",
      message: "Fix totals\n\nRound to the cent.",
      committerName: "rowrow test",
    });
    expect(fix.base).toBe(fix.commit.parents[0]);
    expect(fix.baseLabel).toMatch(/^Compared with its parent [0-9a-f]{7}$/);
    expect(fix.files.map((f) => [f.path, f.oldPath, f.status, f.additions])).toEqual([
      ["brand.png", "logo.png", "renamed", null],
      ["cart.ts", null, "modified", 1],
    ]);
    const patch = await t.client.git.commitDiff({ workspaceId: id, sha: normal, path: "cart.ts" });
    expect(patch.patch).toContain("-total = 1");
    expect(patch.patch).toContain("+total = 2");
    expect(patch.patch).not.toContain("uncommitted");

    const merged = await t.client.git.commit({ workspaceId: id, sha: merge });
    expect(merged.commit.parents).toEqual([mainTip, featureTip]);
    expect(merged.base).toBe(mainTip);
    expect(merged.baseLabel).toBe(`Merge commit: compared with its first parent ${mainTip.slice(0, 7)}`);
    expect(merged.files.map((f) => f.path)).toEqual(["feature.ts"]);
    const mergePatch = await t.client.git.commitDiff({ workspaceId: id, sha: merge, path: "feature.ts" });
    expect(mergePatch.patch).toContain("+export const on = true;");

    for (const sha of ["HEAD~1", "--output=/tmp/x", "zzzz"])
      expect((await failure(t.client.git.commit({ workspaceId: id, sha }))).code, sha).toBe("BAD_REQUEST");
    expect(
      (await failure(t.client.git.commit({ workspaceId: id, sha: "0123456789abcdef" }))).message,
    ).toMatch(/no commit 0123456789abcdef/);
    expect(
      (await failure(t.client.git.commitDiff({ workspaceId: id, sha: normal, path: "../etc/passwd" }))).code,
    ).toBe("BAD_REQUEST");
  });

  it("says when there are no commits yet", async () => {
    t = await startTestServer();
    const repo = t.repo();
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    sh(repo, "init", "-q", "-b", "main");
    const { id } = await t.client.workspaces.add({ path: repo });
    expect(await t.client.git.log({ workspaceId: id })).toMatchObject({
      branch: "main",
      head: null,
      commits: [],
      nextCursor: null,
      note: "No commits yet.",
    });
  });
});

describe("search", () => {
  it("finds file names and lines in tracked and untracked files, honoring .gitignore and skipping binaries", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, {
      ".gitignore": "ignored/\n*.log\n",
      "src/cart.ts": "export const needle = 1;\n",
      "src/needle-helpers.ts": "// helpers\n",
      "docs/guide.md": "# Guide\n\nNo match here.\n",
    });
    write(repo, "notes/draft.md", "A Needle in the draft\n"); // untracked
    write(repo, "ignored/secret.txt", "needle\n");
    write(repo, "debug.log", "needle\n");
    write(repo, "blob.bin", Buffer.from("needle\0binary"));

    const all = await t.client.files.search({ workspaceId: id, query: "needle" });
    expect(all.names.map((n) => n.path)).toEqual(["src/needle-helpers.ts"]);
    expect(all.lines).toEqual([
      { path: "notes/draft.md", line: 1, text: "A Needle in the draft" },
      { path: "src/cart.ts", line: 1, text: "export const needle = 1;" },
    ]);
    expect([all.namesTruncated, all.linesTruncated, all.note]).toEqual([false, false, null]);

    const exact = await t.client.files.search({ workspaceId: id, query: "Needle", kind: "content" });
    expect(exact.lines.map((l) => l.path)).toEqual(["notes/draft.md"]);
    expect(exact.names).toEqual([]);

    const byName = await t.client.files.search({ workspaceId: id, query: "src cart", kind: "names" });
    expect(byName.names).toEqual([{ path: "src/cart.ts" }]);
    expect(byName.lines).toEqual([]);

    const dash = await t.client.files.search({ workspaceId: id, query: "--output=x", kind: "content" });
    expect(dash.lines).toEqual([]);
  });

  it("bounds its results and says so", async () => {
    t = await startTestServer();
    const files: Record<string, string> = {};
    for (let i = 0; i < 250; i++) files[`many/file-${String(i).padStart(3, "0")}.txt`] = "hit\nhit again\n";
    const { id } = await workspace(t, files);
    const result = await t.client.files.search({ workspaceId: id, query: "file" });
    expect(result.names).toHaveLength(200);
    expect(result.namesTruncated).toBe(true);
    const lines = await t.client.files.search({ workspaceId: id, query: "hit", kind: "content" });
    expect(lines.lines).toHaveLength(200);
    expect(lines.linesTruncated).toBe(true);
    expect(lines.lines[1]).toEqual({ path: "many/file-000.txt", line: 2, text: "hit again" });
  });

  it("previews a text file, and refuses binaries and anything outside the checkout", async () => {
    t = await startTestServer();
    const { repo, id } = await workspace(t, { "src/cart.ts": "line 1\nline 2\n" });
    write(repo, "blob.bin", Buffer.from([1, 0, 2]));
    fs.symlinkSync("/etc/hosts", path.join(repo, "escape"));
    fs.symlinkSync("src/cart.ts", path.join(repo, "alias"));

    expect(await t.client.files.read({ workspaceId: id, path: "src/cart.ts" })).toEqual({
      path: "src/cart.ts",
      text: "line 1\nline 2\n",
      size: 14,
      truncated: false,
    });
    expect((await t.client.files.read({ workspaceId: id, path: "alias" })).text).toBe("line 1\nline 2\n");
    const refusals: Record<string, RegExp> = {
      "blob.bin": /binary/,
      escape: /outside the checkout/,
      src: /isn't a file/,
      "../x": /invalid path/,
      "/etc/hosts": /invalid path/,
      ".git/config": /inside .git/,
      "missing.txt": /doesn't exist/,
    };
    for (const [file, message] of Object.entries(refusals)) {
      const refused = await failure(t.client.files.read({ workspaceId: id, path: file }));
      expect(refused.code, file).toBe("BAD_REQUEST");
      expect(refused.message, file).toMatch(message);
    }
  });

  it("cuts a long file at 1 MiB, on a line", async () => {
    t = await startTestServer();
    const line = `${"x".repeat(99)}\n`;
    const { id } = await workspace(t, { "big.txt": line.repeat(11_000) });
    const big = await t.client.files.read({ workspaceId: id, path: "big.txt" });
    expect(big.truncated).toBe(true);
    expect(big.size).toBe(1_100_000);
    expect(big.text.length).toBeLessThanOrEqual(1024 * 1024);
    expect(big.text.endsWith("\n")).toBe(true);
  });
});

describe("pull request", () => {
  /** A fake gh that answers with whatever the test wrote next to it, and records how it was run. */
  function fakeGh(dir: string) {
    const gh = path.join(dir, "gh");
    fs.writeFileSync(
      gh,
      [
        "#!/bin/sh",
        'here=$(dirname "$0")',
        'echo "$*" >> "$here/calls"',
        'pwd > "$here/cwd"',
        'cat "$here/stdout" 2>/dev/null',
        'cat "$here/stderr" >&2 2>/dev/null',
        'exit "$(cat "$here/code" 2>/dev/null || echo 0)"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const answer = (stdout: unknown, code = 0, stderr = ""): void => {
      fs.writeFileSync(
        path.join(dir, "stdout"),
        typeof stdout === "string" ? stdout : JSON.stringify(stdout),
      );
      fs.writeFileSync(path.join(dir, "stderr"), stderr);
      fs.writeFileSync(path.join(dir, "code"), String(code));
    };
    const calls = (): string[] =>
      fs.existsSync(path.join(dir, "calls"))
        ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n")
        : [];
    return { gh, answer, calls, cwd: () => fs.readFileSync(path.join(dir, "cwd"), "utf8").trim() };
  }

  const pr = (extra: Record<string, unknown>) => ({
    number: 42,
    title: "Round cart totals to the cent",
    url: "https://github.com/acme/shop/pull/42",
    state: "OPEN",
    isDraft: false,
    author: { login: "ada" },
    headRefName: "fix/cart",
    baseRefName: "main",
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [],
    updatedAt: "2026-09-28T14:06:25Z",
    ...extra,
  });

  it("reads the branch's pull request with gh, in every state gh can answer", async () => {
    const ghDir = tempDir();
    const fake = fakeGh(ghDir);
    t = await startTestServer({ gh: fake.gh });
    const { repo, id } = await workspace(t);
    sh(repo, "checkout", "-q", "-b", "fix/cart");
    sh(repo, "remote", "add", "origin", "git@github.com:acme/shop.git");
    await t.client.workspaces.refresh({ id });
    const ask = () => t!.client.git.pullRequest({ workspaceId: id, refresh: true });

    fake.answer(
      pr({
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "StatusContext", context: "deploy", state: "PENDING" },
        ],
      }),
    );
    const open = await ask();
    expect(open).toMatchObject({
      state: "found",
      message: null,
      branch: "fix/cart",
      pr: {
        number: 42,
        title: "Round cart totals to the cent",
        url: "https://github.com/acme/shop/pull/42",
        state: "open",
        author: "ada",
        head: "fix/cart",
        base: "main",
        review: "review_required",
        checks: { state: "failing", total: 3, passed: 1, failed: 1, pending: 1 },
      },
    });
    expect(Math.abs(open.checkedAt - Date.now())).toBeLessThan(10_000);
    expect(fake.cwd()).toBe(repo);
    expect(fake.calls().at(-1)).toMatch(/^pr view --json number,title,url,state,isDraft,/);

    fake.answer(pr({ isDraft: true, reviewDecision: "", statusCheckRollup: [] }));
    expect((await ask()).pr).toMatchObject({
      state: "draft",
      review: "none",
      checks: { state: "none", total: 0 },
    });

    fake.answer(
      pr({
        state: "MERGED",
        reviewDecision: "APPROVED",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    );
    expect((await ask()).pr).toMatchObject({
      state: "merged",
      review: "approved",
      checks: { state: "passing" },
    });

    fake.answer(
      pr({
        state: "CLOSED",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "BRAND_NEW" }],
      }),
    );
    expect((await ask()).pr).toMatchObject({ state: "closed", checks: { state: "unknown" } });

    fake.answer("", 1, 'no pull requests found for branch "fix/cart"');
    expect(await ask()).toMatchObject({ state: "none", message: "No pull request for fix/cart.", pr: null });

    fake.answer("", 4, "To get started with GitHub CLI, please run:  gh auth login");
    expect((await ask()).state).toBe("signed-out");

    fake.answer("", 1, "HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    expect(await ask()).toMatchObject({
      state: "error",
      message: "gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)",
    });

    // Answers are reused for a minute unless a refresh is asked for.
    fake.answer(pr({}));
    await ask();
    const before = fake.calls().length;
    expect((await t.client.git.pullRequest({ workspaceId: id })).state).toBe("found");
    expect(fake.calls()).toHaveLength(before);

    // Detached HEAD: nothing to look up, gh isn't run.
    sh(repo, "checkout", "-q", "--detach");
    await t.client.workspaces.refresh({ id });
    expect((await ask()).state).toBe("detached");
    expect(fake.calls()).toHaveLength(before);
    removeDir(ghDir);
  });

  it("says why there is none without asking gh: no remote, or not GitHub", async () => {
    const ghDir = tempDir();
    const fake = fakeGh(ghDir);
    t = await startTestServer({ gh: fake.gh });
    const { repo, id } = await workspace(t);
    expect(await t.client.git.pullRequest({ workspaceId: id })).toMatchObject({
      state: "no-remote",
      branch: "main",
      pr: null,
    });
    sh(repo, "remote", "add", "origin", "https://gitlab.com/acme/shop.git");
    const gitlab = await t.client.git.pullRequest({ workspaceId: id, refresh: true });
    expect(gitlab).toMatchObject({ state: "unsupported" });
    expect(gitlab.message).toMatch(/GitHub only for now .*gitlab\.com/);
    expect(fake.calls()).toEqual([]);
    removeDir(ghDir);
  });

  it("says when gh isn't installed", async () => {
    t = await startTestServer({ gh: "/nonexistent/bin/gh" });
    const { repo, id } = await workspace(t);
    sh(repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
    const status = await t.client.git.pullRequest({ workspaceId: id });
    expect(status.state).toBe("no-gh");
    expect(status.message).toMatch(/install it from https:\/\/cli\.github\.com/);
  });
});
