// The transcript: the timeline fold (src/shared/timeline.ts) rendered as a conversation.
// Every block and message is memoized on identity, and the fold shares structure, so while
// text streams only the open turn re-renders. Messages carry data-author ("you" or
// "agent"): selection comments quote only what the agent wrote (SelectionComment), and the
// wave bar marks each one (ConversationWave), previewing what they mark data-preview. What
// transcript search finds (D-055) carries data-item, the kit's item id (transcript-model.ts):
// your messages, the agent's texts and its tool calls; a search jumping to one opens what
// folds it away (RevealContext). Coach's chats (D-044) read the same fold: an answer's text,
// with the tools it called folded into one "Work performed" group under it. In an agent's
// transcript, paths that name files of its workspace open them in the inspector (FileLinks.tsx,
// D-054).
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
  type ViewTurn,
} from "@botiverse/oar/observe";
import type { CredentialProblem, FailureClass } from "@botiverse/oar";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { Bell, Check, ChevronRight, CircleAlert, CircleX, ExternalLink, LoaderCircle } from "lucide-react";
import { createContext, Fragment, memo, useContext, useMemo, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { coachToolLabel } from "../../shared/coach.ts";
import { mentionSegments, type CoachMention } from "../../shared/coach-mentions.ts";
import type { Actor, Attachment, EntryOf } from "../../shared/entries.ts";
import type { AppState } from "../../shared/schemas.ts";
import { actorLabel } from "../../shared/render-text.ts";
import { droppedWords, duration, failureHint } from "../../shared/describe.ts";
import { toolFileTarget } from "../../shared/file-refs.ts";
import { signInSteps } from "../../shared/sign-in.ts";
import { toolImages, toolText } from "../../shared/tool-output.ts";
import { closeCoach } from "../lib/coach.ts";
import { navigate } from "../lib/router.ts";
import { useApp } from "../lib/store.ts";
import {
  foldHiddenThoughts,
  held,
  landedIn,
  laneOf,
  outcomeOf,
  placeNotes,
  placeProposals,
  steerUnread,
  switches,
  type InputBlock,
  type NoticeBlock,
  type RunBlock,
  type RunNote,
  type Timeline,
  type TimelineBlock,
  stoppedByAgent,
} from "../../shared/timeline.ts";
import { SentAttachments } from "./Attachments.tsx";
import { CoachActionCard } from "./CoachActionCard.tsx";
import { MentionLink } from "./CoachMentions.tsx";
import { FileLink, InlineCode, LinkedText, useFileLinks } from "./FileLinks.tsx";
import { mermaidRenderer } from "./MermaidDiagram.tsx";
import { endText, noticeText, notifiedText } from "../../shared/transcript-model.ts";

/** The item a transcript search jumped to (D-055), a new object each jump: what holds it opens. */
export const RevealContext = createContext<{ readonly id: string } | null>(null);

/** Open when a search jumps to something inside (`holds` says what); otherwise yours to open and close. */
function useRevealed(holds: (id: string) => boolean, initial = false): [boolean, (open: boolean) => void] {
  const reveal = useContext(RevealContext);
  // Mounted by the jump itself (the turns it loaded): open from the start.
  const [open, setOpen] = useState(() => initial || (reveal !== null && holds(reveal.id)));
  const [seen, setSeen] = useState(reveal);
  if (seen !== reveal) {
    setSeen(reveal);
    if (reveal !== null && holds(reveal.id)) setOpen(true);
  }
  return [open, setOpen];
}

export function Transcript({
  timeline,
  runtime,
  coach = false,
}: {
  timeline: Timeline;
  runtime: string;
  /** A Coach chat: answers with their tool calls folded under them. */
  coach?: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      {timeline.blocks.map((block) => (
        <Block key={keyOf(block)} block={block} timeline={timeline} runtime={runtime} coach={coach} />
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
  coach,
}: {
  block: TimelineBlock;
  timeline: Timeline;
  runtime: string;
  coach: boolean;
}) {
  switch (block.kind) {
    case "run":
      return <Run run={block} timeline={timeline} runtime={runtime} coach={coach} />;
    case "input":
      // A held one waits above the composer (QueueTray) until it is sent.
      return block.delivered || held(block) ? null : coach ? (
        <PendingCoachInput block={block} />
      ) : (
        <PendingInput block={block} />
      );
    case "notice":
      return <Notice block={block} />;
  }
});

function Run({
  run,
  timeline,
  runtime,
  coach,
}: {
  run: RunBlock;
  timeline: Timeline;
  runtime: string;
  coach: boolean;
}) {
  const { started, ended, view } = run;
  const notes = placeNotes(run);
  // Coach's actions, each after the answer that proposed it (D-045).
  const proposals = coach ? placeProposals(run) : null;
  return (
    <>
      {started?.resume !== undefined && (
        <SystemLine
          divider
        >{`Resumed${started.model === undefined ? "" : ` on ${started.model}`}`}</SystemLine>
      )}
      <Notes notes={notes.before} />
      <ActionCards ids={proposals?.get(null)} timeline={timeline} />
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
                itemId={`${run.runId}:${message.id}`}
                timeline={timeline}
                runtime={runtime}
                open={index === view.openTurn}
                rootSessionId={view.rootSessionId}
                agentStopped={stoppedByAgent(run, message.id)}
                coach={coach}
              />
            )
          }
          <Notes notes={notes.after.get(message.id)} />
          <ActionCards ids={proposals?.get(message.id)} timeline={timeline} />
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
  itemId,
  timeline,
  runtime,
  open,
  rootSessionId,
  agentStopped,
  coach,
}: {
  message: ViewMessage;
  /** Its id among the kit's items: `<runId>:<message id>`. */
  itemId: string;
  timeline: Timeline;
  runtime: string;
  open: boolean;
  /** The run's own session: a section from another one is a sub-agent's (laneOf). */
  rootSessionId: string | undefined;
  /** An aborted turn the runtime stopped itself, not you. */
  agentStopped: boolean;
  coach: boolean;
}) {
  switch (message.kind) {
    case "input": {
      const { input } = message;
      const origin = input.inputId === undefined ? undefined : timeline.inputs.get(input.inputId);
      // Steered and not read yet: it waits above the composer (QueueTray).
      if (steerUnread(origin, input.observations.length, runtime)) return null;
      // What you sent (your text and files), rather than the text the runtime read.
      if (coach)
        return (
          <CoachYou
            text={origin?.input.text ?? input.input}
            mentions={origin?.input.mentions}
            at={origin?.input.at}
            task={origin?.input.by.kind === "system"}
            state={
              input.state === "rejected" || input.state === "dropped"
                ? "error"
                : input.state === "pending"
                  ? "sending"
                  : "sent"
            }
          />
        );
      return (
        <UserMessage
          itemId={itemId}
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
      if (coach) return <CoachAnswer turn={message} runtime={runtime} open={open} />;
      return (
        <article data-author="agent" aria-label="The agent's turn" className="flex min-w-0 flex-col gap-3">
          {message.sections.map((section, index) => (
            <Section
              key={index}
              itemId={`${itemId}:${index}`}
              section={section}
              lane={laneOf(section, rootSessionId)}
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

// ─── Coach (D-044) ──────────────────────────────────────────────────────────
// Coach's chat reads like roamgate's Ranger: each message under a "You" or "Coach" line, your
// text in a tinted block, its answer flat, and the tools it called folded under the answer.

const when = (at: number): string => {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

function CoachHead({ who, at }: { who: "You" | "Task prompt" | "Coach"; at?: number | undefined }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <strong className="text-[11px] font-semibold">{who}</strong>
      {at !== undefined && <time className="text-[10px] text-muted-foreground">{when(at)}</time>}
    </div>
  );
}

/**
 * What you asked Coach: a scheduled task's run (D-050) asks with the task's prompt, rowrow sending
 * it. The workspaces and agents you referenced with @ are links to them.
 */
function CoachYou({
  text,
  mentions,
  at,
  state,
  reason,
  task = false,
}: {
  text: string;
  mentions?: readonly CoachMention[] | undefined;
  at: number | undefined;
  state: "sending" | "sent" | "error";
  reason?: string | null | undefined;
  task?: boolean;
}) {
  const who = task ? "Task prompt" : "You";
  return (
    <section data-author="you" aria-label={`${who} message`} className="grid min-w-0 gap-[7px]">
      <CoachHead who={who} at={at} />
      <p
        data-preview
        className="rounded-lg bg-primary/12 px-2.5 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] md:text-xs"
      >
        {mentionSegments(text, mentions).map((segment, index) =>
          segment.mention === undefined ? (
            <Fragment key={index}>{segment.text}</Fragment>
          ) : (
            <MentionLink key={index} mention={segment.mention} text={segment.text} />
          ),
        )}
      </p>
      {state === "sending" && <span className="text-[11px] text-muted-foreground">Sending…</span>}
      {state === "error" && (
        <span className="text-[11px] text-destructive">{`Not sent${reason ? `: ${reason}` : ""}`}</span>
      )}
    </section>
  );
}

/** Coach's answer: what it wrote, then "Work performed (N)": its tool calls and what they read. */
function CoachAnswer({ turn, runtime, open }: { turn: ViewTurn; runtime: string; open: boolean }) {
  const parts = turn.sections.flatMap((section) => section.parts);
  const tools = parts.filter((part): part is ToolPart => part.kind === "tool");
  const said = parts.filter((part) => part.kind === "text" && part.text.trim() !== "");
  const lastIndex = parts.length - 1;
  return (
    <section data-author="agent" aria-label="Coach message" className="grid min-w-0 gap-[7px]">
      <CoachHead who="Coach" />
      <div data-preview className="flex min-w-0 flex-col gap-2 empty:hidden">
        {parts.map((part, index) =>
          part.kind === "text" ? (
            <Streamdown
              key={index}
              className="min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere] md:text-xs [&_code]:text-[0.92em] [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold"
              plugins={plugins}
              isAnimating={open && index === lastIndex}
              shikiTheme={["github-light", "tokyo-night"]}
              linkSafety={{ enabled: false }}
              codeBlockMaxHeight={360}
            >
              {part.text}
            </Streamdown>
          ) : part.kind === "notice" ? (
            <SystemLine key={index}>{noticeText(part.notice)}</SystemLine>
          ) : null,
        )}
      </div>
      {said.length === 0 &&
        (open ? (
          <span className="text-[11px] text-muted-foreground">Working...</span>
        ) : turn.outcome?.kind === "completed" ? (
          <span className="text-[11px] text-muted-foreground">No response text was received.</span>
        ) : null)}
      {turn.outcome?.kind === "failed" && (
        <>
          <p className="flex items-start gap-2 text-xs text-destructive">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            {`Failed: ${turn.outcome.reason}`}
          </p>
          {turn.outcome.failure === "auth" && turn.outcome.credential !== "rejected" ? (
            <SignInAgain runtime={runtime} />
          ) : (
            <FailureHint failure={turn.outcome.failure} credential={turn.outcome.credential} />
          )}
        </>
      )}
      {turn.outcome?.kind === "aborted" && (
        <span className="text-[11px] text-muted-foreground">You stopped it.</span>
      )}
      {tools.length > 0 && <WorkPerformed tools={tools} working={open} />}
    </section>
  );
}

/** Coach's actions proposed at one point of a run, as their cards. */
function ActionCards({ ids, timeline }: { ids: readonly string[] | undefined; timeline: Timeline }) {
  if (ids === undefined) return null;
  return ids.map((id) => {
    const action = timeline.coachActions.get(id);
    return action === undefined ? null : <CoachActionCard key={id} action={action} />;
  });
}

/** Where a read came from, to open it: a workspace or an agent, with when it was read. */
interface Source {
  readonly key: string;
  readonly title: string;
  readonly kind: string;
  readonly readAt: string | null;
  readonly href: string;
}

function sourcesOf(tools: readonly ToolPart[], state: AppState | null): Source[] {
  return tools.flatMap((part) => {
    if (part.result !== "ok") return [];
    const args = parse(part.input);
    const result = parse(toolText(part));
    const kind = coachToolLabel(part.tool);
    const readAt = typeof result?.["readAt"] === "string" ? result["readAt"] : null;
    const agentId = args?.["agentId"];
    if (typeof agentId === "string") {
      const title = state?.agents[agentId]?.summary.title ?? agentId;
      return [{ key: `${part.callId}:${agentId}`, title, kind, readAt, href: `/a/${agentId}` }];
    }
    const workspaces = Array.isArray(result?.["workspaces"]) ? (result["workspaces"] as unknown[]) : [];
    return workspaces.flatMap((ws) => {
      const id =
        typeof ws === "object" && ws !== null ? (ws as Record<string, unknown>)["workspaceId"] : null;
      if (typeof id !== "string") return [];
      const label = state?.workspaces[id]?.label ?? id;
      return [{ key: `${part.callId}:${id}`, title: label, kind, readAt, href: `/w/${id}` }];
    });
  });
}

function WorkPerformed({ tools, working }: { tools: ToolPart[]; working: boolean }) {
  const state = useApp((s) => s.state);
  // Open while Coach works, folded when it answers; in between, yours to open or close.
  const [open, setOpen] = useState(working);
  const [wasWorking, setWasWorking] = useState(working);
  if (wasWorking !== working) {
    setWasWorking(working);
    setOpen(working);
  }
  const sources = sourcesOf(tools, state);
  const reading = working && tools.some((tool) => tool.result === "running");
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/work min-w-0 text-[10px] text-muted-foreground"
    >
      <CollapsibleTrigger className="flex items-center gap-1 rounded hover:text-foreground">
        <span aria-hidden className="text-[8px]">
          {open ? "▼" : "▶"}
        </span>
        {`${reading ? "Reading workspace context" : "Work performed"} (${tools.length + sources.length})`}
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-[5px] pt-2">
        {tools.map((part) => (
          <CoachToolCard key={part.callId} part={part} />
        ))}
        {sources.length > 0 && (
          <div aria-label="Sources" className="grid gap-[5px]">
            {sources.map((source) => (
              <button
                key={source.key}
                type="button"
                onClick={() => {
                  // On a phone, Coach covers the page: show what it read.
                  if (matchMedia("(max-width: 767px)").matches) closeCoach();
                  navigate(source.href);
                }}
                className="grid min-w-0 gap-0.5 rounded-lg border bg-card px-2 py-1.5 text-left text-[10px] text-foreground hover:bg-accent"
              >
                <span className="flex min-w-0 items-center gap-1">
                  <ExternalLink className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{source.title}</span>
                </span>
                <small className="text-[9px] text-muted-foreground">
                  {`${source.kind}${source.readAt === null ? "" : ` · Read ${when(Date.parse(source.readAt))}`}`}
                </small>
              </button>
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One tool call: its name and state, then its arguments and its result, as roamgate shows them. */
function CoachToolCard({ part }: { part: ToolPart }) {
  const output = toolText(part);
  const parsed = parse(part.input);
  const args = parsed === null ? part.input : JSON.stringify(parsed, null, 2);
  const status = part.result === "running" ? "running" : part.result === "failed" ? "failed" : "completed";
  const pre =
    "max-h-60 overflow-auto font-mono text-[11px] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]";
  return (
    <Collapsible className="group/tool min-w-0 rounded-lg border bg-card px-2 py-1.5 text-[10px] text-foreground">
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
        <span aria-hidden className="text-[8px] text-muted-foreground">
          <span className="group-data-[state=open]/tool:hidden">▶</span>
          <span className="hidden group-data-[state=open]/tool:inline">▼</span>
        </span>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{coachToolLabel(part.tool)}</span>
        <span
          className={cn(
            "shrink-0",
            status === "running"
              ? "text-primary"
              : status === "failed"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          {status}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-1.5 pt-2">
        {args !== undefined && (
          <>
            <strong className="font-semibold">Arguments</strong>
            <pre tabIndex={0} className={pre}>
              {args}
            </pre>
          </>
        )}
        {output !== undefined && output !== "" && (
          <>
            <strong className="font-semibold">{part.result === "failed" ? "Error" : "Result"}</strong>
            <pre tabIndex={0} className={pre}>
              {output}
            </pre>
          </>
        )}
        {args === undefined && (output === undefined || output === "") ? (
          <p className="text-muted-foreground">Call details are unavailable.</p>
        ) : output === undefined || output === "" ? (
          <p className="text-muted-foreground">
            {part.result === "running" ? "Result pending." : "Result unavailable."}
          </p>
        ) : args === undefined ? (
          <p className="text-muted-foreground">Arguments unavailable.</p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

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
  itemId,
  text,
  attachments,
  by,
  at,
  landed,
  state,
  dropped,
}: {
  itemId: string;
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
    <article
      data-author="you"
      data-item={itemId}
      aria-label="Your message"
      className="flex flex-col items-end gap-1 pl-10"
    >
      {attachments !== undefined && attachments.length > 0 && <SentAttachments attachments={attachments} />}
      {text.trim() !== "" && (
        <div
          data-preview
          className="max-w-full rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-secondary-foreground"
        >
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

function PendingCoachInput({ block }: { block: InputBlock }) {
  const outcome = outcomeOf(block);
  const failed = outcome !== undefined && (outcome.landed === "failed" || outcome.landed === "rejected");
  return (
    <CoachYou
      text={block.input.text}
      mentions={block.input.mentions}
      at={block.input.at}
      task={block.input.by.kind === "system"}
      state={failed ? "error" : "sending"}
      reason={failed ? (outcome?.reason ?? outcome?.landed) : null}
    />
  );
}

function PendingInput({ block }: { block: InputBlock }) {
  const outcome = outcomeOf(block);
  const failed = outcome !== undefined && (outcome.landed === "failed" || outcome.landed === "rejected");
  return (
    <>
      <UserMessage
        itemId={`pending:${block.input.inputId}`}
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
    case "agent.updated":
      return <SystemLine divider>{`Switched ${switches(entry.changes) ?? ""}`}</SystemLine>;
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
// Inline code that names a file of the checkout opens it (FileLinks.tsx).
const components = { inlineCode: InlineCode };

/** One lane (the agent, or a sub-agent) inside a turn: text, reasoning, tool calls in order. */
function Section({
  itemId,
  section,
  lane,
  runtime,
  streaming,
}: {
  /** Its parts' ids start with this: `<runId>:<message id>:<section index>`. */
  itemId: string;
  section: ViewSection;
  /** The sub-agent it came from, outermost first; empty for the agent itself. */
  lane: readonly string[];
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
          itemId={itemId}
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
        // What the wave bar's preview quotes (ConversationWave).
        out.push(
          <div key={index} data-preview data-item={`${itemId}:${index}`} className="contents">
            <Streamdown
              className="min-w-0 text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_h4]:text-sm"
              plugins={plugins}
              components={components}
              isAnimating={streaming && index === lastIndex}
              shikiTheme={["github-light", "tokyo-night"]}
              linkSafety={{ enabled: false }}
              codeBlockMaxHeight={480}
            >
              {part.text}
            </Streamdown>
          </div>,
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
              : part.cancelled === true
                ? `The agent asked (${part.type}), then took it back.`
                : `The agent is asking for something rowrow can't answer yet (${part.type}).`}
          </div>,
        );
        break;
    }
  }
  return lane.length === 0 ? (
    <>{out}</>
  ) : (
    <Disclosure
      label={`Sub-agent ${lane.join(" / ")}`}
      defaultOpen={streaming}
      holds={(id) => id.startsWith(`${itemId}:`)}
    >
      <div className="flex flex-col gap-3 border-l-2 pl-3">{out}</div>
    </Disclosure>
  );
}

function Disclosure({
  label,
  defaultOpen = false,
  holds = () => false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  /** Whether an item a search jumps to is inside. */
  holds?: (id: string) => boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useRevealed(holds, defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/disclosure">
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
function Activity({
  itemId,
  group,
  runtime,
  live,
}: {
  /** The section's: a tool call's id is this and its index in the section. */
  itemId: string;
  group: ActivityGroup;
  runtime: string;
  live: number;
}) {
  const out: ReactNode[] = [];
  let tools: { readonly part: ToolPart; readonly id: string }[] = [];
  const ids: string[] = [];
  const flushTools = (): void => {
    const first = tools[0];
    if (first === undefined) return;
    out.push(<ToolGroup key={first.part.callId} calls={tools} runtime={runtime} />);
    tools = [];
  };
  for (const { part, index: offset, count } of foldHiddenThoughts(group.parts)) {
    const index = group.index + offset;
    if (part.kind === "tool") {
      const id = `${itemId}:${index}`;
      tools.push({ part, id });
      ids.push(id);
      continue;
    }
    flushTools();
    out.push(<Reasoning key={index} part={part} count={count} live={index + count - 1 === live} />);
  }
  flushTools();
  const calls = group.parts.filter((part) => part.kind === "tool").length;
  if (calls < 2) return <>{out}</>;
  return (
    <FoldedCalls group={group} runtime={runtime} holds={(id) => ids.includes(id)}>
      {out}
    </FoldedCalls>
  );
}

/** Two or more calls, folded into one line. */
function FoldedCalls({
  group,
  runtime,
  holds,
  children,
}: {
  group: ActivityGroup;
  runtime: string;
  holds: (id: string) => boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useRevealed(holds);
  const running = group.running ? classifyTool(runtime, group.running.tool, group.running.input) : null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/activity min-w-0">
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
      <CollapsibleContent className="flex flex-col gap-3 pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** A thought, or `count` hidden ones back to back (foldHiddenThoughts). */
function Reasoning({ part, count, live }: { part: ReasoningPart; count: number; live: boolean }) {
  return part.content.kind === "text" ? (
    <Disclosure label={live ? "Thinking…" : "Thought"}>
      <p className="border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {part.content.text}
      </p>
    </Disclosure>
  ) : (
    <p className="text-xs text-muted-foreground">
      {live ? "Thinking…" : count > 1 ? `Thought (hidden) ×${count}` : "Thought (hidden)"}
    </p>
  );
}

function ToolGroup({
  calls,
  runtime,
}: {
  calls: readonly { readonly part: ToolPart; readonly id: string }[];
  runtime: string;
}) {
  return (
    <div className="divide-y overflow-hidden rounded-lg border bg-card/60">
      {calls.map(({ part, id }) => (
        <ToolCall key={part.callId} itemId={id} part={part} runtime={runtime} />
      ))}
    </div>
  );
}

function ToolCall({ itemId, part, runtime }: { itemId: string; part: ToolPart; runtime: string }) {
  const links = useFileLinks();
  const [open, setOpen] = useRevealed((id) => id === itemId);
  const action = classifyTool(runtime, part.tool, part.input);
  const output = toolText(part) ?? "";
  const images = toolImages(part);
  // How long it took, once it's done; a blink isn't worth saying.
  const took =
    part.startedAt !== undefined && part.endedAt !== undefined && part.endedAt - part.startedAt >= 1000
      ? duration(part.endedAt - part.startedAt)
      : null;
  const detail = toolDetail(action.kind, part.input, output);
  // The file it read or edited, when the checkout has it, opens in the inspector (FileLinks.tsx).
  const target = useMemo(
    () => (links === null ? null : toolFileTarget(runtime, part.tool, part.input, links.files)),
    [links, runtime, part.tool, part.input],
  );
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
          {target === null ? (
            action.detail
          ) : (
            <FileLink target={target} className="pointer-events-auto max-w-full truncate align-bottom">
              {action.detail}
            </FileLink>
          )}
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
  const chevron = (
    <ChevronRight
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90",
        took === null ? "ml-auto" : "ml-0.5",
      )}
    />
  );
  // Only what may name files: a search's hits, a command's line and output.
  const linked = action.kind === "search" || action.kind === "run_command";
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-item={itemId} className="group/tool">
      {detail === null ? (
        <div className="flex min-h-8 items-center gap-2 px-2.5 py-1.5">{row}</div>
      ) : target === null ? (
        <CollapsibleTrigger className="flex min-h-8 w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/50">
          {row}
          {chevron}
        </CollapsibleTrigger>
      ) : (
        // The path is a link of its own (a button can't hold one): the row's toggle lies under it.
        <div className="relative flex min-h-8 items-center px-2.5 py-1.5">
          <CollapsibleTrigger
            aria-label={`${part.tool} ${action.detail ?? ""}`}
            className="absolute inset-0 hover:bg-accent/50"
          />
          <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2">
            {row}
            {chevron}
          </div>
        </div>
      )}
      {part.result === "failed" && output !== "" && (
        <p className="px-2.5 pb-1.5 pl-8 text-xs break-words text-destructive">{output.slice(0, 300)}</p>
      )}
      {detail !== null && (
        <CollapsibleContent>
          <pre className="max-h-80 overflow-auto border-t bg-code px-3 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
            {linked ? <LinkedText text={detail.slice(0, 20_000)} /> : detail.slice(0, 20_000)}
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
