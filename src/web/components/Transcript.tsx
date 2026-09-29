// The transcript: the timeline fold (src/shared/timeline.ts) rendered as a conversation.
// Every block and message is memoized on identity, and the fold shares structure, so while
// text streams only the open turn re-renders. Messages carry data-author ("you" or
// "agent"): selection comments quote only what the agent wrote (SelectionComment).
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  classifyTool,
  type ViewMessage,
  type ViewNotice,
  type ViewPart,
  type ViewSection,
} from "@botiverse/oar/observe";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { Check, ChevronRight, CircleAlert, CircleX, LoaderCircle } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { Actor, Attachment } from "../../shared/entries.ts";
import { actorLabel } from "../../shared/render-text.ts";
import type { InputBlock, NoticeBlock, RunBlock, Timeline, TimelineBlock } from "../../shared/timeline.ts";
import { SentAttachments } from "./Attachments.tsx";

export function Transcript({ timeline, runtime }: { timeline: Timeline; runtime: string }) {
  return (
    <div className="flex flex-col gap-5">
      {timeline.blocks.map((block) => (
        <Block key={keyOf(block)} block={block} timeline={timeline} runtime={runtime} />
      ))}
    </div>
  );
}

function keyOf(block: TimelineBlock): string {
  switch (block.kind) {
    case "run":
      return `run:${block.runId}`;
    case "input":
      return `input:${block.input.inputId}`;
    case "notice":
      return `notice:${block.entry.seq}`;
  }
}

const Block = memo(function Block({
  block,
  timeline,
  runtime,
}: {
  block: TimelineBlock;
  timeline: Timeline;
  runtime: string;
}) {
  switch (block.kind) {
    case "run":
      return <Run run={block} timeline={timeline} runtime={runtime} />;
    case "input":
      return block.delivered ? null : <PendingInput block={block} />;
    case "notice":
      return <Notice block={block} />;
  }
});

function Run({ run, timeline, runtime }: { run: RunBlock; timeline: Timeline; runtime: string }) {
  const { started, ended, view } = run;
  return (
    <>
      {started?.resume !== undefined && (
        <SystemLine
          divider
        >{`Resumed${started.model === undefined ? "" : ` on ${started.model}`}`}</SystemLine>
      )}
      {view.messages.map((message, index) =>
        // The run's own end says why the process went away; oar's exit notice would repeat it.
        message.kind === "notice" &&
        message.notice.cause === "exited" &&
        ended !== undefined &&
        ended.reason !== "exited" ? null : (
          <Message
            key={message.id}
            message={message}
            timeline={timeline}
            runtime={runtime}
            open={index === view.openTurn}
          />
        ),
      )}
      {ended !== undefined && ended.reason !== "idle" && ended.reason !== "restart" && (
        <SystemLine>{endText(ended.reason, ended.code)}</SystemLine>
      )}
    </>
  );
}

function endText(reason: string, exitCode: number | null | undefined): string {
  switch (reason) {
    case "stopped":
      return "Stopped. The next message resumes the conversation.";
    case "archived":
      return "Archived.";
    case "shutdown":
      return "rowrow shut down; the next message resumes the conversation.";
    case "crashed":
      return "rowrow stopped unexpectedly while this was running.";
    case "exited":
      return `The agent process exited${exitCode === null || exitCode === undefined ? "" : ` (code ${exitCode})`}.`;
    default:
      return `Run ended: ${reason}`;
  }
}

const Message = memo(function Message({
  message,
  timeline,
  runtime,
  open,
}: {
  message: ViewMessage;
  timeline: Timeline;
  runtime: string;
  open: boolean;
}) {
  switch (message.kind) {
    case "input": {
      const { input } = message;
      const origin = input.inputId === undefined ? undefined : timeline.inputs.get(input.inputId);
      // What you sent (your text and files), rather than the text the runtime read.
      return (
        <UserMessage
          text={origin?.input.text ?? input.input}
          attachments={origin?.input.attachments}
          by={origin?.input.by}
          at={origin?.input.at}
          landed={origin?.result?.landed}
          state={input.state === "rejected" ? "error" : input.state === "pending" ? "sending" : "sent"}
        />
      );
    }
    case "notice":
      return <SystemLine>{noticeText(message.notice)}</SystemLine>;
    case "turn":
      return (
        <article data-author="agent" aria-label="The agent's turn" className="flex min-w-0 flex-col gap-3">
          {message.sections.map((section, index) => (
            <Section
              key={index}
              section={section}
              runtime={runtime}
              streaming={open && index === message.sections.length - 1}
            />
          ))}
          {message.outcome?.kind === "failed" && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {`Failed: ${message.outcome.reason}`}
            </p>
          )}
          {message.outcome?.kind === "aborted" && <p className="text-sm text-muted-foreground">Stopped.</p>}
        </article>
      );
  }
});

function UserMessage({
  text,
  attachments,
  by,
  at,
  landed,
  state,
}: {
  text: string;
  attachments: readonly Attachment[] | undefined;
  by: Actor | undefined;
  at: number | undefined;
  landed: string | undefined;
  state: "sending" | "sent" | "error";
}) {
  const facts = [
    by === undefined ? null : actorLabel(by),
    at === undefined ? null : new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    landed === "steered"
      ? "steered into the running turn"
      : landed === "queued"
        ? "queued for the next turn"
        : null,
  ].filter((part) => part !== null);
  return (
    <article data-author="you" aria-label="Your message" className="flex flex-col items-end gap-1 pl-10">
      {attachments !== undefined && attachments.length > 0 && <SentAttachments attachments={attachments} />}
      {text.trim() !== "" && (
        <div className="max-w-full rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-secondary-foreground">
          {text}
        </div>
      )}
      <div className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
        {state === "sending" ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : state === "error" ? (
          <CircleX className="size-3 text-destructive" />
        ) : (
          <Check className="size-3" />
        )}
        <span>
          {[state === "sending" ? "Sending" : state === "error" ? "Not sent" : "Sent", ...facts].join(" · ")}
        </span>
      </div>
    </article>
  );
}

function PendingInput({ block }: { block: InputBlock }) {
  const failed =
    block.result !== undefined && (block.result.landed === "failed" || block.result.landed === "rejected");
  return (
    <>
      <UserMessage
        text={block.input.text}
        attachments={block.input.attachments}
        by={block.input.by}
        at={block.input.at}
        landed={undefined}
        state={failed ? "error" : "sending"}
      />
      {failed && (
        <SystemLine>{`Not delivered: ${block.result?.reason ?? block.result?.landed ?? ""}`}</SystemLine>
      )}
    </>
  );
}

function Notice({ block }: { block: NoticeBlock }) {
  const { entry } = block;
  switch (entry.kind) {
    case "run.failed":
      return <SystemLine tone="error">{`Couldn't start the agent: ${entry.error}`}</SystemLine>;
    case "host.error":
      return <SystemLine tone="error">{entry.message}</SystemLine>;
    case "agent.updated": {
      const parts = [
        entry.changes.model === undefined ? null : `model: ${entry.changes.model ?? "default"}`,
        entry.changes.effort === undefined ? null : `effort: ${entry.changes.effort ?? "default"}`,
      ].filter((p) => p !== null);
      return <SystemLine divider>{`Switched ${parts.join(", ")}`}</SystemLine>;
    }
  }
}

function SystemLine({
  children,
  divider = false,
  tone,
}: {
  children: ReactNode;
  divider?: boolean;
  tone?: "error";
}) {
  if (divider)
    return (
      <div role="note" className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {children}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  return (
    <p
      role="note"
      className={cn("text-center text-xs text-muted-foreground", tone === "error" && "text-destructive")}
    >
      {children}
    </p>
  );
}

const plugins = { code, cjk };

/** One lane (the agent, or a sub-agent) inside a turn: text, reasoning, tool calls in order. */
function Section({
  section,
  runtime,
  streaming,
}: {
  section: ViewSection;
  runtime: string;
  streaming: boolean;
}) {
  const out: ReactNode[] = [];
  let tools: ViewPart[] = [];
  const flushTools = (): void => {
    if (tools.length === 0) return;
    out.push(<ToolGroup key={`tools-${out.length}`} parts={tools} runtime={runtime} />);
    tools = [];
  };
  section.parts.forEach((part, index) => {
    if (part.kind === "tool") {
      tools.push(part);
      return;
    }
    flushTools();
    const last = index === section.parts.length - 1;
    switch (part.kind) {
      case "text":
        out.push(
          <Streamdown
            key={index}
            className="min-w-0 text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_h4]:text-sm"
            plugins={plugins}
            isAnimating={streaming && last}
            shikiTheme={["github-light", "tokyo-night"]}
            linkSafety={{ enabled: false }}
            codeBlockMaxHeight={480}
          >
            {part.text}
          </Streamdown>,
        );
        break;
      case "reasoning":
        out.push(
          part.content.kind === "text" ? (
            <Disclosure key={index} label={streaming && last ? "Thinking…" : "Thought"}>
              <p className="border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {part.content.text}
              </p>
            </Disclosure>
          ) : (
            <p key={index} className="text-xs text-muted-foreground">
              {streaming && last ? "Thinking…" : "Thought (hidden)"}
            </p>
          ),
        );
        break;
      case "notice":
        out.push(<SystemLine key={index}>{noticeText(part.notice)}</SystemLine>);
        break;
      case "app_request":
        out.push(
          <div key={index} className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            {part.answered
              ? `The agent asked (${part.type}); rowrow answered.`
              : `The agent is asking for something rowrow can't answer yet (${part.type}).`}
          </div>,
        );
        break;
    }
  });
  flushTools();
  const lane = section.agentPath.length === 0 ? null : section.agentPath.join(" / ");
  return lane === null ? (
    <>{out}</>
  ) : (
    <Disclosure label={`Sub-agent ${lane}`} defaultOpen={streaming}>
      <div className="flex flex-col gap-3 border-l-2 pl-3">{out}</div>
    </Disclosure>
  );
}

function Disclosure({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/disclosure">
      <CollapsibleTrigger className="flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/disclosure:rotate-90" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function ToolGroup({ parts, runtime }: { parts: ViewPart[]; runtime: string }) {
  return (
    <div className="divide-y overflow-hidden rounded-lg border bg-card/60">
      {parts.map((part) =>
        part.kind === "tool" ? <ToolCall key={part.callId} part={part} runtime={runtime} /> : null,
      )}
    </div>
  );
}

function ToolCall({ part, runtime }: { part: Extract<ViewPart, { kind: "tool" }>; runtime: string }) {
  const action = classifyTool(runtime, part.tool, part.input);
  const output = part.output ?? "";
  const detail = toolDetail(action.kind, part.input, output);
  const status =
    part.result === "running" ? (
      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-label="Running" />
    ) : part.result === "failed" ? (
      <CircleX className="size-3.5 shrink-0 text-destructive" aria-label="Failed" />
    ) : (
      <Check className="size-3.5 shrink-0 text-success" aria-label="Done" />
    );
  const row = (
    <>
      {status}
      <span className="shrink-0 font-mono text-[12px] text-foreground/90">{part.tool}</span>
      {action.detail !== undefined && (
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
          {action.detail}
        </span>
      )}
    </>
  );
  return (
    <Collapsible className="group/tool">
      {detail === null ? (
        <div className="flex min-h-8 items-center gap-2 px-2.5 py-1.5">{row}</div>
      ) : (
        <CollapsibleTrigger className="flex min-h-8 w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/50">
          {row}
          <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90" />
        </CollapsibleTrigger>
      )}
      {part.result === "failed" && output !== "" && (
        <p className="px-2.5 pb-1.5 pl-8 text-xs break-words text-destructive">{output.slice(0, 300)}</p>
      )}
      {detail !== null && (
        <CollapsibleContent>
          <pre className="max-h-80 overflow-auto border-t bg-code px-3 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
            {detail.slice(0, 20_000)}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/**
 * What an expanded tool call shows: a command as `$ command` then its output; an edit as
 * the text it wrote; anything else as its input (JSON, pretty) then its output.
 */
function toolDetail(kind: string, input: string | undefined, output: string): string | null {
  const parsed = parse(input);
  const field = (...names: string[]): string | null => {
    for (const name of names) {
      const value = parsed?.[name];
      if (typeof value === "string") return value;
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(" ");
    }
    return null;
  };
  const join = (...parts: (string | null)[]): string =>
    parts.filter((p) => p !== null && p !== "").join("\n\n");
  if (kind === "run_command") return join(`$ ${field("command", "cmd") ?? input ?? ""}`, output);
  if (kind === "edit_file") {
    const written = field("content", "new_string", "patch", "diff");
    if (written !== null) return join(written, output === "" ? null : `→ ${output}`);
  }
  const text = join(parsed === null ? (input ?? null) : JSON.stringify(parsed, null, 2), output);
  return text === "" ? null : text;
}

function parse(input: string | undefined): Record<string, unknown> | null {
  if (input === undefined) return null;
  try {
    const value: unknown = JSON.parse(input);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function noticeText(notice: ViewNotice): string {
  switch (notice.cause) {
    case "compaction_started":
      return "Compacting the conversation…";
    case "compaction_ended":
      return notice.outcome === "completed"
        ? "Conversation compacted"
        : `Compaction ${notice.outcome}${notice.reason === undefined ? "" : `: ${notice.reason}`}`;
    case "retry":
      return `Retrying (attempt ${notice.attempt}${notice.maxAttempts === undefined ? "" : ` of ${notice.maxAttempts}`})${notice.reason === undefined ? "" : `: ${notice.reason}`}`;
    case "control_rejected":
      return `${notice.action} was refused: ${notice.reason}`;
    case "child_turn_ended":
      return `A sub-agent finished (${notice.outcome.kind})`;
    case "exited":
      return `The agent process exited${notice.code === null ? "" : ` (code ${notice.code})`}`;
  }
}
