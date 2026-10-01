import { describe, expect, it } from "vitest";
import type { UpdateView } from "./api.ts";
import { checkOutcome } from "./update-words.ts";

const view = (changes: Partial<UpdateView>): UpdateView => ({
  current: "0.3.8",
  state: "idle",
  version: null,
  progress: null,
  error: null,
  checkedAt: 1,
  ...changes,
});

describe("checkOutcome", () => {
  it("says what a check by hand found, nothing newer included", () => {
    expect(checkOutcome(view({}))?.detail).toBe("rowrow 0.3.8 is the newest version.");
    expect(checkOutcome(view({ state: "downloading", version: "0.3.9" }))?.message).toBe(
      "Downloading rowrow 0.3.9",
    );
    expect(checkOutcome(view({ state: "error", error: "move it to Applications" }))).toEqual({
      message: "Couldn't update rowrow",
      detail: "move it to Applications",
    });
    expect(checkOutcome(view({ state: "ready", version: "0.3.9" }))).toBeNull();
  });
});
