import { expect, test } from "vitest";
import { emptyDiagram, fitScale, inertCss, mermaidSource, mixHex } from "../src/web/lib/diagram.ts";

test("a .mmd file's diagram, unwrapped from a fence and a byte-order mark", () => {
  expect(mermaidSource("\uFEFFflowchart LR\n  A --> B\n")).toBe("flowchart LR\n  A --> B");
  expect(mermaidSource("```mermaid\nflowchart LR\n  A --> B\n```\n")).toBe("flowchart LR\n  A --> B");
  expect(mermaidSource("~~~~Mermaid\nsequenceDiagram\n  A->>B: hi\n~~~~")).toBe(
    "sequenceDiagram\n  A->>B: hi",
  );
  // A fence that doesn't wrap the whole file is the diagram's own text.
  expect(mermaidSource("flowchart LR\n  A[```] --> B")).toBe("flowchart LR\n  A[```] --> B");
});

test("a diagram with only front matter, directives and comments is empty", () => {
  expect(emptyDiagram("")).toBe(true);
  expect(emptyDiagram("  \n")).toBe(true);
  expect(emptyDiagram("---\ntitle: Plan\n---\n%%{init: {}}%%\n%% just a note\n")).toBe(true);
  expect(emptyDiagram("```mermaid\n```")).toBe(true);
  expect(emptyDiagram("%% steps\nflowchart LR\n  A --> B")).toBe(false);
});

test("Fit never enlarges, fits the width inline, and the whole picture otherwise", () => {
  const tall = { width: 800, height: 1600 };
  // Inline: fit the width (less 32 px of padding); the viewport grows to the height.
  expect(fitScale(tall, { width: 432, height: 0 }, true)).toBe(0.5);
  expect(fitScale(tall, { width: 2000, height: 0 }, true)).toBe(1);
  // A file preview or fullscreen: the whole picture.
  expect(fitScale(tall, { width: 1000, height: 832 }, false)).toBe(0.5);
  expect(fitScale({ width: 0, height: 0 }, { width: 500, height: 500 }, false)).toBe(1);
});

test("a diagram's CSS can't load anything", () => {
  // References to the SVG's own definitions stay.
  expect(inertCss("marker-end: url(#arrow); fill: url( '#grad' )")).toBe(
    "marker-end: url(#arrow); fill: url( '#grad' )",
  );
  expect(inertCss("fill: url(https://example.com/x.png)")).toBe("fill: blocked(https://example.com/x.png)");
  expect(inertCss('@import "https://example.com/x.css"; .a{}')).toBe(
    '@blocked "https://example.com/x.css"; .a{}',
  );
  expect(inertCss('background: image-set("x.png" 1x)')).toBe('background: blocked("x.png" 1x)');
  expect(inertCss('background: -webkit-image-set("x.png" 1x)')).toBe('background: blocked("x.png" 1x)');
  // Escapes can't spell url( around the check.
  expect(inertCss("fill: u\\72l(https://example.com/x)")).toBe("fill: u72l(https://example.com/x)");
  expect(inertCss("fill: \\75rl(https://example.com/x)")).toBe("fill: 75rl(https://example.com/x)");
  expect(inertCss("fill: URL(//example.com/x)")).toBe("fill: blocked(//example.com/x)");
});

test("theme colors mix as hex, and anything else passes through", () => {
  expect(mixHex("#ffffff", "#000000", 0.5)).toBe("#808080");
  expect(mixHex("#3867d6", "#ffffff", 0)).toBe("#ffffff");
  // As a built stylesheet writes white.
  expect(mixHex("#3867d6", "#fff", 0.6)).toBe("#88a4e6");
  expect(mixHex("oklch(0.5 0.1 200)", "#123456", 0.5)).toBe("#123456");
});
