// The runtimes rowrow can start agents with: oar's built-in ones (Claude Code, Codex, Cursor,
// Antigravity, Grok, Kimi, Pi), plus the scripted runtime in test and dev profiles. Installation probes are
// local and cheap; model lists may ask the runtime's provider, so they are cached, and so are
// update checks (each asks the runtime's release feed). An upgrade runs the runtime's own
// updater, only when someone asks for it.
import {
  createCursorRuntime,
  runtimes as builtins,
  type AvailableInstallation,
  type Runtime,
  type Session,
  type SessionOptions,
} from "@botiverse/oar";
import type {
  ModelInfo,
  RuntimeInfo,
  RuntimeUpdate,
  SkillInfo,
  UpdateCheck,
  UpgradeResult,
} from "../../shared/schemas.ts";
import { UserError } from "../errors.ts";
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
const SKILLS_TTL_MS = 60_000;
const UPDATES_TTL_MS = 60 * 60_000;
/** The end of an updater's output is where it says what went wrong. */
const OUTPUT_CHARS = 8000;

/**
 * oar's built-in runtimes, and Cursor, whose SDK rowrow installs and hands to oar (oar 0.20): it
 * loads the first time a Cursor agent runs. Listed by id, the order every screen shows.
 */
function hostRuntimes(): Runtime[] {
  const cursor = createCursorRuntime({ sdk: () => import("@cursor/sdk") });
  return [...builtins.list(), cursor].sort((a, b) => a.id.localeCompare(b.id));
}

export class Runtimes {
  private readonly known = new Map<string, Known>();
  private readonly models = new Map<string, { at: number; models: ModelInfo[]; error: string | null }>();
  private readonly skillsCache = new Map<string, { at: number; skills: SkillInfo[]; error: string | null }>();
  private readonly checks = new Map<string, { at: number; check: UpdateCheck }>();
  private readonly upgrading = new Map<string, Promise<UpgradeResult>>();

  constructor(options: {
    readonly testRuntime: boolean;
    readonly probe: boolean;
    /** Runtimes to know besides oar's built-in ones (tests). */
    readonly extra?: readonly Runtime[];
  }) {
    const list: { runtime: Runtime; test: boolean }[] = options.probe
      ? hostRuntimes().map((runtime) => ({ runtime, test: false }))
      : [];
    if (options.testRuntime) list.push({ runtime: scriptedDemoRuntime(), test: true });
    for (const runtime of options.extra ?? []) list.push({ runtime, test: false });
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

  /**
   * Probe every runtime's installation (in parallel, bounded by a timeout each). `probed` is
   * called as each one is known, so a slow CLI (kimi can take seconds) doesn't hide the rest.
   */
  async refresh(probed?: () => void): Promise<RuntimeInfo[]> {
    await Promise.all(
      [...this.known.values()].map(async (known) => {
        await this.probe(known);
        probed?.();
      }),
    );
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

  /** Whether each real runtime has a newer version out (the scripted one never does). */
  async updates(refresh: boolean): Promise<RuntimeUpdate[]> {
    return Promise.all(
      [...this.known.values()]
        .filter((known) => !known.test)
        .map(async (known) => ({
          runtime: known.runtime.id,
          check: await this.checkUpdate(known, refresh),
          canUpgrade: known.installation !== null && known.runtime.upgrade !== undefined,
        })),
    );
  }

  private async checkUpdate(known: Known, refresh: boolean): Promise<UpdateCheck> {
    const { runtime, installation } = known;
    if (installation === null) return { kind: "unavailable", reason: "not_installed" };
    if (runtime.checkUpdate === undefined) {
      // Pi: oar carries its SDK, so it updates with rowrow.
      return {
        kind: "unavailable",
        reason: "no_updater",
        detail: `${runtime.brand.name} updates with rowrow.`,
      };
    }
    const cached = this.checks.get(runtime.id);
    if (!refresh && cached !== undefined && Date.now() - cached.at < UPDATES_TTL_MS) return cached.check;
    let check: UpdateCheck;
    try {
      check = await runtime.checkUpdate(installation);
    } catch (error) {
      check = {
        kind: "unavailable",
        reason: "lookup_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    log.info("runtime.update_checked", {
      runtime: runtime.id,
      ...(check.kind === "ok"
        ? { installed: check.installed, latest: check.latest, updateAvailable: check.updateAvailable }
        : { reason: check.reason, detail: check.detail }),
    });
    this.checks.set(runtime.id, { at: Date.now(), check });
    return check;
  }

  /**
   * Run the runtime's own updater, then probe it again. One at a time per runtime: asking
   * again while it runs waits for the same run.
   */
  upgrade(id: string): Promise<UpgradeResult> {
    const known = this.known.get(id);
    if (known === undefined || known.test) throw new UserError(`no runtime ${id}`, "NOT_FOUND");
    const running = this.upgrading.get(id);
    if (running !== undefined) return running;
    const run = this.runUpgrade(known).finally(() => this.upgrading.delete(id));
    this.upgrading.set(id, run);
    return run;
  }

  private async runUpgrade(known: Known): Promise<UpgradeResult> {
    const { runtime, installation } = known;
    if (installation === null) {
      return {
        kind: "unsupported",
        reason: "not_installed",
        detail: `${runtime.brand.name} is not installed.`,
      };
    }
    if (runtime.upgrade === undefined) {
      return {
        kind: "unsupported",
        reason: "unsupported_installation",
        detail: `${runtime.brand.name} updates with rowrow.`,
      };
    }
    const started = Date.now();
    log.info("runtime.upgrade_started", { runtime: runtime.id, version: known.info.version });
    const result = clipOutput(await runtime.upgrade(installation));
    log.info("runtime.upgrade_finished", {
      runtime: runtime.id,
      kind: result.kind,
      ...(result.kind === "upgraded" ? { from: result.from, to: result.to } : {}),
      ...(result.kind === "failed" ? { exitCode: result.exitCode, output: result.output.slice(-1000) } : {}),
      ms: Date.now() - started,
    });
    this.checks.delete(runtime.id);
    await this.probe(known);
    return result;
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
    // A runtime that takes no environment (Cursor runs inside rowrow through its SDK) opens without
    // one: its agents can't use the rowrow CLI as themselves.
    if (known.runtime.refusedSessionOptions?.env !== undefined && options.env !== undefined) {
      const { env: _refused, ...rest } = options;
      return known.runtime.session(known.installation, rest);
    }
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
                  // Claude lists its own "default" alias; no model already means that (Default).
                  .filter((model) => model.disabled === undefined && model.id !== "default")
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

  /** What the runtime accepts as `/name` in `cwd`: its skills and custom commands, read natively. */
  async skills(id: string, cwd: string): Promise<{ skills: SkillInfo[]; error: string | null }> {
    const key = `${id}\0${cwd}`;
    const cached = this.skillsCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < SKILLS_TTL_MS) return cached;
    const known = this.known.get(id);
    if (known === undefined) return { skills: [], error: `unknown runtime "${id}"` };
    if (known.installation === null) await this.probe(known);
    let result: { skills: SkillInfo[]; error: string | null };
    if (known.installation === null) result = { skills: [], error: known.info.reason };
    else {
      try {
        const listed = await known.runtime.skills(known.installation, { cwd, timeoutMs: 15_000 });
        result =
          listed.kind === "ok"
            ? {
                skills: listed.items
                  .filter((skill) => skill.enabled !== false)
                  .map((skill) => ({
                    name: skill.name,
                    description: skill.description ?? null,
                    source: skill.source ?? null,
                  }))
                  .sort((a, b) => a.name.localeCompare(b.name)),
                error: null,
              }
            : {
                skills: [],
                error:
                  listed.kind === "unsupported"
                    ? `${known.info.name} doesn't list its commands`
                    : listed.reason,
              };
      } catch (error) {
        result = { skills: [], error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.skillsCache.set(key, { at: Date.now(), ...result });
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

function clipOutput(result: UpgradeResult): UpgradeResult {
  if (!("output" in result) || result.output.length <= OUTPUT_CHARS) return result;
  return { ...result, output: `…${result.output.slice(-OUTPUT_CHARS)}` };
}
