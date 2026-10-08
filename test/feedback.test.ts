import { expect, test } from "vitest";
import { codeSpan, compileFeedback, type Annotation } from "../src/shared/feedback.ts";

const onLine = (path: string): Annotation => ({
  id: "a1",
  workspaceId: "w1",
  source: { kind: "diff", path, scope: "working", side: "new", line: 3, text: "let x = 1;" },
  comment: "Use const.",
  createdAt: 0,
});

test("a path in review feedback is a code span that shows it verbatim", () => {
  expect(compileFeedback([onLine("src/a.ts")])).toBe(
    "Review feedback:\n\n1. `src/a.ts` line 3:\n   > let x = 1;\n   Use const.\n",
  );
  // A backtick in the path can't close the span early: the delimiter is one longer than its
  // longest run, padded when the path starts or ends with one.
  expect(compileFeedback([onLine("docs/`notes`.md")])).toContain("1. ``docs/`notes`.md`` line 3:");
  expect(codeSpan("src/a``b`c.ts")).toBe("```src/a``b`c.ts```");
  expect(codeSpan("`notes.md")).toBe("`` `notes.md ``");
  expect(codeSpan("notes.md`")).toBe("`` notes.md` ``");
  // Backslashes are literal inside a code span, so nothing escapes them.
  expect(codeSpan("C:\\work\\`x`.md")).toBe("``C:\\work\\`x`.md``");
  expect(codeSpan("x\\`[link](https://example.com)")).toBe("``x\\`[link](https://example.com)``");
  // A parser strips one space from each end when both are spaces: pad so they survive.
  expect(codeSpan(" spaced ")).toBe("`  spaced  `");
  expect(codeSpan("   ")).toBe("`   `");
});
