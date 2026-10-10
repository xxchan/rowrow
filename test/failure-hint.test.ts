// What a failed turn says to do next, by oar's failure class (failureAdvice).
import type { FailedTurn, FailureClass } from "@botiverse/oar";
import { expect, it } from "vitest";
import { droppedWords, failureHint } from "../src/shared/describe.ts";

const failed = (failure: FailureClass, more: object = {}) =>
  ({ kind: "failed", failure, reason: "it failed", ...more }) as FailedTurn;

it("says what a failed turn needs: a step from you, a wait, or just sending again", () => {
  expect(failureHint(failed("billing"))).toMatch(/billing/);
  expect(failureHint(failed("model_unavailable"))).toMatch(/pick another/);
  expect(failureHint(failed("input_too_large"))).toMatch(/shorter/);
  expect(failureHint(failed("quota"))).toMatch(/Subscription usage/);
  for (const failure of ["rate_limited", "overloaded", "provider", "runtime_exited"] as const) {
    expect(failureHint(failed(failure))).toMatch(/send it again in a moment/);
  }
  // Sign-in has its own steps; for the rest, sending it again won't help and there's no step to name.
  for (const failure of ["auth", "invalid_request", "unknown"] as const)
    expect(failureHint(failed(failure))).toBeNull();
});

it("sends you to sign in only when the login is missing, not when the provider rejected the key", () => {
  expect(failureHint(failed("auth"))).toBeNull();
  expect(failureHint(failed("auth", { credential: "missing" }))).toBeNull();
  expect(failureHint(failed("auth", { credential: "rejected" }))).toMatch(/check or replace it/);
});

it("says when a usage limit resets, when the runtime named it", () => {
  const resetsAt = "2026-10-10T03:30:00Z";
  const now = Date.parse("2026-10-10T01:25:00Z");
  expect(failureHint(failed("quota", { resetsAt }), now)).toBe("A usage limit ran out: it resets in 2h 5m.");
  expect(failureHint(failed("quota", { resetsAt }))).toMatch(/resets at 03:30 UTC/);
  expect(failureHint(failed("quota", { resetsAt }), Date.parse(resetsAt) + 1)).toMatch(/has reset since/);
});

it("says why an input the runtime took was never read", () => {
  expect(droppedWords("turn_interrupted")).toMatch(/the turn ended first/);
  expect(droppedWords("runtime_exited")).toMatch(/process exited first/);
  expect(droppedWords("runtime_refused")).toMatch(/refused input mid-turn/);
});
