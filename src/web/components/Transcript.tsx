// The transcript: the timeline fold (src/shared/timeline.ts) rendered as a conversation.
// Every block and message is memoized on identity, and the fold shares structure, so while
// text streams only the open turn re-renders. Messages carry data-author ("you" or
// "agent"): selection comments quote only what the agent wrote (SelectionComment).
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  appRequestKind,
  classifyTool,
  groupToolActivity,
  toolActionLabel,
  toolGroupSummary,
  type ReasoningPart,
  type ToolGroup as ActivityGroup,
  type ToolPart,
  type ViewMessage,
  type ViewSection,
} from "@botiverse/oar/observe";
import type { CredentialProblem, FailureClass } from "@botiverse/oar";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { Bell, Check, ChevronRight, CircleAlert, CircleX, LoaderCircle } from "lucide-react";
import { Fragment, memo, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { Actor, Attachment, EntryOf } from "../../shared/entries.ts";
import { actorLabel } from "../../shared/render-text.ts";
import { droppedWords, duration, failureHint } from "../../shared/describe.ts";
import { signInSteps } from "../../shared/sign-in.ts";
import { toolImages, toolText } from "../../shared/tool-output.ts";
import { navigate } from "../lib/router.ts";
import { useApp } from "../lib/store.ts";
import {
  held,
  landedIn,
  outcomeOf,
  placeNotes,
  steerUnread,
  type InputBlock,
  type NoticeBlock,
  type RunBlock,
  type RunNote,
  type Timeline,
  type TimelineBlock,
  stoppedByAgent,
} from "../../shared/timeline.ts";
import { SentAttachments } from "./Attachments.tsx";
import { mermaidRenderer } from "./MermaidDiagram.tsx";
import { endText, noticeText, notifiedText } from "../../shared/transcript-model.ts";

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
      // A held one waits above the composer (QueueTray) until it is sent.
      return block.delivered || held(block) ? null : <PendingInput block={block} />;
    case "notice":
      return <Notice block={block} />;
  }
});

function Run({ run, timeline, runtime }: { run: RunBlock; timeline: Timeline; runtime: string }) {
  const { started, ended, view } = run;
  const notes = placeNotes(run);
  return (
    <>
      {started?.resume !== undefined && (
        <SystemLine
          divider
        >{`Resumed${started.model === undefined ? "" : ` on ${started.model}`}`}</SystemLine>
      )}
      <Notes notes={notes.before} />
      {view.messages.map((message, index) => (
        <Fragment key={message.id}>
          {
            // The run's own end says why the process went away; oar's exit notice would repeat it.
            message.kind === "notice" &&
            message.notice.cause === "exited" &&
            ended !== undefined &&
            ended.reason !== "exited" ? null : (
              <Message
                message={message}
                timeline={timeline}
                runtime={runtime}
                open={index === view.openTurn}
                agentStopped={stoppedByAgent(run, message.id)}
              />
            )
          }
          <Notes notes={notes.after.get(message.id)} />
        </Fragment>
      ))}
      {ended !== undefined && ended.reason !== "idle" && ended.reason !== "restart" && (
        <SystemLine>{endText(ended.reason, ended.code)}</SystemLine>
      )}
    </>
  );
}

const Message = memo(function Message({
  message,
  timeline,
  runtime,
  open,
  agentStopped,
}: {
  message: ViewMessage;
  timeline: Timeline;
  runtime: string;
  open: boolean;
  /** An aborted turn the runtime stopped itself, not you. */
  agentStopped: boolean;
}) {
  switch (message.kind) {
    case "input": {
      const { input } = message;
      const origin = input.inputId === undefined ? undefined : timeline.inputs.get(input.inputId);
      // Steered and not read yet: it waits above the composer (QueueTray).
      if (steerUnread(origin, input.observations.length, runtime)) return null;
      // What you sent (your text and files), rather than the text the runtime read.
      return (
        <UserMessage
          text={origin?.input.text ?? input.input}
          attachments={origin?.input.attachments}
          by={origin?.input.by}
          at={origin?.input.at}
          landed={landedIn(origin)}
          state={input.state === "rejected" ? "error" : input.state === "pending" ? "sending" : "sent"}
          dropped={input.state === "dropped" ? droppedWords(input.reason) : null}
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
          {message.outcome?.kind === "failed" &&
            (message.outcome.failure === "auth" && message.outcome.credential !== "rejected" ? (
              <SignInAgain runtime={runtime} />
            ) : (
              <FailureHint failure={message.outcome.failure} credential={message.outcome.credential} />
            ))}
          {message.outcome?.kind === "aborted" && (
            <p className="text-sm text-muted-foreground">
              {agentStopped ? "The agent stopped the turn." : "You stopped the turn."}
            </p>
          )}
        </article>
      );
  }
});

/** What to do about a failed turn, when something helps (a limit, a model, the input's size…). */
function FailureHint({
  failure,
  credential,
}: {
  failure: FailureClass;
  credential: CredentialProblem | undefined;
}) {
  const hint = failureHint(failure, credential);
  return hint === null ? null : <p className="text-sm text-muted-foreground">{hint}</p>;
}

/** The runtime's login ran out: where and how to sign it in again, then send again. */
function SignInAgain({ runtime }: { runtime: string }) {
  const name = useApp((s) => s.state?.runtimes[runtime]?.name ?? runtime);
  const machine = useApp((s) => s.state?.host.name ?? "the server's machine");
  const canLogin = useApp((s) => s.state?.runtimes[runtime]?.canLogin === true);
  const steps = signInSteps(runtime);
  const literal = (text: string) => (
    <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">{text}</code>
  );
  if (canLogin)
    return (
      <p className="pl-6 text-sm text-muted-foreground">
        {`${name} needs you to sign in again: `}
        <a
          className="text-foreground underline underline-offset-2"
          href="/settings"
          onClick={(event) => {
            event.preventDefault();
            navigate("/settings");
          }}
        >
          sign it in from Settings
        </a>
        {", then send your message again."}
      </p>
    );
  if (steps !== null && "env" in steps)
    return (
      <p className="pl-6 text-sm text-muted-foreground">
        {`${name} signs in with an API key: on ${machine}, give rowrow's server `}
        {literal(steps.env)}
        {", restart it, then send your message again."}
      </p>
    );
  return (
    <p className="pl-6 text-sm text-muted-foreground">
      {`${name} needs you to sign in again. On ${machine}, open a terminal and `}
      {steps === null ? (
        `sign in with ${name}'s own command`
      ) : (
        <>
          {"run "}
          {literal(steps.run)}
          {steps.type !== undefined && (
            <>
              {", type "}
              {literal(steps.type)}
            </>
          )}
        </>
      )}
      {", then send your message again."}
    </p>
  );
}

function UserMessage({
  text,
  attachments,
  by,
  at,
  landed,
  state,
  dropped,
}: {
  text: string;
  attachments: readonly Attachment[] | undefined;
  by: Actor | undefined;
  at: number | undefined;
  landed: "steered" | "queued" | null;
  state: "sending" | "sent" | "error";
  /** The runtime took it but never read it, and why (oar's dropped state). */
  dropped?: string | null;
}) {
  const facts = [
    by === undefined ? null : actorLabel(by),
    at === undefined ? null : new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    landed === "steered" ? "Steered in" : landed === "queued" ? "queued for the next turn" : null,
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
      {dropped && <p className="px-1 text-xs text-warning">{dropped}</p>}
    </article>
  );
}

function PendingInput({ block }: { block: InputBlock }) {
  const outcome = outcomeOf(block);
  const failed = outcome !== undefined && (outcome.landed === "failed" || outcome.landed === "rejected");
  return (
    <>
      <UserMessage
        text={block.input.text}
        attachments={block.input.attachments}
        by={block.input.by}
        at={block.input.at}
        landed={null}
        state={failed ? "error" : "sending"}
      />
      {failed && <SystemLine>{`Not delivered: ${outcome?.reason ?? outcome?.landed ?? ""}`}</SystemLine>}
    </>
  );
}

/** Notifications the agent sent you while it ran, where it sent them. */
function Notes({ notes }: { notes: readonly RunNote[] | undefined }) {
  return notes?.map((note) => <Notified key={note.entry.seq} entry={note.entry} />);
}

function Notified({ entry }: { entry: EntryOf<"notification.sent"> }) {
  return (
    <SystemLine hint={entry.body === "" ? undefined : entry.body}>
      <Bell className="mr-1 inline size-3 align-[-2px]" aria-hidden="true" />
      {notifiedText(entry)}
    </SystemLine>
  );
}

function Notice({ block }: { block: NoticeBlock }) {
  const { entry } = block;
  switch (entry.kind) {
    case "notification.sent":
      return <Notified entry={entry} />;
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
  hint,
}: {
  children: ReactNode;
  divider?: boolean;
  tone?: "error";
  /** More of what it says, on hover. */
  hint?: string | undefined;
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
      title={hint}
      className={cn("text-center text-xs text-muted-foreground", tone === "error" && "text-destructive")}
    >
      {children}
    </p>
  );
}

const plugins = { code, cjk, renderers: [mermaidRenderer] };

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
  const lastIndex = section.parts.length - 1;
  for (const segment of groupToolActivity(runtime, section.parts)) {
    if (segment.kind === "tools") {
      out.push(
        <Activity
          key={`tools-${segment.index}`}
          group={segment}
          runtime={runtime}
          live={streaming ? lastIndex : -1}
        />,
      );
      continue;
    }
    const { part, index } = segment;
    switch (part.kind) {
      case "text":
        out.push(
          <Streamdown
            key={index}
            className="min-w-0 text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_h4]:text-sm"
            plugins={plugins}
            isAnimating={streaming && index === lastIndex}
            shikiTheme={["github-light", "tokyo-night"]}
            linkSafety={{ enabled: false }}
            codeBlockMaxHeight={480}
          >
            {part.text}
          </Streamdown>,
        );
        break;
      case "tool":
      case "reasoning":
        // groupToolActivity puts these in a "tools" segment.
        break;
      case "notice":
        out.push(<SystemLine key={index}>{noticeText(part.notice)}</SystemLine>);
        break;
      case "app_request":
        // A client call the adapter answered itself (grok's terminal/*): not the person's business.
        if (appRequestKind(part.type) === "service") break;
        out.push(
          <div key={index} className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            {part.answered
              ? `The agent asked (${part.type}); rowrow answered.`
              : `The agent is asking for something rowrow can't answer yet (${part.type}).`}
          </div>,
        );
        break;
    }
  }
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

/**
 * A run of tool calls and the reasoning between them. Two or more calls fold into one line
 * ("Ran 3 commands, read a file · 1 failed"); one call shows as it is, since its own row says more.
 * `live` is the index of the part still streaming, or -1.
 */
function Activity({ group, runtime, live }: { group: ActivityGroup; runtime: string; live: number }) {
  const out: ReactNode[] = [];
  let tools: ToolPart[] = [];
  const flushTools = (): void => {
    const first = tools[0];
    if (first === undefined) return;
    out.push(<ToolGroup key={first.callId} parts={tools} runtime={runtime} />);
    tools = [];
  };
  group.parts.forEach((part, offset) => {
    if (part.kind === "tool") {
      tools.push(part);
      return;
    }
    flushTools();
    out.push(<Reasoning key={group.index + offset} part={part} live={group.index + offset === live} />);
  });
  flushTools();
  const calls = group.parts.filter((part) => part.kind === "tool").length;
  if (calls < 2) return <>{out}</>;
  const running = group.running ? classifyTool(runtime, group.running.tool, group.running.input) : null;
  return (
    <Collapsible className="group/activity min-w-0">
      <CollapsibleTrigger className="flex max-w-full min-w-0 items-center gap-1 rounded text-left text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/activity:rotate-90" />
        <span className="shrink-0">{toolGroupSummary(group.counts)}</span>
        {group.failed > 0 && <span className="shrink-0 text-destructive">· {group.failed} failed</span>}
        {running && (
          <span className="flex min-w-0 items-center gap-1">
            <span className="shrink-0">·</span>
            <LoaderCircle className="size-3 shrink-0 animate-spin" aria-label="Running" />
            <span className="shrink-0">{toolActionLabel(running.kind, "running")}</span>
            {running.detail && <span className="truncate font-mono">{running.detail}</span>}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-2">{out}</CollapsibleContent>
    </Collapsible>
  );
}

function Reasoning({ part, live }: { part: ReasoningPart; live: boolean }) {
  return part.content.kind === "text" ? (
    <Disclosure label={live ? "Thinking…" : "Thought"}>
      <p className="border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {part.content.text}
      </p>
    </Disclosure>
  ) : (
    <p className="text-xs text-muted-foreground">{live ? "Thinking…" : "Thought (hidden)"}</p>
  );
}

function ToolGroup({ parts, runtime }: { parts: ToolPart[]; runtime: string }) {
  return (
    <div className="divide-y overflow-hidden rounded-lg border bg-card/60">
      {parts.map((part) => (
        <ToolCall key={part.callId} part={part} runtime={runtime} />
      ))}
    </div>
  );
}

function ToolCall({ part, runtime }: { part: ToolPart; runtime: string }) {
  const action = classifyTool(runtime, part.tool, part.input);
  const output = toolText(part) ?? "";
  const images = toolImages(part);
  // How long it took, once it's done; a blink isn't worth saying.
  const took =
    part.startedAt !== undefined && part.endedAt !== undefined && part.endedAt - part.startedAt >= 1000
      ? duration(part.endedAt - part.startedAt)
      : null;
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
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground"
          title={(action.paths?.length ?? 0) > 1 ? action.paths?.join("\n") : undefined}
        >
          {action.detail}
          {/* One call can touch several files (Codex's file changes): the rest are in the tooltip. */}
          {(action.paths?.length ?? 0) > 1 && ` +${(action.paths?.length ?? 0) - 1} more`}
        </span>
      )}
      {took !== null && (
        <span
          className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums"
          title="How long it took"
        >
          {took}
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
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90",
              took === null ? "ml-auto" : "ml-0.5",
            )}
          />
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
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2.5 pb-2 pl-8">
          {images.map((image, index) => (
            <img
              key={index}
              src={`data:${image.mediaType};base64,${image.data}`}
              alt={`What ${part.tool} returned (image ${index + 1})`}
              className="max-h-64 max-w-full rounded-md border object-contain"
            />
          ))}
        </div>
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
