// How the model pickers name a runtime's models (oar 0.57's ModelEntry.default and .provider):
// which one "Default" runs, and whose model an entry is when several providers serve one name.
import type { ModelInfo } from "./schemas.ts";

/** The model a session runs with no `model` set, when the runtime says which (never guessed). */
export function defaultModel(models: readonly ModelInfo[]): ModelInfo | null {
  return models.find((m) => m.default) ?? null;
}

/** A provider as a heading or label says it: its own name, else its id. */
export function providerName(provider: NonNullable<ModelInfo["provider"]>): string {
  return provider.name ?? provider.id;
}

/**
 * A model as a chip or a list says it: its name, and its provider when another listed model
 * has the same name (pi through two providers). An id nobody lists stays as it is.
 */
export function modelLabel(models: readonly ModelInfo[], id: string): string {
  const entry = models.find((m) => m.id === id);
  if (entry === undefined) return id;
  const twin = models.some((m) => m.id !== id && m.name === entry.name);
  return twin && entry.provider !== null ? `${entry.name} · ${providerName(entry.provider)}` : entry.name;
}

/**
 * Models by provider, in the order the runtime lists them, when it names two or more providers;
 * otherwise one group with no provider. A model without one goes last, under no heading.
 */
export function byProvider(
  models: readonly ModelInfo[],
): { provider: ModelInfo["provider"]; models: ModelInfo[] }[] {
  const ids = new Set(models.flatMap((m) => (m.provider === null ? [] : [m.provider.id])));
  if (ids.size < 2) return models.length === 0 ? [] : [{ provider: null, models: [...models] }];
  const groups = new Map<string | null, { provider: ModelInfo["provider"]; models: ModelInfo[] }>();
  for (const m of models) {
    const key = m.provider?.id ?? null;
    if (!groups.has(key)) groups.set(key, { provider: m.provider, models: [] });
    groups.get(key)?.models.push(m);
  }
  const unnamed = groups.get(null);
  groups.delete(null);
  return [...groups.values(), ...(unnamed === undefined ? [] : [unnamed])];
}
