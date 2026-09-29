// The npm package's lib/ (scripts/build-node.ts, D-018): Node strips the types, and relative
// `.ts` specifiers become `.js`, with every line and column where it was in the source.
import { expect, test } from "vitest";
import { toJavaScript } from "../scripts/build-node.ts";

test("types become spaces and relative .ts imports become .js, so every position stays put", () => {
  const source = [
    "#!/usr/bin/env node",
    'import type { Entry } from "../shared/entries.ts";',
    'import { contract, type Contract } from "../shared/contract.ts";',
    'import "./side-effect.ts";',
    'export * from "./re-export.ts";',
    "export {",
    "  a,",
    '} from "./multi-line.ts";',
    'import { z } from "zod";',
    "const port: number = 7373;",
    'const lazy = await import("./lazy.ts");',
    "// a comment about main.ts stays as it is",
    'const file = "main.ts";',
    "",
  ].join("\n");
  const output = toJavaScript(source);
  expect(output.split("\n").map((line) => line.length)).toEqual(
    source.split("\n").map((line) => line.length),
  );
  expect(output.split("\n").map((line) => line.trimEnd())).toEqual([
    "#!/usr/bin/env node",
    "",
    'import { contract,               } from "../shared/contract.js";',
    'import "./side-effect.js";',
    'export * from "./re-export.js";',
    "export {",
    "  a,",
    '} from "./multi-line.js";',
    'import { z } from "zod";',
    "const port         = 7373;",
    'const lazy = await import("./lazy.js");',
    "// a comment about main.ts stays as it is",
    'const file = "main.ts";',
    "",
  ]);
});
