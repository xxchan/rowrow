import { expect, test } from "vitest";
import { versionNumber } from "../src/web/lib/format.ts";

test("a CLI's version number, without its name or build", () => {
  expect(versionNumber("2.1.284 (Claude Code)")).toBe("2.1.284");
  expect(versionNumber("codex-cli 0.155.1")).toBe("0.155.1");
  expect(versionNumber("grok 1.0.44 (5b807183dd79)")).toBe("1.0.44");
  expect(versionNumber("2.0.0")).toBe("2.0.0");
  expect(versionNumber("0.3.0-rc.1")).toBe("0.3.0-rc.1");
  expect(versionNumber("nightly")).toBe("nightly");
});
