// File paths the agent mentions (D-054): what looks like a path, with which line, and which
// file of the checkout it names, if any.
import { describe, expect, it } from "vitest";
import {
  checkoutFiles,
  fileTarget,
  findFileRefs,
  firstChangedLine,
  parseFileRef,
  resolvePath,
  toolFileRef,
  toolFileTarget,
} from "../src/shared/file-refs.ts";

const files = checkoutFiles("/home/me/repo", "/home/me/repo", [
  ".env",
  ".github/workflows/ci.yml",
  "README.md",
  "a.b",
  "app/(auth)/login/page.tsx",
  "notes.txt",
  "package.json",
  "packages/web/package.json",
  "packages/web/src/App.tsx",
  "packages/web/src/index.ts",
  "src/a.ts",
  "src/index.ts",
  "src/web/components/FilesTab.tsx",
]);

describe("a path in inline code", () => {
  it("reads the line in every common form", () => {
    expect(parseFileRef("src/a.ts")).toEqual({ path: "src/a.ts", line: null });
    expect(parseFileRef("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseFileRef("src/a.ts:42:7")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseFileRef("src/a.ts:42-50")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseFileRef("src/a.ts#L42")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseFileRef("src/a.ts#L42C7")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseFileRef("src/a.ts#L42-L50")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseFileRef("src/a.ts(42,7)")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseFileRef("src/a.ts:0")).toEqual({ path: "src/a.ts", line: null });
    expect(parseFileRef(" ./src/a.ts ")).toEqual({ path: "src/a.ts", line: null });
    expect(parseFileRef("/home/me/repo/src/a.ts:3")).toEqual({ path: "/home/me/repo/src/a.ts", line: 3 });
    expect(parseFileRef("file:///home/me/repo/src/a.ts")).toEqual({
      path: "/home/me/repo/src/a.ts",
      line: null,
    });
  });

  it("needs a dot or a slash, so words and commands stay plain", () => {
    expect(parseFileRef("notes.txt")).not.toBeNull();
    expect(parseFileRef(".env")).not.toBeNull();
    expect(parseFileRef("src/lib")).not.toBeNull();
    expect(parseFileRef("Makefile")).toBeNull();
    expect(parseFileRef("build")).toBeNull();
    expect(parseFileRef("print(1)")).toBeNull();
  });

  it("is not a URL, a version, a glob, a flag, a Windows path or shell", () => {
    for (const text of [
      "https://example.com/src/a.ts",
      "http://localhost:5173/a.ts",
      "//cdn.example.com/a.js",
      "mailto:me@example.com",
      "node:fs",
      "HEAD:src/a.ts",
      "1.2.3",
      "v0.3.70",
      "2.0.0-rc.1",
      "src/**/*.ts",
      "*.md",
      "src/{a,b}.ts",
      "--out=dist/a.js",
      "~/notes.txt",
      "C:\\repo\\src\\a.ts:12",
      "src\\a.ts",
      "C:/repo/a.ts",
      "$HOME/a.ts",
      "cat src/a.ts | wc",
      "src/a.ts\nsrc/b.ts",
      "src/",
      "../outside.ts",
      "src/../a.ts",
      "src//a.ts",
      "",
    ])
      expect(parseFileRef(text), text).toBeNull();
  });
});

describe("the file a path names", () => {
  it("is a listed file, from the agent's folder or the checkout's top", () => {
    expect(resolvePath("src/a.ts", files)).toBe("src/a.ts");
    expect(resolvePath("/home/me/repo/src/a.ts", files)).toBe("src/a.ts");
    expect(resolvePath("app/(auth)/login/page.tsx", files)).toBe("app/(auth)/login/page.tsx");
    expect(resolvePath("src/missing.ts", files)).toBeNull();
    expect(resolvePath("src", files)).toBeNull();
  });

  it("stays plain outside the checkout and for what files.list leaves out", () => {
    expect(resolvePath("/home/me/other/src/a.ts", files)).toBeNull();
    expect(resolvePath("/home/me/repo-old/src/a.ts", files)).toBeNull();
    expect(resolvePath("/etc/hosts", files)).toBeNull();
    // Ignored by git, so not listed.
    expect(fileTarget("node_modules/x/index.js", files)).toBeNull();
    expect(fileTarget("node_modules/x", files)).toBeNull();
  });

  it("finds a bare name or a suffix only when one file has it", () => {
    expect(resolvePath("FilesTab.tsx", files)).toBe("src/web/components/FilesTab.tsx");
    expect(resolvePath("components/FilesTab.tsx", files)).toBe("src/web/components/FilesTab.tsx");
    expect(resolvePath("App.tsx", files)).toBe("packages/web/src/App.tsx");
    // Two index.ts: neither.
    expect(resolvePath("index.ts", files)).toBeNull();
    // The one at the top wins over the deeper one.
    expect(resolvePath("package.json", files)).toBe("package.json");
    // A suffix is whole segments.
    expect(resolvePath("eb/components/FilesTab.tsx", files)).toBeNull();
  });

  it("drops a diff's a/ or b/", () => {
    expect(resolvePath("b/src/a.ts", files)).toBe("src/a.ts");
    expect(resolvePath("a/src/a.ts", files)).toBe("src/a.ts");
  });

  it("starts relative paths in the agent's folder when it's below the top", () => {
    const below = checkoutFiles("/home/me/repo/", "/home/me/repo/packages/web", [...files.paths]);
    expect(below.sub).toBe("packages/web");
    expect(resolvePath("package.json", below)).toBe("packages/web/package.json");
    expect(resolvePath("src/a.ts", below)).toBe("src/a.ts");
    expect(resolvePath("/home/me/repo/packages/web/src/App.tsx", below)).toBe("packages/web/src/App.tsx");
    // The same folder through a symlink (git reports the real path): from the top.
    const linked = checkoutFiles("/private/var/repo", "/var/repo", [...files.paths]);
    expect(linked.sub).toBe("");
    expect(resolvePath("/var/repo/src/a.ts", linked)).toBe("src/a.ts");
    expect(resolvePath("/private/var/repo/src/a.ts", linked)).toBe("src/a.ts");
  });

  it("links inline code with its line, and lookalikes not at all", () => {
    expect(fileTarget("notes.txt:2", files)).toEqual({ path: "notes.txt", line: 2 });
    expect(fileTarget("`src/a.ts`".slice(1, -1), files)).toEqual({ path: "src/a.ts", line: null });
    expect(fileTarget("a.b", files)).toEqual({ path: "a.b", line: null });
    expect(fileTarget("c.d", files)).toBeNull();
    expect(fileTarget("console.log", files)).toBeNull();
    expect(fileTarget("example.com", files)).toBeNull();
    expect(fileTarget("1.2.3", files)).toBeNull();
    expect(fileTarget(".github/workflows/ci.yml#L3", files)).toEqual({
      path: ".github/workflows/ci.yml",
      line: 3,
    });
  });
});

describe("the file a tool call names", () => {
  it("is a file tool's path, as its row shows it, with a read's offset as the line", () => {
    expect(toolFileRef("claude", "Read", JSON.stringify({ file_path: "/r/src/a.ts", offset: 120 }))).toEqual({
      path: "/r/src/a.ts",
      line: 120,
    });
    expect(toolFileRef("claude", "Edit", JSON.stringify({ file_path: "/r/a.ts", old_string: "x" }))).toEqual({
      path: "/r/a.ts",
      line: null,
    });
    expect(toolFileRef("pi", "read", JSON.stringify({ path: "src/a.ts", offset: 3 }))).toEqual({
      path: "src/a.ts",
      line: 3,
    });
    // A MultiEdit, or a runtime oar doesn't classify (the scripted one's Write).
    expect(toolFileRef("claude", "MultiEdit", JSON.stringify({ file_path: "src/a.ts", edits: [] }))).toEqual({
      path: "src/a.ts",
      line: null,
    });
    expect(
      toolFileRef("scripted", "Write", JSON.stringify({ file_path: "notes.txt", content: "x" })),
    ).toEqual({
      path: "notes.txt",
      line: null,
    });
  });

  it("opens when the checkout lists it", () => {
    const read = JSON.stringify({ file_path: "/home/me/repo/src/a.ts", offset: 7 });
    expect(toolFileTarget("claude", "Read", read, files)).toEqual({ path: "src/a.ts", line: 7 });
    const elsewhere = JSON.stringify({ file_path: "/etc/hosts" });
    expect(toolFileTarget("claude", "Read", elsewhere, files)).toBeNull();
    const folder = JSON.stringify({ pattern: "x", path: "src" });
    expect(toolFileTarget("claude", "Grep", folder, files)).toBeNull();
  });

  it("is a Codex file change's first file, at its first changed line", () => {
    const input = JSON.stringify([
      {
        path: "/r/src/a.ts",
        kind: { type: "update", move_path: null },
        diff: "@@ -10,7 +12,8 @@\n context\n context\n-old\n+new\n context",
      },
      { path: "/r/src/b.ts", kind: { type: "add" }, diff: "whole file" },
    ]);
    expect(toolFileRef("codex", "fileChange", input)).toEqual({ path: "/r/src/a.ts", line: 14 });
  });

  it("is nothing for a command, a search pattern or a web fetch", () => {
    expect(toolFileRef("claude", "Bash", JSON.stringify({ command: "cat src/a.ts" }))).toBeNull();
    expect(toolFileRef("claude", "Grep", JSON.stringify({ pattern: "TODO" }))).toBeNull();
    expect(toolFileRef("claude", "WebFetch", JSON.stringify({ url: "https://x.dev/a.ts" }))).toBeNull();
    expect(toolFileRef("claude", "Read", undefined)).toBeNull();
    expect(toolFileRef("claude", "Read", "not json")).toBeNull();
    // A Grep in a folder shows the folder, which is no file (resolvePath says so).
    expect(toolFileRef("claude", "Grep", JSON.stringify({ pattern: "x", path: "src" }))).toEqual({
      path: "src",
      line: null,
    });
  });

  it("reads where a diff's first change is", () => {
    expect(firstChangedLine("@@ -1,3 +1,4 @@\n a\n+b\n c")).toBe(2);
    expect(firstChangedLine("@@ -5 +5 @@\n-x\n+y")).toBe(5);
    expect(firstChangedLine("no hunk")).toBeNull();
  });
});

describe("paths in a tool's output", () => {
  const at = (text: string) =>
    findFileRefs(text, files).map(({ start, end, target }) => ({ text: text.slice(start, end), ...target }));

  it("finds a search's hits and a test's failures, with their lines", () => {
    expect(at("Found 2 files\n/home/me/repo/src/a.ts\n/home/me/repo/notes.txt")).toEqual([
      { text: "/home/me/repo/src/a.ts", path: "src/a.ts", line: null },
      { text: "/home/me/repo/notes.txt", path: "notes.txt", line: null },
    ]);
    expect(at("src/a.ts:12:  const x = 1;")).toEqual([{ text: "src/a.ts:12", path: "src/a.ts", line: 12 }]);
    expect(at("FAIL ./src/a.ts:3:9, then (src/index.ts).")).toEqual([
      { text: "./src/a.ts:3:9", path: "src/a.ts", line: 3 },
      { text: "src/index.ts", path: "src/index.ts", line: null },
    ]);
  });

  it("leaves URLs, bare names, other folders and missing files alone", () => {
    expect(at("see https://example.com/src/a.ts and notes.txt")).toEqual([]);
    expect(at("x=src/a.ts /home/me/other/src/a.ts src/gone.ts")).toEqual([]);
    expect(at("v1.2.3 node_modules/x/index.js C:\\repo\\src\\a.ts")).toEqual([]);
  });
});
