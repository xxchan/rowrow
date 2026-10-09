// Scrollbars wear the theme through ::-webkit-scrollbar (src/web/index.css). Chromium, and so the
// Mac app, ignores those rules on any element where `scrollbar-width` or `scrollbar-color` is
// set and draws its own gray scrollbar there instead. Those two may only hide a scrollbar or sit
// in a Firefox-only block, in our styles and in the shadow-DOM styles of the libraries we load.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const FIREFOX_ONLY =
  /@supports\s*(not\s+selector\(\s*::-webkit-scrollbar\s*\)|\(\s*\(\s*-moz-appearance:\s*none\s*\)\s*\))/;

/** The preludes of the blocks around `at`, innermost first (`@supports …`, a selector…). */
function enclosing(text: string, at: number): string[] {
  const preludes: string[] = [];
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{" && depth > 0) depth--;
    else if (text[i] === "{") {
      const start = Math.max(
        text.lastIndexOf(";", i - 1),
        text.lastIndexOf("}", i - 1),
        text.lastIndexOf("{", i - 1),
      );
      preludes.push(text.slice(start + 1, i).trim());
    }
  }
  return preludes;
}

/** Each `scrollbar-width`/`scrollbar-color` in `text` that would turn Chromium's scrollbar gray. */
function grayScrollbars(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/scrollbar-(width|color)\s*:\s*([^;}\]"'`\\]+)/g)) {
    if (match[1] === "width" && match[2]?.trim() === "none") continue;
    if (enclosing(text, match.index).some((prelude) => FIREFOX_ONLY.test(prelude))) continue;
    found.push(match[0].trim());
  }
  return found;
}

function files(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(css|tsx?)$/.test(file))
    .map((file) => path.join(dir, file));
}

test("only hiding or Firefox's fallback sets scrollbar-width or scrollbar-color", () => {
  const sources = [
    ...files(path.join(root, "src/web")),
    // Their shadow roots don't see index.css: they style their own scrollbars.
    path.join(root, "node_modules/@pierre/diffs/dist/style.js"),
    path.join(root, "node_modules/@pierre/trees/dist/style.js"),
  ];
  const gray = sources.flatMap((file) =>
    grayScrollbars(fs.readFileSync(file, "utf8")).map((what) => `${path.relative(root, file)}: ${what}`),
  );
  expect(gray).toEqual([]);
});

test("the guard tells a gray scrollbar from a hidden or Firefox-only one", () => {
  expect(grayScrollbars(`<div className="overflow-x-auto [scrollbar-width:thin]" />`)).toEqual([
    "scrollbar-width:thin",
  ]);
  expect(grayScrollbars(".list { scrollbar-color: var(--scrollbar) transparent; }")).toHaveLength(1);
  expect(grayScrollbars(`<div className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden" />`)).toEqual(
    [],
  );
  expect(
    grayScrollbars(
      "@supports not selector(::-webkit-scrollbar) { * { scrollbar-width: thin; scrollbar-color: red transparent; } }",
    ),
  ).toEqual([]);
  expect(
    grayScrollbars(
      "@supports ((-moz-appearance: none)) { [data-code] { scrollbar-color: red transparent; } }",
    ),
  ).toEqual([]);
});
