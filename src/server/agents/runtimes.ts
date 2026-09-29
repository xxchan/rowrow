// The runtimes rowrow can start agents with: oar's built-in ones (Claude Code, Codex, Grok,
// Kimi, Pi), plus the scripted runtime in test and dev profiles. Installation probes are
// local and cheap; model lists may ask the runtime's provider, so they are cached.
import {
  runtimes as builtins,
  type AvailableInstallation,
  type Runtime,
  type Session,
  type SessionOptions,
} from "@botiverse/oar";
import type { ModelInfo, RuntimeInfo } from "../../shared/schemas.ts";
import { log, serializeError } from "../telemetry/log.ts";
import { scriptedDemoRuntime } from "./scripted.ts";

interface Known {
  readonly runtime: Runtime;
  readonly test: boolean;
  installation: AvailableInstallation | null;
  info: RuntimeInfo;
}

const PROBE_TIMEOUT_MS = 10_000;
const MODELS_TTL_MS = 10 * 60_000;

export class Runtimes {
  private readonly known = new Map<string, Known>();
  private readonly models = new Map<string, { at: number; models: ModelInfo[]; error: string | null }>();

  constructor(options: { readonly testRuntime: boolean; readonly probe: boolean }) {
    const list: { runtime: Runtime; test: boolean }[] = options.probe
      ? builtins.list().map((runtime) => ({ runtime, test: false }))
      : [];
    if (options.testRuntime) list.push({ runtime: scriptedDemoRuntime(), test: true });
    for (const { runtime, test } of list) {
      this.known.set(runtime.id, {
        runtime,
        test,
        installation: null,
        info: {
          id: runtime.id,
          name: runtime.brand.name,
          installed: false,
          version: null,
          reason: "not probed yet",
          test,
        },
      });
    }
  }

  list(): RuntimeInfo[] {
    return [...this.known.values()].map((known) => known.info);
  }

  /** Probe every runtime's installation (in parallel, bounded by a timeout each). */
  async refresh(): Promise<RuntimeInfo[]> {
    await Promise.all([...this.known.values()].map(async (known) => this.probe(known)));
    return this.list();
  }

  private async probe(known: Known): Promise<void> {
    const { runtime } = known;
    const started = Date.now();
    try {
      const snapshot =
        runtime.installation === undefined
          ? ({ kind: "available", via: "bundled" } as const)
          : await withTimeout(
              runtime.installation(),
              PROBE_TIMEOUT_MS,
              `probing ${runtime.id} took too long`,
            );
      if (snapshot.kind === "available") {
        known.installation = snapshot;
        known.info = {
          ...known.info,
          installed: true,
          version: snapshot.via === "executable" ? (snapshot.version ?? null) : null,
          reason: null,
        };
      } else {
        known.installation = null;
        known.info = {
          ...known.info,
          installed: false,
          version: null,
          reason:
            snapshot.kind === "not_found"
              ? `${runtime.brand.name} is not installed (not found on PATH)`
              : snapshot.reason,
        };
      }
      log.info("runtime.probe", {
        runtime: runtime.id,
        installed: known.info.installed,
        version: known.info.version,
        ms: Date.now() - started,
      });
    } catch (error) {
      known.installation = null;
      known.info = {
        ...known.info,
        installed: false,
        reason: error instanceof Error ? error.message : String(error),
      };
      log.warn("runtime.probe_failed", { runtime: runtime.id, err: serializeError(error) });
    }
  }

  info(id: string): RuntimeInfo | undefined {
    return this.known.get(id)?.info;
  }

  /** Open a session. Throws with a message a person can act on. */
  async start(id: string, options: SessionOptions): Promise<Session> {
    const known = this.known.get(id);
    if (known === undefined) throw new Error(`unknown runtime "${id}"`);
    if (known.installation === null) await this.probe(known);
    if (known.installation === null)
      throw new Error(known.info.reason ?? `${known.info.name} is not available`);
    return known.runtime.session(known.installation, options);
  }

  async listModels(id: string, refresh = false): Promise<{ models: ModelInfo[]; error: string | null }> {
    const cached = this.models.get(id);
    if (!refresh && cached !== undefined && Date.now() - cached.at < MODELS_TTL_MS) return cached;
    const known = this.known.get(id);
    if (known === undefined) return { models: [], error: `unknown runtime "${id}"` };
    if (known.installation === null) await this.probe(known);
    const lister = known.runtime.listModels;
    let result: { models: ModelInfo[]; error: string | null };
    if (known.installation === null) result = { models: [], error: known.info.reason };
    else if (lister === undefined) result = { models: [], error: "this runtime does not list its models" };
    else {
      try {
        const listed = await lister(known.installation, { timeoutMs: 30_000 });
        result =
          listed.kind === "ok"
            ? {
                models: listed.models
                  .filter((model) => model.disabled === undefined)
                  .map((model) => ({
                    id: model.id,
                    name: model.displayName ?? model.id,
                    effortLevels: [...(model.effortLevels ?? [])],
                    defaultEffort: model.defaultEffort ?? null,
                  })),
                error: null,
              }
            : {
                models: [],
                error:
                  listed.kind === "unauthenticated"
                    ? `not signed in${listed.detail === undefined ? "" : `: ${listed.detail}`}`
                    : listed.reason,
              };
      } catch (error) {
        result = { models: [], error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.models.set(id, { at: Date.now(), ...result });
    return result;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
