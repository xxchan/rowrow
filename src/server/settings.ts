// Settings that follow you to every device. Stored one key per row (JSON), validated on the
// way in, and replicated in the app state, so every open client sees a change at once.
import { DEFAULT_SETTINGS, Settings } from "../shared/schemas.ts";
import type { StateStore } from "./state/store.ts";
import type { Db } from "./store/db.ts";
import { log } from "./telemetry/log.ts";

export class SettingsService {
  readonly #db: Db;
  readonly #state: StateStore;
  readonly #listeners = new Set<(keys: readonly (keyof Settings)[]) => void>();

  constructor(db: Db, state: StateStore) {
    this.#db = db;
    this.#state = state;
  }

  get(): Settings {
    return this.#state.get().state.settings;
  }

  /** Called with the keys that changed after every update. */
  onChange(listener: (keys: readonly (keyof Settings)[]) => void): void {
    this.#listeners.add(listener);
  }

  /** Reads what's stored over the defaults; a stored value that no longer validates is dropped. */
  load(): void {
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of this.#db.all<{ key: string; value: string }>("select key, value from settings")) {
      if (!(row.key in DEFAULT_SETTINGS)) continue;
      const parsed = Settings.shape[row.key as keyof Settings].safeParse(JSON.parse(row.value));
      if (parsed.success) merged[row.key] = parsed.data;
      else log.warn("settings.invalid_stored", { key: row.key });
    }
    const settings = Settings.parse(merged);
    this.#state.update("settings.load", (draft) => {
      draft.settings = settings;
    });
  }

  update(changes: { readonly [K in keyof Settings]?: Settings[K] | undefined }): Settings {
    const given = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    const next = Settings.parse({ ...this.#state.get().state.settings, ...given });
    const now = Date.now();
    this.#db.transaction(() => {
      for (const key of Object.keys(given) as (keyof Settings)[]) {
        this.#db.run(
          "insert into settings (key, value, updated_at) values (?, ?, ?) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at",
          key,
          JSON.stringify(next[key]),
          now,
        );
      }
    });
    this.#state.update("settings.update", (draft) => {
      draft.settings = next;
    });
    log.info("settings.updated", { keys: Object.keys(given) });
    for (const listener of this.#listeners) listener(Object.keys(given) as (keyof Settings)[]);
    return next;
  }
}
