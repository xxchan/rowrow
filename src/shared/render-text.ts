// Plain-text rendering of a timeline: what `rowrow agent view` prints, and what a debugging
// agent reads instead of a screenshot. Same fold as the UI, so the text is what the UI
// showed.
import type { ViewMessage, ViewNotice, ViewPart } from "@botiverse/oar/observe";
import type { Actor } from "./entries.ts";
import type { Timeline } from "./timeline.ts";

export interface RenderTextOptions {
  /** Cut tool input and output to this many characters (default 400; 0 hides them). */
  readonly toolChars?: number;
}

export function renderText(timeline: Timeline, options: RenderTextOptions = {}): string {
  const toolChars = options.toolChars ?? 400;
  const out: string[] = [];
  for (const block of timeline.blocks) {
    switch (block.kind) {
      case "input":
        if (!block.delivered) {
          const state =
            block.result === undefined
              ? "pending"
              : `${block.result.landed}${block.result.reason === undefined ? "" : `: ${block.result.reason}`}`;
          out.push(`> [${actorLabel(block.input.by)}, ${state}] ${block.input.text}`);
        }
        break;
      case "notice": {
        const { entry } = block;
        if (entry.kind === "run.failed") out.push(`! run ${entry.runId} failed to start: ${entry.error}`);
        else if (entry.kind === "host.error") out.push(`! ${entry.code}: ${entry.message}`);
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
        for (const message of block.view.messages) out.push(...renderMessage(message, timeline, toolChars));
        if (block.ended !== undefined) {
          const { reason, code, error } = block.ended;
          out.push(
            `── run ended: ${reason}${code === undefined || code === null ? "" : ` (code ${code})`}${error === undefined ? "" : `: ${error}`} ──`,
          );
        }
        break;
      }
    }
  }
  return `${out.join("\n")}\n`;
}

function renderMessage(message: ViewMessage, timeline: Timeline, toolChars: number): string[] {
  switch (message.kind) {
    case "input": {
      const { input } = message;
      const origin = input.inputId === undefined ? undefined : timeline.inputs.get(input.inputId)?.input.by;
      const who = origin === undefined ? "input" : actorLabel(origin);
      const state = input.state === "accepted" ? "" : `, ${input.state}`;
      return [`> [${who}${state}] ${input.input}`];
    }
    case "notice":
      return [`· ${noticeText(message.notice)}`];
    case "turn": {
      const lines: string[] = [];
      for (const section of message.sections) {
        const indent = "  ".repeat(section.agentPath.length + 1);
        if (section.agentPath.length > 0)
          lines.push(`${"  ".repeat(section.agentPath.length)}↳ ${section.agentPath.join(" / ")}`);
        for (const part of section.parts) lines.push(...renderPart(part, indent, toolChars));
      }
      const { outcome } = message;
      if (outcome !== undefined) {
        lines.push(
          outcome.kind === "completed"
            ? "  ✓ turn completed"
            : outcome.kind === "aborted"
              ? "  ■ turn aborted"
              : `  ✗ turn failed (${outcome.failure}): ${outcome.reason}`,
        );
      }
      return lines;
    }
  }
}

function renderPart(part: ViewPart, indent: string, toolChars: number): string[] {
  switch (part.kind) {
    case "text":
      return part.text.split("\n").map((line) => `${indent}${line}`);
    case "reasoning":
      return part.content.kind === "text"
        ? [`${indent}(thinking) ${clip(part.content.text.replaceAll("\n", " "), 200)}`]
        : [`${indent}(thinking)`];
    case "tool": {
      const mark = part.result === "running" ? "…" : part.result === "failed" ? "✗" : "⏺";
      const lines = [
        `${indent}${mark} ${part.tool}${toolChars > 0 && part.input !== undefined ? `: ${clip(oneLine(part.input), toolChars)}` : ""}`,
      ];
      if (toolChars > 0 && part.output !== undefined && part.output !== "")
        lines.push(`${indent}  ⎿ ${clip(oneLine(part.output), toolChars)}`);
      return lines;
    }
    case "notice":
      return [`${indent}· ${noticeText(part.notice)}`];
    case "app_request":
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

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
