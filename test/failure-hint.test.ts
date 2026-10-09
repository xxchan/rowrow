// What a failed turn says to do next, by oar's failure class (failureAdvice).
import { expect, it } from "vitest";
import { droppedWords, failureHint } from "../src/shared/describe.ts";

it("says what a failed turn needs: a step from you, a wait, or just sending again", () => {
  expect(failureHint("billing")).toMatch(/billing/);
  expect(failureHint("model_unavailable")).toMatch(/pick another/);
  expect(failureHint("input_too_large")).toMatch(/shorter/);
  expect(failureHint("quota")).toMatch(/Subscription usage/);
  for (const failure of ["rate_limited", "overloaded", "provider", "runtime_exited"] as const) {
    expect(failureHint(failure)).toMatch(/send it again in a moment/);
  }
  // Sign-in has its own steps; for the rest, sending it again won't help and there's no step to name.
  for (const failure of ["auth", "invalid_request", "unknown"] as const)
    expect(failureHint(failure)).toBeNull();
});

it("sends you to sign in only when the login is missing, not when the provider rejected the key", () => {
  expect(failureHint("auth")).toBeNull();
  expect(failureHint("auth", "missing")).toBeNull();
  expect(failureHint("auth", "rejected")).toMatch(/check or replace it/);
});

it("says why an input the runtime took was never read", () => {
  expect(droppedWords("turn_interrupted")).toMatch(/the turn ended first/);
  expect(droppedWords("runtime_exited")).toMatch(/process exited first/);
  expect(droppedWords("runtime_refused")).toMatch(/refused input mid-turn/);
});
