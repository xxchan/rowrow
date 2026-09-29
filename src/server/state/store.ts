// AppState (docs/architecture.md, "Replicating state to clients"): one immutable tree the
// server owns, changed only through update(), replicated to every client as a snapshot
// then patches. Patches are coalesced per tick so a burst of changes is one message.
import { enablePatches, produceWithPatches, type Draft, type Patch } from "immer";
import type { AppState, StateMessage } from "../../shared/schemas.ts";
import { log } from "../telemetry/log.ts";

enablePatches();

type Listener = (message: StateMessage) => void;

export class StateStore {
  private state: AppState;
  private version = 0;
  private pending: Patch[] = [];
  private flushScheduled = false;
  private readonly listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  get(): { version: number; state: AppState } {
    return { version: this.version, state: this.state };
  }

  /** Change the state. `action` names the change in the log (state.change at debug level). */
  update(action: string, recipe: (draft: Draft<AppState>) => void): void {
    const [next, patches] = produceWithPatches(this.state, recipe);
    if (patches.length === 0) return;
    this.state = next;
    this.version += 1;
    this.pending.push(...patches);
    log.debug("state.change", { action, paths: patches.map((p) => p.path.join(".")).slice(0, 10) });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.pending.length === 0) return;
    const message: StateMessage = { kind: "patches", version: this.version, patches: this.pending };
    this.pending = [];
    for (const listener of this.listeners) listener(message);
  }

  /**
   * Subscribe: the listener gets a snapshot now, then patch messages. Patches still waiting
   * for the next tick are delivered to the existing listeners first, so the snapshot and
   * the patches that follow it never overlap (array patches are not idempotent).
   */
  watch(listener: Listener): () => void {
    this.flush();
    listener({ kind: "snapshot", version: this.version, state: this.state });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
