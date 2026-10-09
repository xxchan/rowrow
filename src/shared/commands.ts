// Commands run in a workspace (docs/decisions.md, D-052): tests, `git status`, a dev server,
// without an agent's tokens or a terminal. The server runs each one non-interactively in the
// workspace's directory and keeps the newest runs, with the start and the end of their output,
// in memory. This module is what every side shares: the run as the API gives it, the text a
// screen shows of its output, and the message "Send to agent" puts in a composer.
// No zod here: the kit (src/kit) may read these too.
import type { Actor } from "./entries.ts";
import { codeSpan } from "./feedback.ts";

/** The longest command line the server takes. */
export const MAX_COMMAND_CHARS = 8000;
/** Runs kept per workspace, newest first; a finished run beyond them is forgotten. */
export const RUNS_KEPT = 20;
/** Output kept per run: its first characters and its last, the middle dropped in between. */
export const OUTPUT_HEAD_CHARS = 16 * 1024;
export const OUTPUT_TAIL_CHARS = 240 * 1024;
/** How long Stop waits after SIGTERM before it sends SIGKILL to what's left. */
export const STOP_GRACE_MS = 5000;

/**
 * running; exited (on its own: `exitCode`, or `signal` when a signal it didn't get from rowrow
 * ended it); stopped (Stop, archiving the workspace, the server stopping); failed (it couldn't
 * start: `error`).
 */
export type CommandStatus = "running" | "exited" | "stopped" | "failed";

export interface CommandRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly command: string;
  /** Where it ran: the workspace's directory. */
  readonly cwd: string;
  readonly by: Actor;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly status: CommandStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Stop was asked and it hasn't ended yet. */
  readonly stopping: boolean;
  readonly error: string | null;
}

/**
 * A piece of a run's output (`at`: where it starts, in characters since the run began; an
 * `at` past the end of what you have means the middle was dropped there), or its end.
 */
export type CommandOutput =
  | { readonly kind: "output"; readonly at: number; readonly text: string }
  | { readonly kind: "end"; readonly run: CommandRun };

/**
 * What is kept of a run's output: its first characters, its last, and how many were dropped in
 * between; `cursor` is where the next piece starts. The server keeps a run's output this way,
 * and so does a client that follows it, so neither grows without bound.
 */
export interface OutputText {
  readonly head: string;
  readonly tail: string;
  readonly dropped: number;
  readonly cursor: number;
}

export const NO_OUTPUT: OutputText = { head: "", tail: "", dropped: 0, cursor: 0 };

/**
 * Add a piece of output (`at`: where it starts). A piece past the cursor means the middle was
 * dropped there (the server's, before you followed it); a piece you already have changes
 * nothing. The tail is cut back to its size once it is a quarter over, not on every piece.
 */
export function appendOutput(
  current: OutputText,
  at: number,
  text: string,
  limits: { readonly head: number; readonly tail: number } = {
    head: OUTPUT_HEAD_CHARS,
    tail: OUTPUT_TAIL_CHARS,
  },
): OutputText {
  const end = at + text.length;
  if (end <= current.cursor) return current;
  let fresh = at >= current.cursor ? text : text.slice(current.cursor - at);
  const gap = Math.max(0, at - current.cursor);
  let { head, tail, dropped } = current;
  if (gap === 0 && dropped === 0 && tail === "" && head.length < limits.head) {
    const room = limits.head - head.length;
    head += fresh.slice(0, room);
    fresh = fresh.slice(room);
  }
  dropped += gap;
  tail += fresh;
  if (tail.length > limits.tail * 1.25) {
    dropped += tail.length - limits.tail;
    tail = tail.slice(-limits.tail);
  }
  return { head, tail, dropped, cursor: end };
}

/** What is kept after `after`, as at most two pieces: the rest of the head, the tail. */
export function outputSince(output: OutputText, after: number): { at: number; text: string }[] {
  const pieces: { at: number; text: string }[] = [];
  const start = Math.max(0, after);
  if (start < output.head.length) pieces.push({ at: start, text: output.head.slice(start) });
  const tailStart = output.cursor - output.tail.length;
  const from = Math.max(start, tailStart);
  if (from < output.cursor) pieces.push({ at: from, text: output.tail.slice(from - tailStart) });
  return pieces;
}

/** The output as one text, with a line where the middle was dropped. */
export function outputString(output: OutputText): string {
  return output.dropped === 0
    ? output.head + output.tail
    : `${output.head}${droppedMarker(output.dropped)}${output.tail}`;
}

export function droppedMarker(chars: number): string {
  return `\n[… ${chars.toLocaleString("en-US")} characters of output dropped here: rowrow keeps the start and the end of a run's output …]\n`;
}

// CSI sequences (colors, cursor moves), OSC sequences (titles, links), and other two-character
// escapes; then the control characters a terminal wouldn't print.
const ESCAPES =
  // oxlint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Output as a screen without a terminal shows it: escape sequences (colors) removed, and a
 * carriage return starting its line over, so a progress bar reads as its last state.
 */
export function terminalText(raw: string): string {
  const plain = raw.replace(ESCAPES, "");
  if (!plain.includes("\r")) return plain;
  return plain
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r");
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== "") return parts[i];
      return "";
    })
    .join("\n");
}

/** How long it ran: tenths of a second while that matters. */
export function runDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** How it ended, in a few words: "exit 0", "exit 2", "killed by SIGSEGV", "stopped". */
export function runOutcome(run: CommandRun): string {
  switch (run.status) {
    case "running":
      return run.stopping ? "stopping" : "running";
    case "stopped":
      return "stopped";
    case "failed":
      return "couldn't start";
    case "exited":
      return run.exitCode !== null ? `exit ${run.exitCode}` : `killed by ${run.signal ?? "a signal"}`;
  }
}

/** The end of the output that goes to an agent: enough to see why, short enough to read. */
const REPORT_LINES = 200;
const REPORT_CHARS = 8000;

/**
 * What "Send to agent" puts in the agent's composer, for you to edit before you send it: the
 * command, how it ended, and the end of its output (as `terminalText` shows it) in a fence.
 */
export function commandReport(run: CommandRun, output: string, now = Date.now()): string {
  const took = runDuration((run.endedAt ?? now) - run.startedAt);
  const command = codeSpan(run.command);
  const head =
    run.status === "running"
      ? `${command} is still running (for ${took}).`
      : run.status === "stopped"
        ? `${command} was stopped after ${took}.`
        : run.status === "failed"
          ? `${command} couldn't start: ${run.error ?? "unknown error"}.`
          : run.exitCode !== null
            ? `${command} exited with code ${run.exitCode} after ${took}.`
            : `${command} was killed by ${run.signal ?? "a signal"} after ${took}.`;
  const text = terminalText(output).replace(/\s+$/, "");
  if (text === "") return run.status === "failed" ? `${head}\n` : `${head} It printed nothing.\n`;
  let lines = text.split("\n");
  const cut = lines.length > REPORT_LINES;
  if (cut) lines = lines.slice(-REPORT_LINES);
  while (lines.length > 1 && lines.join("\n").length > REPORT_CHARS) lines = lines.slice(1);
  const shown = lines.join("\n").slice(-REPORT_CHARS);
  const whole = shown.length === text.length;
  const intro =
    run.status === "running"
      ? "Its output so far"
      : whole
        ? "Its output"
        : `The last ${lines.length} lines of its output`;
  const longest = Math.max(0, ...Array.from(shown.matchAll(/`{3,}/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${head} ${intro}:\n\n${fence}\n${shown}\n${fence}\n`;
}
