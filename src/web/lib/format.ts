// Formatting for the web app. An agent's state words live in src/shared/describe.ts, shared
// with the iOS app, and are re-exported here for the web's screens.
export {
  STALL_MS,
  duration,
  failed,
  phaseLabel,
  statusDot,
  title,
  type Tone,
} from "../../shared/describe.ts";

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

export function formatTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);
}

/** A CLI's version number out of whatever it prints ("codex-cli 0.155.1", "2.1.284 (Claude Code)"). */
export function versionNumber(version: string): string {
  return /\d+(?:\.\d+)+(?:-[\w.]+)?/.exec(version)?.[0] ?? version;
}

/** What "Default" means for a model or effort: rowrow passes none, so the CLI decides. */
export function defaultNote(runtimeName: string): string {
  return `${runtimeName}'s own choice: its settings file, or its built-in default`;
}
