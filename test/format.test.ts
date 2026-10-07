import { expect, test } from "vitest";
import { cacheWords, expiryNote, versionNumber } from "../src/web/lib/format.ts";

test("a CLI's version number, without its name or build", () => {
  expect(versionNumber("2.1.284 (Claude Code)")).toBe("2.1.284");
  expect(versionNumber("codex-cli 0.155.1")).toBe("0.155.1");
  expect(versionNumber("grok 1.0.44 (5b807183dd79)")).toBe("1.0.44");
  expect(versionNumber("2.0.0")).toBe("2.0.0");
  expect(versionNumber("0.3.0-rc.1")).toBe("0.3.0-rc.1");
  expect(versionNumber("nightly")).toBe("nightly");
});

test("when a login that runs out does, and a warning in its last two weeks", () => {
  const now = Date.parse("2026-10-07T00:00:00Z");
  const signedIn = (expiresAt?: string) => ({
    kind: "logged_in" as const,
    account: expiresAt === undefined ? {} : { expiresAt },
  });
  expect(expiryNote(signedIn(), now)).toBeNull();
  expect(expiryNote({ kind: "logged_out" }, now)).toBeNull();
  expect(expiryNote(signedIn("2027-01-05T00:00:00Z"), now)).toMatchObject({ soon: false });
  expect(expiryNote(signedIn("2026-10-12T12:00:00Z"), now)).toEqual({
    text: "Its key expires in 6 days: sign in again.",
    soon: true,
  });
  expect(expiryNote(signedIn("2026-10-07T20:00:00Z"), now)?.text).toBe(
    "Its key expires in 1 day: sign in again.",
  );
  expect(expiryNote(signedIn("2026-10-01T00:00:00Z"), now)).toEqual({
    text: "Its key has expired: sign in again.",
    soon: true,
  });
});

test("how much of a session's input the prompt cache served, when the runtime says", () => {
  expect(cacheWords({})).toBeNull();
  expect(cacheWords({ cacheRead: 1_200_000, cacheWrite: 40_000 })).toBe(
    "1.2M read · 40k written (part of what's in)",
  );
  expect(cacheWords({ cacheRead: 0 })).toBe("0 read (part of what's in)");
});
