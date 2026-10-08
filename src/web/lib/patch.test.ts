import { expect, it } from "vitest";
import { parsePatch } from "./patch.ts";

it("reads lines that start with --- or +++ inside a hunk as removed and added, not as headers", () => {
  const patch = [
    "diff --git a/notes.md b/notes.md",
    "index 1111111..2222222 100644",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,3 +1,3 @@",
    " keep",
    "---x",
    "+++y",
    " end",
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "",
  ].join("\n");
  expect(parsePatch(patch).map((line) => [line.kind, line.text, line.oldNo, line.newNo])).toEqual([
    ["hunk", "@@ -1,3 +1,3 @@", null, null],
    ["context", "keep", 1, 1],
    ["del", "--x", 2, null],
    ["add", "++y", null, 2],
    ["context", "end", 3, 3],
    ["meta", "new file mode 100644", null, null],
    ["hunk", "@@ -0,0 +1 @@", null, null],
    ["add", "hello", null, 1],
  ]);
});
