// Is a newer rowrow published? (docs/decisions.md, D-025.) An installed package asks the npm
// registry it was installed from, soon after starting and then twice a day, and puts the
// answer in the host info every client renders. Nothing about you is sent: it is the same
// request `npm view rowrow` makes. Off with the checkForUpdates setting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UpdateInfo } from "../shared/schemas.ts";
import { compareVersions, isVersion, isPrerelease } from "../shared/versions.ts";
import { rowrowHome } from "./config.ts";
import { installKind, type InstallKind } from "./install.ts";
import { log, serializeError } from "./telemetry/log.ts";

export { compareVersions };

const PACKAGE = "rowrow";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const FIRST_CHECK_MS = 10_000;
const EVERY_MS = 12 * 3600_000;

/** The registry npm would install from: npm's environment, then ~/.npmrc, then npmjs.org. */
export function npmRegistry(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const fromEnv = env["npm_config_registry"] ?? env["NPM_CONFIG_REGISTRY"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv.replace(/\/+$/, "");
  try {
    const npmrc = fs.readFileSync(path.join(home, ".npmrc"), "utf8");
    const line = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(npmrc);
    if (line?.[1] !== undefined) return line[1].replace(/\/+$/, "");
  } catch {
    // no ~/.npmrc: npm's default
  }
  return DEFAULT_REGISTRY;
}

/**
 * The newest version worth offering: `latest`, or, when you run a prerelease, `next` too if
 * it is newer. null when you have it already.
 */
export function newerVersion(current: string, distTags: Readonly<Record<string, string>>): string | null {
  const candidates = [distTags["latest"], isPrerelease(current) ? distTags["next"] : undefined].filter(
    (v): v is string => v !== undefined && isVersion(v),
  );
  const best = candidates.sort(compareVersions).at(-1);
  return best !== undefined && compareVersions(best, current) > 0 ? best : null;
}

export interface Install {
  /** How this copy was installed, which decides the command that updates it. */
  readonly kind: Exclude<InstallKind, "checkout">;
  /** Started by launchd or systemd through `rowrow service`. */
  readonly service: boolean;
  readonly profile: string;
}

/** Where the package lives says how it was installed. */
export function detectInstall(
  packageRoot: string,
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): Install {
  const found = installKind(packageRoot, rowrowHome(env));
  const kind = found === "checkout" ? "npm" : found;
  const service = env["ROWROW_SERVICE"] === "1" || env["XPC_SERVICE_NAME"] === `dev.rowrow.${profile}`;
  return { kind, service, profile };
}

/** What to run to get `version`, and what to do after. */
export function updateCommand(install: Install, version: string): { command: string; after: string | null } {
  const flag = install.profile === "default" ? "" : ` --profile ${install.profile}`;
  if (install.kind === "bundle") {
    // The Mac app upgrades its bundles itself; this is only said when someone asks npm anyway.
    return { command: `npm install -g rowrow@${version} && rowrow service install${flag}`, after: null };
  }
  if (install.kind === "npx") {
    return {
      command: `npx rowrow@${version} serve${flag}`,
      after: "Stop this server first (Ctrl-C in its terminal).",
    };
  }
  const get = install.kind === "pnpm" ? `pnpm add -g rowrow@${version}` : `npm install -g rowrow@${version}`;
  if (install.service) return { command: `${get} && rowrow service restart${flag}`, after: null };
  return { command: get, after: "Then restart `rowrow serve`." };
}

export interface UpdateCheckerOptions {
  readonly current: string;
  readonly install: Install;
  readonly registry: string;
  readonly enabled: () => boolean;
  readonly changed: (update: UpdateInfo | null) => void;
  readonly fetch?: typeof fetch;
}

export class UpdateChecker {
  readonly #options: UpdateCheckerOptions;
  #timer: NodeJS.Timeout | null = null;
  #current: UpdateInfo | null = null;
  #checking: Promise<void> | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.#options = options;
  }

  get current(): UpdateInfo | null {
    return this.#current;
  }

  start(delayMs = FIRST_CHECK_MS): void {
    this.stop();
    this.#timer = setTimeout(() => {
      this.#timer = setInterval(() => void this.check(), EVERY_MS);
      this.#timer.unref();
      void this.check();
    }, delayMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Ask the registry now; clears what's known when checking is off. */
  check(): Promise<void> {
    if (!this.#options.enabled()) {
      this.#set(null);
      return Promise.resolve();
    }
    this.#checking ??= this.#ask().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #ask(): Promise<void> {
    const { registry, current, install } = this.#options;
    const url = `${registry}/${PACKAGE}`;
    try {
      const response = await (this.#options.fetch ?? fetch)(url, {
        // The abbreviated document: dist-tags and versions, without every README.
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { "dist-tags"?: Record<string, string> };
      const latest = newerVersion(current, body["dist-tags"] ?? {});
      if (!this.#options.enabled()) return;
      log.info("update.checked", { registry, current, available: latest });
      this.#set(latest === null ? null : { version: latest, ...updateCommand(install, latest) });
    } catch (error) {
      log.warn("update.check_failed", { registry, err: serializeError(error) });
    }
  }

  #set(update: UpdateInfo | null): void {
    if (JSON.stringify(update) === JSON.stringify(this.#current)) return;
    this.#current = update;
    this.#options.changed(update);
  }
}
