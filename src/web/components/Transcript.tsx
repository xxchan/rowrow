// The transcript: the timeline fold (src/shared/timeline.ts) rendered with Astryx's chat
// components. Every block and message is memoized on identity, and the fold shares
// structure, so while text streams only the open turn re-renders.
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import type { ChatToolCallItem } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import {
  classifyTool,
  type ViewMessage,
  type ViewNotice,
  type ViewPart,
  type ViewSection,
} from "@botiverse/oar/observe";
import { memo, type ReactNode } from "react";
import type { Actor } from "../../shared/entries.ts";
import { actorLabel } from "../../shared/render-text.ts";
import type { InputBlock, NoticeBlock, RunBlock, Timeline, TimelineBlock } from "../../shared/timeline.ts";
import { ErrorText } from "./ErrorText.tsx";

export function Transcript({ timeline, runtime }: { timeline: Timeline; runtime: string }) {
  return (
    <>
      {timeline.blocks.map((block) => (
        <Block key={keyOf(block)} block={block} timeline={timeline} runtime={runtime} />
      ))}
    </>
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
        <ChatSystemMessage variant="divider">{`Resumed${started.model === undefined ? "" : ` on ${started.model}`}`}</ChatSystemMessage>
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
        <ChatSystemMessage>{endText(ended.reason, ended.code)}</ChatSystemMessage>
      )}
    </>
  );
}

function endText(reason: string, code: number | null | undefined): string {
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
      return `The agent process exited${code === null || code === undefined ? "" : ` (code ${code})`}.`;
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
      return (
        <UserMessage
          text={input.input}
          by={origin?.input.by}
          at={origin?.input.at}
          landed={origin?.result?.landed}
          state={input.state === "rejected" ? "error" : input.state === "pending" ? "sending" : "sent"}
        />
      );
    }
    case "notice":
      return <ChatSystemMessage>{noticeText(message.notice)}</ChatSystemMessage>;
    case "turn":
      return (
        <ChatMessage sender="assistant">
          {message.sections.map((section, index) => (
            <Section
              key={index}
              section={section}
              runtime={runtime}
              streaming={open && index === message.sections.length - 1}
            />
          ))}
          {message.outcome?.kind === "failed" && (
            <ChatMessageBubble variant="ghost">
              <ErrorText type="body">{`Failed: ${message.outcome.reason}`}</ErrorText>
            </ChatMessageBubble>
          )}
          {message.outcome?.kind === "aborted" && (
            <ChatMessageBubble variant="ghost">
              <Text type="supporting">Stopped.</Text>
            </ChatMessageBubble>
          )}
        </ChatMessage>
      );
  }
});

function UserMessage({
  text,
  by,
  at,
  landed,
  state,
}: {
  text: string;
  by: Actor | undefined;
  at: number | undefined;
  landed: string | undefined;
  state: "sending" | "sent" | "error";
}) {
  const footer = [
    by === undefined ? null : actorLabel(by),
    landed === "steered"
      ? "steered into the running turn"
      : landed === "queued"
        ? "queued for the next turn"
        : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <ChatMessage sender="user">
      <ChatMessageBubble
        metadata={
          <ChatMessageMetadata
            timestamp={
              at === undefined ? undefined : <Timestamp value={new Date(at).toISOString()} format="time" />
            }
            footer={footer === "" ? undefined : footer}
            status={state}
          />
        }
      >
        <span style={{ whiteSpace: "pre-wrap" }}>{text}</span>
      </ChatMessageBubble>
    </ChatMessage>
  );
}

function PendingInput({ block }: { block: InputBlock }) {
  const failed =
    block.result !== undefined && (block.result.landed === "failed" || block.result.landed === "rejected");
  return (
    <>
      <UserMessage
        text={block.input.text}
        by={block.input.by}
        at={block.input.at}
        landed={undefined}
        state={failed ? "error" : "sending"}
      />
      {failed && (
        <ChatSystemMessage>{`Not delivered: ${block.result?.reason ?? block.result?.landed ?? ""}`}</ChatSystemMessage>
      )}
    </>
  );
}

function Notice({ block }: { block: NoticeBlock }) {
  const { entry } = block;
  switch (entry.kind) {
    case "run.failed":
      return <ChatSystemMessage>{`Couldn't start the agent: ${entry.error}`}</ChatSystemMessage>;
    case "host.error":
      return <ChatSystemMessage>{entry.message}</ChatSystemMessage>;
    case "agent.updated": {
      const parts = [
        entry.changes.model === undefined ? null : `model: ${entry.changes.model ?? "default"}`,
        entry.changes.effort === undefined ? null : `effort: ${entry.changes.effort ?? "default"}`,
      ].filter((p) => p !== null);
      return <ChatSystemMessage variant="divider">{`Switched ${parts.join(", ")}`}</ChatSystemMessage>;
    }
  }
}

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
          <ChatMessageBubble key={index} variant="ghost">
            <Markdown density="compact" isStreaming={streaming && last} contentWidth="100%">
              {part.text}
            </Markdown>
          </ChatMessageBubble>,
        );
        break;
      case "reasoning":
        out.push(
          <ChatMessageBubble key={index} variant="ghost">
            {part.content.kind === "text" ? (
              <Collapsible
                trigger={<Text type="supporting">{streaming && last ? "Thinking…" : "Thought"}</Text>}
                defaultIsOpen={false}
              >
                <Text type="supporting">
                  <span style={{ whiteSpace: "pre-wrap" }}>{part.content.text}</span>
                </Text>
              </Collapsible>
            ) : (
              <Text type="supporting">{streaming && last ? "Thinking…" : "Thought (hidden)"}</Text>
            )}
          </ChatMessageBubble>,
        );
        break;
      case "notice":
        out.push(<ChatSystemMessage key={index}>{noticeText(part.notice)}</ChatSystemMessage>);
        break;
      case "app_request":
        out.push(
          <ChatMessageBubble key={index} variant="filled">
            <Text type="body">
              {part.answered
                ? `The agent asked (${part.type}); rowrow answered.`
                : `The agent is asking for something rowrow can't answer yet (${part.type}).`}
            </Text>
          </ChatMessageBubble>,
        );
        break;
    }
  });
  flushTools();
  const lane = section.agentPath.length === 0 ? null : section.agentPath.join(" / ");
  return lane === null ? (
    <>{out}</>
  ) : (
    <ChatMessageBubble variant="ghost">
      <Collapsible trigger={<Text type="label">{`Sub-agent ${lane}`}</Text>} defaultIsOpen={streaming}>
        {out}
      </Collapsible>
    </ChatMessageBubble>
  );
}

function ToolGroup({ parts, runtime }: { parts: ViewPart[]; runtime: string }) {
  const calls: ChatToolCallItem[] = parts.flatMap((part) => {
    if (part.kind !== "tool") return [];
    const action = classifyTool(runtime, part.tool, part.input);
    const output = part.output ?? "";
    const detail = [
      part.input === undefined ? null : `$ ${pretty(part.input)}`,
      output === "" ? null : output,
    ]
      .filter((p) => p !== null)
      .join("\n\n");
    return [
      {
        key: part.callId,
        name: part.tool,
        status: part.result === "running" ? "running" : part.result === "failed" ? "error" : "complete",
        ...(action.detail === undefined ? {} : { target: action.detail }),
        ...(part.result === "failed" ? { errorMessage: output.slice(0, 300) } : {}),
        ...(detail === ""
          ? {}
          : {
              resultDetail: (
                <CodeBlock
                  code={detail.slice(0, 20_000)}
                  language="bash"
                  width="100%"
                  maxHeight={320}
                  isWrapped
                />
              ),
            }),
      },
    ];
  });
  return <ChatToolCalls calls={calls} />;
}

/** Tool input is JSON from most runtimes; show it readable. */
function pretty(input: string): string {
  try {
    const value: unknown = JSON.parse(input);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const command = record["command"] ?? record["cmd"];
      if (typeof command === "string") return command;
      if (Array.isArray(command)) return command.join(" ");
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  } catch {
    return input;
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
