// What a failed turn says to do next, by oar's failure class (failureAdvice).
import { expect, it } from "vitest";
import { failureHint } from "../src/shared/describe.ts";

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
