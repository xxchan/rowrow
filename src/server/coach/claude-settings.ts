// How Coach's claude signs in when the user's does it through their claude settings file:
// `--setting-sources ""` (LAUNCH_ARGS, tools.ts) keeps that file out, so what sign-in needs
// from it comes back here and nothing else does (hooks, permissions, plugins and the rest stay
// out). Its `env` may hold ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, so it goes in the run's
// environment; its credential helpers are commands, and go in `--settings` with just those keys
// (claude 2.1.292 honors --settings whatever the setting sources, as it documents for --bare).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { log } from "../telemetry/log.ts";

/** The settings keys claude's own code calls its credential helpers (2.1.292). */
const CREDENTIAL_HELPERS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
] as const;

export interface ClaudeSignIn {
  /** The file's `env`: what claude would have put in its own environment. */
  readonly env: Record<string, string>;
  /** Its credential helpers, for `--settings`; null when it has none. */
  readonly helpers: Record<string, string> | null;
}

const NOTHING: ClaudeSignIn = { env: {}, helpers: null };

/** The user's claude settings file, where claude looks: `$CLAUDE_CONFIG_DIR`, or ~/.claude. */
export function claudeSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env["CLAUDE_CONFIG_DIR"] || path.join(os.homedir(), ".claude"), "settings.json");
}

/**
 * What Coach's claude takes from the user's settings file. Nothing when there is none, and
 * nothing (with a warning) when it can't be read: Coach still starts, signed in however claude
 * manages without it. Never logs the file's content (JSON.parse's message quotes it).
 */
export async function claudeSignIn(file: string): Promise<ClaudeSignIn> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      log.warn("coach.claude_settings_unreadable", { file, reason: code ?? "read failed" });
    return NOTHING;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    log.warn("coach.claude_settings_unreadable", { file, reason: "not JSON" });
    return NOTHING;
  }
  if (!isRecord(settings)) {
    log.warn("coach.claude_settings_unreadable", { file, reason: "not a JSON object" });
    return NOTHING;
  }
  const env: Record<string, string> = {};
  if (isRecord(settings["env"]))
    for (const [name, value] of Object.entries(settings["env"]))
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        env[name] = String(value);
  const helpers: Record<string, string> = {};
  for (const key of CREDENTIAL_HELPERS) {
    const value = settings[key];
    if (typeof value === "string" && value !== "") helpers[key] = value;
  }
  return { env, helpers: Object.keys(helpers).length === 0 ? null : helpers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
