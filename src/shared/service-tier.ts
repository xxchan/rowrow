// Fast mode (codex's /fast, claude's fast mode): a model's faster, pricier service tier, set per
// agent like its model and effort (D-049). Agents keep the runtime's own tier id; these say
// which one is Fast, and in words.
import type { ModelInfo } from "./schemas.ts";

/** Turns a special tier off, rather than leaving it to the runtime's settings. Not in any catalog. */
export const NO_TIER = "default";

/**
 * The tier that is a runtime's Fast mode: codex's is `priority` (it reads `fast` back as that,
 * so oar refuses `fast`); claude's, like the scripted demo's, is `fast`.
 */
export function fastTierOf(runtime: string): string {
  return runtime === "codex" ? "priority" : "fast";
}

/**
 * The tier Fast asks for with this model, or null when the model has no Fast mode (or can't
 * be looked up), so there's nothing to switch. `model` null is the runtime's default: the model
 * it reported running when it's listed, else the first it lists, as Coach's pickers assume.
 */
export function fastTier(
  runtime: string,
  models: readonly ModelInfo[],
  model: string | null,
  reportedModel: string | null = null,
): string | null {
  const entry =
    model === null
      ? (models.find((m) => m.id === reportedModel) ?? models[0])
      : models.find((m) => m.id === model);
  const tier = fastTierOf(runtime);
  return entry?.serviceTiers.includes(tier) === true ? tier : null;
}

/** Whether Fast mode is on: the tier the runtime reported, else the one you asked for. */
export function fastOn(summary: {
  readonly runtime: string;
  readonly serviceTier: string | null;
  readonly reportedServiceTier: string | null;
}): boolean {
  return (summary.reportedServiceTier ?? summary.serviceTier) === fastTierOf(summary.runtime);
}

/** A tier as notices and the CLI say it, whichever runtime asked: `fast` and `priority` are Fast. */
export function tierWords(tier: string | null): string {
  if (tier === null) return "Fast mode as the runtime is set";
  if (tier === NO_TIER) return "Fast mode off";
  return tier === "fast" || tier === "priority" ? "Fast mode on" : `service tier ${tier}`;
}
