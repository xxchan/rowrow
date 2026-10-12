// How the model pickers name a runtime's models (oar 0.57): what Default runs, and whose model an
// entry is when two providers serve the same name (pi).
import { describe, expect, it } from "vitest";
import { byProvider, defaultModel, modelLabel } from "../src/shared/models.ts";
import type { ModelInfo } from "../src/shared/schemas.ts";

const model = (id: string, name: string, provider: ModelInfo["provider"], isDefault = false): ModelInfo => ({
  id,
  name,
  effortLevels: [],
  defaultEffort: null,
  serviceTiers: [],
  default: isDefault,
  provider,
});
const anthropic = { id: "anthropic", name: "Anthropic" };
const openrouter = { id: "openrouter", name: null };
const pi = [
  model("anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5", anthropic),
  model("openrouter/anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", openrouter, true),
  model("openrouter/z-ai/glm-4.6", "GLM 4.6", openrouter),
  model("anthropic/claude-opus-4-1", "Claude Opus 4.1", anthropic),
];

describe("a runtime's models", () => {
  it("say what Default runs only when the runtime does", () => {
    expect(defaultModel(pi)?.id).toBe("openrouter/anthropic/claude-sonnet-4.5");
    expect(defaultModel(pi.map((m) => ({ ...m, default: false })))).toBeNull();
  });

  it("name the provider only when another listed model has the same name", () => {
    expect(modelLabel(pi, "anthropic/claude-sonnet-4-5")).toBe("Claude Sonnet 4.5 · Anthropic");
    // A provider without a display name goes by its id.
    expect(modelLabel(pi, "openrouter/anthropic/claude-sonnet-4.5")).toBe("Claude Sonnet 4.5 · openrouter");
    expect(modelLabel(pi, "openrouter/z-ai/glm-4.6")).toBe("GLM 4.6");
    expect(modelLabel(pi, "gone/model")).toBe("gone/model");
  });

  it("group by provider in list order when there are two or more, else stay one group", () => {
    expect(byProvider(pi).map((g) => [g.provider?.id, g.models.map((m) => m.name)])).toEqual([
      ["anthropic", ["Claude Sonnet 4.5", "Claude Opus 4.1"]],
      ["openrouter", ["Claude Sonnet 4.5", "GLM 4.6"]],
    ]);
    const one = pi.filter((m) => m.provider?.id === "openrouter");
    expect(byProvider(one)).toEqual([{ provider: null, models: one }]);
    const codex = [model("gpt-5.5", "GPT-5.5", null)];
    expect(byProvider(codex)).toEqual([{ provider: null, models: codex }]);
    expect(byProvider([])).toEqual([]);
    // A model no provider claims goes last.
    const mixed = [model("local", "Local", null), ...pi.slice(0, 2)];
    expect(byProvider(mixed).map((g) => g.provider?.id ?? null)).toEqual(["anthropic", "openrouter", null]);
  });
});
