import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILES, MAX_PATCH_BYTES, fileDiff, listChanges, parseDiff, parseGenerated } from "./changes.ts";
import { SnapshotStore } from "./snapshots.ts";
import { createWorktree } from "./worktrees.ts";
import { commitAll, initRepo, isolateGit, removeDir, sh, tempDir, write } from "./testing.ts";

beforeAll(isolateGit);

let tmp: string;
let repo: string;
let store: SnapshotStore;

const lines = (...items: string[]): string => items.map((item) => `${item}\n`).join("");

beforeEach(() => {
  tmp = tempDir();
  repo = initRepo(tmp, "repo", {
    "a.txt": lines("one", "two", "three"),
    "b.txt": lines("bee"),
    "old.txt": lines("a", "b", "c", "d", "e", "f", "g", "h"),
    "del.txt": lines("x", "y"),
    "touched.txt": lines("same"),
  });
  store = new SnapshotStore(path.join(tmp, "snapshots"));
});

afterEach(() => removeDir(tmp));

function indexState(dir: string): { bytes: string; mtime: number } {
  const index = path.join(dir, ".git", "index");
  return { bytes: fs.readFileSync(index).toString("base64"), mtime: fs.statSync(index).mtimeMs };
}

async function baseline(dir = repo): Promise<string> {
  const result = await store.capture(dir);
  if (result.kind !== "ok") throw new Error(result.reason);
  return result.tree;
}

describe("listChanges: working", () => {
  it("lists modified, added, deleted, renamed and untracked files with line counts", async () => {
    const head = sh(repo, "rev-parse", "HEAD").trim();
    write(repo, "a.txt", lines("one", "2", "three", "four"));
    write(repo, "added.txt", lines("new"));
    sh(repo, "add", "added.txt");
    fs.rmSync(path.join(repo, "del.txt"));
    sh(repo, "mv", "old.txt", "new.txt");
    write(repo, "untracked.txt", lines("u1", "u2", "u3"));
    write(repo, "dir/nested.txt", "no newline at end");
    write(repo, "bin.dat", Buffer.from([1, 0, 2, 3]));
    // Stat-dirty but unchanged: `git diff` would refresh (write) the index for this one.
    const future = Date.now() / 1000 + 60;
    fs.utimesSync(path.join(repo, "touched.txt"), future, future);
    const before = indexState(repo);

    const changes = await listChanges({ dir: repo, scope: "working", store });

    const staged = { staged: true, unstaged: false, stamp: expect.any(String) };
    const unstaged = { staged: false, unstaged: true, stamp: expect.any(String) };
    expect(changes).toEqual({
      scope: "working",
      base: head,
      baseLabel: `main @ ${head.slice(0, 7)}`,
      truncated: false,
      note: null,
      files: [
        { path: "a.txt", oldPath: null, status: "modified", additions: 2, deletions: 1, ...unstaged },
        { path: "added.txt", oldPath: null, status: "added", additions: 1, deletions: 0, ...staged },
        {
          path: "bin.dat",
          oldPath: null,
          status: "untracked",
          additions: null,
          deletions: null,
          ...unstaged,
        },
        { path: "del.txt", oldPath: null, status: "deleted", additions: 0, deletions: 2, ...unstaged },
        {
          path: "dir/nested.txt",
          oldPath: null,
          status: "untracked",
          additions: 1,
          deletions: 0,
          ...unstaged,
        },
        { path: "new.txt", oldPath: "old.txt", status: "renamed", additions: 0, deletions: 0, ...staged },
        {
          path: "untracked.txt",
          oldPath: null,
          status: "untracked",
          additions: 3,
          deletions: 0,
          ...unstaged,
        },
      ],
    });
    expect(indexState(repo)).toEqual(before);
  });

  it("says which files are staged, unstaged or both, with a stamp that follows their content", async () => {
    write(repo, "a.txt", lines("staged"));
    sh(repo, "add", "a.txt");
    write(repo, "a.txt", lines("staged", "then more"));
    const first = await listChanges({ dir: repo, scope: "working", store });
    expect(first.files.map((f) => [f.path, f.staged, f.unstaged])).toEqual([["a.txt", true, true]]);
    const again = await listChanges({ dir: repo, scope: "working", store });
    expect(again.files[0]?.stamp).toBe(first.files[0]?.stamp);
    write(repo, "a.txt", lines("staged", "then more!"));
    const edited = await listChanges({ dir: repo, scope: "working", store });
    expect(edited.files[0]?.stamp).not.toBe(first.files[0]?.stamp);
    // Branch and turn scopes have no staging area to speak of.
    const branch = await listChanges({ dir: repo, scope: "branch", store });
    expect(branch.files[0]).not.toHaveProperty("stamp");
  });

  it("marks conflicts", async () => {
    sh(repo, "checkout", "-q", "-b", "other");
    write(repo, "a.txt", lines("theirs"));
    commitAll(repo, "theirs");
    sh(repo, "checkout", "-q", "main");
    write(repo, "a.txt", lines("ours"));
    commitAll(repo, "ours");
    expect(() => sh(repo, "merge", "-q", "other")).toThrow();
    const changes = await listChanges({ dir: repo, scope: "working", store });
    expect(changes.files.map((f) => [f.path, f.status])).toEqual([["a.txt", "conflicted"]]);
  });

  it("compares with the empty tree before the first commit", async () => {
    const fresh = path.join(tmp, "fresh");
    fs.mkdirSync(fresh);
    sh(fresh, "init", "-q");
    write(fresh, "staged.txt", lines("s"));
    sh(fresh, "add", "staged.txt");
    write(fresh, "loose.txt", lines("l"));
    const changes = await listChanges({ dir: fresh, scope: "working", store });
    expect(changes).toMatchObject({ base: null, baseLabel: "no commits yet", note: null });
    expect(changes.files.map((f) => [f.path, f.status, f.additions])).toEqual([
      ["loose.txt", "untracked", 1],
      ["staged.txt", "added", 1],
    ]);
  });

  it("flags generated files: marked in .gitattributes, or lockfiles nothing unmarks", async () => {
    write(
      repo,
      ".gitattributes",
      lines("gen/** linguist-generated", "*.pb.go gitlab-generated=true", "yarn.lock -linguist-generated"),
    );
    write(repo, "sub/.gitattributes", lines("Cargo.lock linguist-generated=false"));
    commitAll(repo, "attributes");
    for (const file of [
      "gen/app.js",
      "api.pb.go",
      "pnpm-lock.yaml",
      "web/package-lock.json",
      "sub/Cargo.lock",
      "yarn.lock",
      "src/app.ts",
    ])
      write(repo, file, lines("x"));
    const generated = async (scope: "working" | "turn", turnBaseline?: string) =>
      (
        await listChanges({
          dir: repo,
          scope,
          store,
          ...(turnBaseline === undefined ? {} : { turnBaseline }),
        })
      ).files
        .filter((f) => f.generated === true)
        .map((f) => f.path);
    const expected = ["api.pb.go", "gen/app.js", "pnpm-lock.yaml", "web/package-lock.json"];
    expect(await generated("working")).toEqual(expected);
    // Absent, not false, on the others.
    const changes = await listChanges({ dir: repo, scope: "working", store });
    expect(changes.files.find((f) => f.path === "src/app.ts")).not.toHaveProperty("generated");

    // Between snapshots too.
    const start = await baseline();
    for (const file of expected) write(repo, file, lines("x", "y"));
    expect(await generated("turn", start)).toEqual(expected);
  });

  it(`caps the list at ${MAX_FILES} files`, async () => {
    for (let i = 0; i <= MAX_FILES; i++) write(repo, `many/${String(i).padStart(4, "0")}.txt`, "x\n");
    const changes = await listChanges({ dir: repo, scope: "working", store });
    expect(changes.truncated).toBe(true);
    expect(changes.files).toHaveLength(MAX_FILES);
    expect(changes.files.at(-1)?.path).toBe("many/1999.txt");
  });
});

describe("listChanges: branch", () => {
  it("lists everything since the merge base with the local default branch, uncommitted included", async () => {
    const fork = sh(repo, "rev-parse", "HEAD").trim();
    sh(repo, "checkout", "-q", "-b", "feature");
    write(repo, "a.txt", lines("one", "two", "three", "committed"));
    write(repo, "feature.txt", lines("f"));
    commitAll(repo, "feature work");
    // The default branch moves on after the fork; its changes aren't the branch's.
    sh(repo, "checkout", "-q", "main");
    write(repo, "main-only.txt", lines("m"));
    commitAll(repo, "main moves on");
    sh(repo, "checkout", "-q", "feature");
    write(repo, "b.txt", lines("bee", "uncommitted"));
    write(repo, "loose.txt", lines("l"));
    const before = indexState(repo);

    const changes = await listChanges({ dir: repo, scope: "branch", store });

    expect(changes).toMatchObject({
      scope: "branch",
      base: fork,
      baseLabel: `main @ ${fork.slice(0, 7)} (merge base)`,
      note: null,
    });
    expect(changes.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 1, 0],
      ["b.txt", "modified", 1, 0],
      ["feature.txt", "added", 1, 0],
      ["loose.txt", "untracked", 1, 0],
    ]);
    expect(indexState(repo)).toEqual(before);
  });

  it("prefers origin's copy of the default branch named by origin/HEAD", async () => {
    const origin = path.join(tmp, "origin.git");
    sh(tmp, "init", "-q", "--bare", "-b", "trunk", origin);
    const seed = initRepo(tmp, "seed", { "s.txt": "s\n" }, "trunk");
    sh(seed, "push", "-q", origin, "trunk");
    sh(tmp, "clone", "-q", origin, "clone");
    const clone = path.join(tmp, "clone");
    const fork = sh(clone, "rev-parse", "HEAD").trim();
    sh(clone, "checkout", "-q", "-b", "work");
    write(clone, "w.txt", "w\n");
    commitAll(clone, "work");
    const changes = await listChanges({ dir: clone, scope: "branch", store });
    expect(changes.baseLabel).toBe(`origin/trunk @ ${fork.slice(0, 7)} (merge base)`);
    expect(changes.files.map((f) => f.path)).toEqual(["w.txt"]);
  });

  it("uses the worktree's base when origin's default branch moved on without the local ref", async () => {
    const origin = path.join(tmp, "origin.git");
    sh(tmp, "init", "-q", "--bare", "-b", "trunk", origin);
    const seed = initRepo(tmp, "seed", { "s.txt": "s\n" }, "trunk");
    sh(seed, "push", "-q", origin, "trunk");
    sh(tmp, "clone", "-q", origin, "clone");
    const clone = path.join(tmp, "clone");
    const stale = sh(clone, "rev-parse", "HEAD").trim();
    write(seed, "upstream.txt", "upstream\n");
    commitAll(seed, "upstream moves on");
    sh(seed, "push", "-q", origin, "trunk");
    // Fetches origin's new commit by id: the clone's origin/trunk stays where it was.
    const created = await createWorktree({ repoDir: clone, root: path.join(tmp, "worktrees") });
    write(created.path, "agent.txt", "agent\n");

    const refOnly = await listChanges({ dir: created.path, scope: "branch", store });
    expect(refOnly.base).toBe(stale);
    expect(refOnly.files.map((f) => f.path)).toEqual(["agent.txt", "upstream.txt"]);

    const hinted = await listChanges({
      dir: created.path,
      scope: "branch",
      store,
      defaultBase: created.base,
    });
    expect(hinted).toMatchObject({
      base: created.base,
      baseLabel: `origin/trunk @ ${created.base.slice(0, 7)} (merge base)`,
    });
    expect(hinted.files.map((f) => f.path)).toEqual(["agent.txt"]);

    // Once the ref catches up, an older hint doesn't pull the base back.
    sh(clone, "fetch", "-q", "origin");
    const older = await listChanges({ dir: created.path, scope: "branch", store, defaultBase: stale });
    expect(older.base).toBe(created.base);

    // A hint the repository doesn't have is ignored; one that isn't a commit id is a caller bug.
    const missing = await listChanges({
      dir: created.path,
      scope: "branch",
      store,
      defaultBase: "f".repeat(40),
    });
    expect(missing.base).toBe(created.base);
    await expect(
      listChanges({ dir: created.path, scope: "branch", store, defaultBase: "HEAD~1" }),
    ).rejects.toThrow(/not a commit id/);
  });

  it("explains when there is no default branch", async () => {
    const lonely = initRepo(tmp, "lonely", { "x.txt": "x\n" }, "dev");
    expect(await listChanges({ dir: lonely, scope: "branch", store })).toEqual({
      scope: "branch",
      base: null,
      baseLabel: null,
      files: [],
      truncated: false,
      note: expect.stringMatching(/^No default branch to compare with/),
    });
  });
});

describe("listChanges: turn", () => {
  it("lists exactly what changed since the snapshot, through commits and branch switches", async () => {
    write(repo, "b.txt", lines("bee", "before the turn")); // uncommitted before the turn: not the turn's
    const start = await baseline();
    write(repo, "a.txt", lines("one", "two", "three", "turn"));
    write(repo, "n.txt", lines("n1", "n2"));
    fs.rmSync(path.join(repo, "del.txt"));
    fs.renameSync(path.join(repo, "old.txt"), path.join(repo, "moved.txt"));
    commitAll(repo, "agent commits");
    sh(repo, "checkout", "-q", "-b", "agent-branch");
    const before = indexState(repo);

    const changes = await listChanges({ dir: repo, scope: "turn", store, turnBaseline: start });

    expect(changes).toMatchObject({ scope: "turn", base: start, note: null, truncated: false });
    expect(changes.baseLabel).toBe(`start of the turn (snapshot ${start.slice(0, 7)})`);
    expect(changes.files).toEqual([
      { path: "a.txt", oldPath: null, status: "modified", additions: 1, deletions: 0 },
      { path: "del.txt", oldPath: null, status: "deleted", additions: 0, deletions: 2 },
      { path: "moved.txt", oldPath: "old.txt", status: "renamed", additions: 0, deletions: 0 },
      { path: "n.txt", oldPath: null, status: "added", additions: 2, deletions: 0 },
    ]);
    expect(indexState(repo)).toEqual(before);
  });

  it("explains a missing baseline, a refused capture and a pruned snapshot", async () => {
    expect(await listChanges({ dir: repo, scope: "turn", store, turnBaseline: null })).toMatchObject({
      files: [],
      note: expect.stringMatching(/^No snapshot yet: /),
    });
    // Not a clean worktree: that tree would already be in the repository, beyond pruning.
    write(repo, "pre.txt", lines("pre"));
    const start = await baseline();
    write(repo, "huge.bin", Buffer.alloc(9 * 1024 * 1024));
    expect(await listChanges({ dir: repo, scope: "turn", store, turnBaseline: start })).toMatchObject({
      base: start,
      files: [],
      note: expect.stringMatching(/^Can't snapshot the worktree to compare: huge\.bin is 9\.0 MiB/),
    });
    fs.rmSync(path.join(repo, "huge.bin"));
    write(repo, "a.txt", "changed\n");
    await store.prune(-1);
    expect(await listChanges({ dir: repo, scope: "turn", store, turnBaseline: start })).toMatchObject({
      files: [],
      note: "The snapshot from the start of the turn is no longer stored.",
    });
  });
});

describe("fileDiff", () => {
  it("diffs a modified file, an untracked file and a rename in the working scope", async () => {
    write(repo, "a.txt", lines("one", "2", "three"));
    write(repo, "fresh.txt", lines("hello"));
    sh(repo, "mv", "old.txt", "new.txt");
    write(repo, "new.txt", lines("a", "b", "c", "d", "e", "f", "g", "h", "i"));
    const before = indexState(repo);

    const modified = await fileDiff({ dir: repo, scope: "working", store, path: "a.txt" });
    expect(modified.truncated).toBe(false);
    expect(modified.patch).toContain("diff --git a/a.txt b/a.txt\n");
    expect(modified.patch).toContain("-two\n+2\n");

    const untracked = await fileDiff({ dir: repo, scope: "working", store, path: "fresh.txt" });
    expect(untracked.patch).toContain("new file mode 100644\n");
    expect(untracked.patch).toContain("+++ b/fresh.txt\n@@ -0,0 +1 @@\n+hello\n");

    const renamed = await fileDiff({ dir: repo, scope: "working", store, path: "new.txt" });
    expect(renamed.patch).toContain("rename from old.txt\nrename to new.txt\n");
    expect(renamed.patch).toContain("+i\n");

    expect(indexState(repo)).toEqual(before);
  });

  it("diffs in the branch and turn scopes", async () => {
    sh(repo, "checkout", "-q", "-b", "feature");
    write(repo, "b.txt", lines("bee", "committed"));
    commitAll(repo, "feature");
    const branch = await fileDiff({ dir: repo, scope: "branch", store, path: "b.txt" });
    expect(branch.patch).toContain(" bee\n+committed\n");

    const start = await baseline();
    write(repo, "b.txt", lines("bee", "committed", "in the turn"));
    const turn = await fileDiff({ dir: repo, scope: "turn", store, path: "b.txt", turnBaseline: start });
    expect(turn.patch).toContain(" committed\n+in the turn\n");
    expect(turn.patch).not.toContain("+committed");
    await expect(
      fileDiff({ dir: repo, scope: "turn", store, path: "b.txt", turnBaseline: null }),
    ).rejects.toThrow(/No snapshot yet/);
  });

  it("cuts long patches at a line boundary", async () => {
    write(repo, "a.txt", lines(...Array.from({ length: 40_000 }, (_, i) => `line ${i} ${"x".repeat(10)}`)));
    const result = await fileDiff({ dir: repo, scope: "working", store, path: "a.txt" });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(MAX_PATCH_BYTES);
    expect(result.patch.endsWith("\n")).toBe(true);
  });

  it("rejects paths that could leave the worktree", async () => {
    for (const bad of ["../outside.txt", "/etc/passwd", "a/../../x", "", "sub/../a.txt"]) {
      await expect(fileDiff({ dir: repo, scope: "working", store, path: bad })).rejects.toThrow(
        /invalid path/,
      );
    }
  });

  it("treats pathspec magic in a file name literally", async () => {
    write(repo, "*.txt", lines("star"));
    commitAll(repo, "star");
    write(repo, "*.txt", lines("star", "more"));
    write(repo, "a.txt", lines("changed too"));
    const result = await fileDiff({ dir: repo, scope: "working", store, path: "*.txt" });
    expect(result.patch).toContain("+more\n");
    expect(result.patch).not.toContain("a.txt");
  });
});

describe("parseDiff", () => {
  it("joins raw records with numstat counts, renames included", () => {
    const out = [
      ":100644 100644 aaa bbb M",
      "a b.txt",
      ":100644 100644 aaa bbb R090",
      "old.txt",
      "new.txt",
      ":100644 000000 aaa 000 D",
      "gone.bin",
      "3\t1\ta b.txt",
      "0\t2\t",
      "old.txt",
      "new.txt",
      "-\t-\tgone.bin",
      "",
    ].join("\0");
    expect(parseDiff(out)).toEqual([
      { path: "a b.txt", oldPath: null, status: "modified", additions: 3, deletions: 1 },
      { path: "new.txt", oldPath: "old.txt", status: "renamed", additions: 0, deletions: 2 },
      { path: "gone.bin", oldPath: null, status: "deleted", additions: null, deletions: null },
    ]);
  });
});

describe("parseGenerated", () => {
  it("reads set and true as generated, and lets unset or false win", () => {
    const out = [
      ["a.js", "linguist-generated", "set"],
      ["b.js", "gitlab-generated", "true"],
      ["c.lock", "linguist-generated", "unset"],
      ["d.js", "linguist-generated", "true"],
      ["d.js", "gitlab-generated", "false"],
      ["e.js", "linguist-generated", "unspecified"],
    ]
      .flat()
      .map((field) => `${field}\0`)
      .join("");
    expect([...parseGenerated(out)]).toEqual([
      ["a.js", true],
      ["b.js", true],
      ["c.lock", false],
      ["d.js", false],
    ]);
  });
});
