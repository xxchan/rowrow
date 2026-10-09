// Plain-text rendering of a timeline: what `rowrow agent view` prints, and what a debugging
// agent reads instead of a screenshot. Same fold as the UI, so the text is what the UI
// showed.
import { appRequestKind, type ViewMessage, type ViewNotice, type ViewPart } from "@botiverse/oar/observe";
import { droppedWords, failureHint } from "./describe.ts";
import type { Actor, Attachment, EntryOf } from "./entries.ts";
import { foldHiddenThoughts, laneOf, placeNotes, stoppedByAgent, type Timeline } from "./timeline.ts";
import { toolText } from "./tool-output.ts";

export interface RenderTextOptions {
  /** Cut tool input and output to this many characters (default 400; 0 hides them). */
  readonly toolChars?: number;
  /** Cut each message the agent wrote to this many characters (default: whole). */
  readonly textChars?: number;
}

export function renderText(timeline: Timeline, options: RenderTextOptions = {}): string {
  const toolChars = options.toolChars ?? 400;
  const textChars = options.textChars ?? Number.POSITIVE_INFINITY;
  const out: string[] = [];
  for (const block of timeline.blocks) {
    switch (block.kind) {
      case "input":
        if (!block.delivered) {
          const state =
            block.result === undefined
              ? "pending"
              : `${block.result.landed}${block.result.reason === undefined ? "" : `: ${block.result.reason}`}`;
          out.push(
            `> [${actorLabel(block.input.by)}, ${state}] ${cutText(block.input.text, textChars)}`,
            ...attachmentLines(block.input.attachments),
          );
        }
        break;
      case "notice": {
        const { entry } = block;
        if (entry.kind === "run.failed") out.push(`! run ${entry.runId} failed to start: ${entry.error}`);
        else if (entry.kind === "host.error") out.push(`! ${entry.code}: ${entry.message}`);
        else if (entry.kind === "notification.sent") out.push(notifiedLine(entry));
        else out.push(`· model → ${entry.changes.model ?? "default"} (${actorLabel(entry.by)})`);
        break;
      }
      case "run": {
        const s = block.started;
        out.push(
          s === undefined
            ? `── run ${block.runId} (started before this window) ──`
            : `── run ${s.runId} · ${s.runtime}${s.model === undefined ? "" : ` · ${s.model}`}${s.resume === undefined ? "" : " · resumed"} ──`,
        );
        const notes = placeNotes(block);
        out.push(...notes.before.map((note) => notifiedLine(note.entry)));
        for (const message of block.view.messages) {
          const byAgent = stoppedByAgent(block, message.id);
          out.push(
            ...renderMessage(message, timeline, block.view.rootSessionId, { toolChars, textChars }, byAgent),
          );
          out.push(...(notes.after.get(message.id) ?? []).map((note) => notifiedLine(note.entry)));
        }
        if (block.ended !== undefined) {
          const { reason, code, error } = block.ended;
          const exit = code === undefined || code === null ? "" : ` (code ${code})`;
          // Its process exited to end a turn you stopped: that was the stop.
          out.push(
            block.stoppedByExit === true
              ? `── run ended: stopped (its process exited${exit === "" ? "" : `, code ${code}`}) ──`
              : `── run ended: ${reason}${exit}${error === undefined ? "" : `: ${error}`} ──`,
          );
        }
        break;
      }
    }
  }
  return `${out.join("\n")}\n`;
}

/** A notification sent to you: what it said, who sent it, and its dedup key. */
function notifiedLine(entry: EntryOf<"notification.sent">): string {
  const body = entry.body === "" ? "" : ` · ${oneLine(entry.body)}`;
  const key = entry.dedupKey === undefined ? "" : `, key ${entry.dedupKey}`;
  return `· notified you: ${entry.title}${body} (${actorLabel(entry.by)}${key})`;
}

function attachmentLines(attachments: readonly Attachment[] | undefined): string[] {
  return (attachments ?? []).map((file) => `>   attached ${file.name}: ${file.path}`);
}

function renderMessage(
  message: ViewMessage,
  timeline: Timeline,
  rootSessionId: string | undefined,
  cut: { toolChars: number; textChars: number },
  agentStopped = false,
): string[] {
  switch (message.kind) {
    case "input": {
      const { input } = message;
      // What the person sent (their text and files), rather than the text the runtime got.
      const origin = input.inputId === undefined ? undefined : timeline.inputs.get(input.inputId)?.input;
      const who = origin === undefined ? "input" : actorLabel(origin.by);
      const state = input.state === "accepted" ? "" : `, ${input.state}`;
      return [
        `> [${who}${state}] ${cutText(origin?.text ?? input.input, cut.textChars)}`,
        ...attachmentLines(origin?.attachments),
        ...(input.state === "dropped" ? [`  ${droppedWords(input.reason)}`] : []),
      ];
    }
    case "notice":
      return [`· ${noticeText(message.notice)}`];
    case "turn": {
      const lines: string[] = [];
      for (const section of message.sections) {
        const lane = laneOf(section, rootSessionId);
        const indent = "  ".repeat(lane.length + 1);
        if (lane.length > 0) lines.push(`${"  ".repeat(lane.length)}↳ ${lane.join(" / ")}`);
        for (const { part, count } of foldHiddenThoughts(section.parts))
          lines.push(...renderPart(part, indent, cut, count));
      }
      const { outcome } = message;
      if (outcome !== undefined) {
        lines.push(
          outcome.kind === "completed"
            ? "  ✓ turn completed"
            : outcome.kind === "aborted"
              ? agentStopped
                ? "  ■ turn aborted by the agent"
                : "  ■ turn aborted"
              : `  ✗ turn failed (${outcome.failure}): ${outcome.reason}`,
        );
        const hint = outcome.kind === "failed" ? failureHint(outcome.failure, outcome.credential) : null;
        if (hint !== null) lines.push(`    ${hint}`);
      }
      return lines;
    }
  }
}

function renderPart(
  part: ViewPart,
  indent: string,
  { toolChars, textChars }: { toolChars: number; textChars: number },
  /** How many hidden thoughts it stands for (foldHiddenThoughts). */
  count: number,
): string[] {
  switch (part.kind) {
    case "text":
      return cutText(part.text, textChars)
        .split("\n")
        .map((line) => `${indent}${line}`);
    case "reasoning":
      return part.content.kind === "text"
        ? [`${indent}(thinking) ${clip(part.content.text.replaceAll("\n", " "), 200)}`]
        : [`${indent}(thinking)${count > 1 ? ` ×${count}` : ""}`];
    case "tool": {
      const mark = part.result === "running" ? "…" : part.result === "failed" ? "✗" : "⏺";
      const lines = [
        `${indent}${mark} ${part.tool}${toolChars > 0 && part.input !== undefined ? `: ${clip(oneLine(part.input), toolChars)}` : ""}`,
      ];
      const output = toolText(part);
      if (toolChars > 0 && output !== undefined && output !== "")
        lines.push(`${indent}  ⎿ ${clip(oneLine(output), toolChars)}`);
      return lines;
    }
    case "notice":
      return [`${indent}· ${noticeText(part.notice)}`];
    case "app_request":
      if (appRequestKind(part.type) === "service") return [];
      return [`${indent}? ${part.type}${part.answered ? " (answered)" : " (waiting for an answer)"}`];
  }
}

function noticeText(notice: ViewNotice): string {
  switch (notice.cause) {
    case "compaction_started":
      return "compacting context…";
    case "compaction_ended":
      return `context compaction ${notice.outcome}`;
    case "retry":
      return `retrying (attempt ${notice.attempt}${notice.maxAttempts === undefined ? "" : `/${notice.maxAttempts}`})${notice.reason === undefined ? "" : `: ${notice.reason}`}`;
    case "control_rejected":
      return `${notice.action} rejected: ${notice.reason}`;
    case "child_turn_ended":
      return `sub-agent turn ${notice.outcome.kind}`;
    case "exited":
      return `agent process exited${notice.code === null ? "" : ` (code ${notice.code})`}`;
  }
}

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case "device":
      return actor.name;
    case "agent":
      return `agent ${actor.agentId}`;
    case "system":
      return "rowrow";
  }
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function cutText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} characters cut]`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
