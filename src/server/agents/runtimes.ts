// The runtimes rowrow can start agents with: oar's built-in ones (Claude Code, Codex, Cursor,
// Antigravity, Grok, Kimi, OpenCode, Pi), plus the scripted runtime in test and dev profiles. Installation probes are
// local and cheap; model lists may ask the runtime's provider, so they are cached, and so are
// update checks (each asks the runtime's release feed). An upgrade runs the runtime's own
// updater, and a login its own sign-in, only when someone asks for it.
import {
  createCursorRuntime,
  defaultRuntimes as builtins,
  type AvailableInstallation,
  type ProviderLoginPrompt,
  type Runtime,
  type Session,
  type SessionOptions,
} from "@botiverse/oar";
import { randomUUID } from "node:crypto";
import type {
  AuthState,
  LoginProgress,
  LoginResult,
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

/** A sign-in running now: its question's answer goes to `answer`, and `abort` stops it. */
interface Login {
  readonly abort: AbortController;
  answer: { readonly promptId: string; readonly resolve: (text: string) => void } | null;
}

/**
 * A safety net around a whole installation probe, not a limit of our own: oar bounds each
 * command a probe runs (15 s by default, 30 s where a runtime says so), and a probe may run
 * two (Codex; Kimi, at 30 s each). Past it, the reason says rowrow stopped waiting.
 */
const PROBE_TIMEOUT_MS = 90_000;
/** Asking whether a runtime is signed in runs one local status command. */
const AUTH_TIMEOUT_MS = 10_000;
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
  private readonly logins = new Map<string, { readonly login: Login; readonly done: Promise<LoginResult> }>();
  private readonly changed: () => void;

  constructor(options: {
    readonly testRuntime: boolean;
    readonly probe: boolean;
    /** Runtimes to know besides oar's built-in ones (tests). */
    readonly extra?: readonly Runtime[];
    /** A runtime's info changed outside `refresh` (a sign-in's progress, or its end). */
    readonly changed?: () => void;
  }) {
    this.changed = options.changed ?? (() => undefined);
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
          auth: null,
          canLogin: false,
          login: null,
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
              `rowrow stopped waiting for ${runtime.brand.name} to answer after ${PROBE_TIMEOUT_MS / 1000} s`,
            );
      if (snapshot.kind === "available") {
        // Read before the update below, which must not spread an info from before this await
        // (a sign-in's progress may change it meanwhile).
        const auth = await readAuth(runtime, snapshot);
        known.installation = snapshot;
        known.info = {
          ...known.info,
          installed: true,
          version: snapshot.via === "executable" ? (snapshot.version ?? null) : null,
          reason: null,
          auth,
          canLogin: runtime.login !== undefined,
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
          auth: null,
          canLogin: false,
        };
      }
      log.info("runtime.probe", {
        runtime: runtime.id,
        installed: known.info.installed,
        version: known.info.version,
        auth: known.info.auth?.kind ?? null,
        ms: Date.now() - started,
      });
    } catch (error) {
      known.installation = null;
      known.info = {
        ...known.info,
        installed: false,
        reason: error instanceof Error ? error.message : String(error),
        auth: null,
        canLogin: false,
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
      return { kind: "unavailable", reason: "no_updater", detail: noUpdater(runtime, installation) };
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
        detail: noUpdater(runtime, installation),
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

  /**
   * Sign a runtime in through its own login (oar's `login`). What the person opens or types,
   * and the question it waits on, are in the runtime's info (`login`) until it ends; then it is
   * probed again, so every client sees who it is signed in as. One at a time per runtime:
   * asking again while it runs waits for the same one.
   */
  login(id: string): Promise<LoginResult> {
    const known = this.known.get(id);
    if (known === undefined) throw new UserError(`no runtime ${id}`, "NOT_FOUND");
    const running = this.logins.get(id);
    if (running !== undefined) return running.done;
    const login: Login = { abort: new AbortController(), answer: null };
    const done = this.runLogin(known, login).finally(() => this.logins.delete(id));
    this.logins.set(id, { login, done });
    return done;
  }

  /** Answer the question a running sign-in waits on. Never logged: it may be a code. */
  answerLogin(id: string, promptId: string, answer: string): void {
    const waiting = this.logins.get(id)?.login.answer;
    if (waiting === undefined || waiting === null || waiting.promptId !== promptId)
      throw new UserError("That sign-in isn't waiting for this answer any more.", "CONFLICT");
    waiting.resolve(answer);
  }

  /** Stop a running sign-in; the runtime's previous login stays as it was. */
  cancelLogin(id: string): void {
    this.logins.get(id)?.login.abort.abort();
  }

  private async runLogin(known: Known, login: Login): Promise<LoginResult> {
    const { runtime, installation } = known;
    if (installation === null) {
      return {
        kind: "unsupported",
        reason: "not_installed",
        detail: `${runtime.brand.name} is not installed.`,
      };
    }
    if (runtime.login === undefined) {
      return {
        kind: "unsupported",
        reason: "unsupported_installation",
        detail: `rowrow can't sign ${runtime.brand.name} in: use its own CLI.`,
      };
    }
    const progress = (change: (now: LoginProgress) => LoginProgress): void => {
      const now = known.info.login;
      if (now === null) return;
      known.info = { ...known.info, login: change(now) };
      this.changed();
    };
    known.info = { ...known.info, login: { id: randomUUID(), events: [], prompt: null } };
    this.changed();
    const started = Date.now();
    log.info("runtime.login_started", { runtime: runtime.id });
    let result: LoginResult;
    try {
      result = await runtime.login(installation, {
        signal: login.abort.signal,
        onEvent: (event) => {
          // A device code's poll interval is the runtime's business, not the person's.
          const shown =
            event.kind === "device_code"
              ? {
                  kind: event.kind,
                  userCode: event.userCode,
                  verificationUri: event.verificationUri,
                  ...(event.expiresInSeconds === undefined
                    ? {}
                    : { expiresInSeconds: event.expiresInSeconds }),
                }
              : event;
          progress((now) => ({ ...now, events: [...now.events, shown] }));
        },
        prompt: (prompt) =>
          new Promise<string>((resolve, reject) => {
            const promptId = randomUUID();
            if (login.abort.signal.aborted) {
              reject(new Error("sign-in cancelled"));
              return;
            }
            login.abort.signal.addEventListener("abort", () => reject(new Error("sign-in cancelled")), {
              once: true,
            });
            login.answer = {
              promptId,
              resolve: (text) => {
                login.answer = null;
                progress((now) => ({ ...now, prompt: null }));
                resolve(text);
              },
            };
            progress((now) => ({ ...now, prompt: loginPrompt(promptId, prompt) }));
          }),
      });
    } catch (error) {
      result = {
        kind: "failed",
        reason: "process_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    log.info("runtime.login_finished", {
      runtime: runtime.id,
      kind: result.kind,
      ...(result.kind === "failed" || result.kind === "unsupported"
        ? { reason: result.reason, detail: result.detail }
        : {}),
      ms: Date.now() - started,
    });
    // A question still open is moot now (oar: the caller closes it).
    login.answer = null;
    known.info = { ...known.info, login: null };
    await this.probe(known);
    this.changed();
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

/**
 * Why rowrow can't update a runtime oar has no updater for: Pi's SDK comes with oar, so it
 * updates with rowrow; an installed CLI (OpenCode) updates itself, outside rowrow.
 */
function noUpdater(runtime: Runtime, installation: AvailableInstallation): string {
  return installation.via === "bundled"
    ? `${runtime.brand.name} updates with rowrow.`
    : `rowrow can't update ${runtime.brand.name}: use its own updater.`;
}

/** Whether it is signed in, by its own status query; null when it has none. */
async function readAuth(runtime: Runtime, installation: AvailableInstallation): Promise<AuthState | null> {
  if (runtime.authStatus === undefined) return null;
  try {
    const status = await withTimeout(
      runtime.authStatus(installation, { timeoutMs: AUTH_TIMEOUT_MS }),
      AUTH_TIMEOUT_MS + 1000,
      `asking ${runtime.id} whether it is signed in took too long`,
    );
    switch (status.kind) {
      case "logged_in":
        return status.account === undefined
          ? { kind: status.kind }
          : { kind: status.kind, account: status.account };
      case "logged_out":
        return { kind: status.kind };
      case "unknown":
        return status.detail === undefined
          ? { kind: status.kind }
          : { kind: status.kind, detail: status.detail };
    }
  } catch (error) {
    return { kind: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
}

function loginPrompt(id: string, prompt: ProviderLoginPrompt): LoginProgress["prompt"] {
  return prompt.kind === "select"
    ? { id, kind: prompt.kind, message: prompt.message, options: [...prompt.options] }
    : {
        id,
        kind: prompt.kind,
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      };
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
