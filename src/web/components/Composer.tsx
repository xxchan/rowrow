// Writing to an agent. Enter sends; while the agent works, a message steers the running
// turn (or waits for the next one, when the runtime can't steer), "Queue" holds it for the
// next turn, and Stop interrupts. A send that may not have arrived keeps its id, so trying
// again can't deliver it twice (PRINCIPLES.md, engineering 2). On touch screens Enter is a
// newline, since IME and dictation users need it.
import { Button } from "@astryxdesign/core/Button";
import { ChatComposer, ChatComposerInput, type ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { Paperclip } from "lucide-react";
import { Text } from "@astryxdesign/core/Text";
import { useRef, useState } from "react";
import { newInputId } from "../../shared/ids.ts";
import type { AgentState, SendResult } from "../../shared/schemas.ts";
import type { InputMode } from "../../shared/entries.ts";
import { setDraft, useClient, useDrafts } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { ReviewDrawer } from "./ReviewDrawer.tsx";

const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function Composer({ agent }: { agent: AgentState }) {
  const workspaceId = agent.summary.workspaceId;
  const client = useClient();
  const draft = useDrafts((s) => s.byAgent[agent.id] ?? "");
  const pendingId = useRef<{ text: string; inputId: string } | null>(null);
  const inputRef = useRef<ChatComposerInputHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ type: "error" | "warning"; message: string } | null>(null);
  const working = agent.attention === "working";
  const archived = agent.summary.archived;

  const send = async (text: string, mode: InputMode): Promise<void> => {
    const trimmed = text.trim();
    if (client === null || trimmed === "") return;
    // Reuse the id of an attempt that may have reached the server (same text, not confirmed).
    const inputId = pendingId.current?.text === trimmed ? pendingId.current.inputId : newInputId();
    pendingId.current = { text: trimmed, inputId };
    setDraft(agent.id, "");
    setStatus(null);
    let result: SendResult;
    try {
      result = await client.agents.send({ agentId: agent.id, inputId, text: trimmed, mode });
    } catch (error) {
      setDraft(agent.id, text);
      setStatus({
        type: "error",
        message: `Not sent (${error instanceof Error ? error.message : String(error)}). Send again to retry; it won't be delivered twice.`,
      });
      report("warn", "composer.send_failed", error, { agentId: agent.id });
      return;
    }
    pendingId.current = null;
    if (result.landed === "rejected" || result.landed === "failed") {
      setDraft(agent.id, text);
      setStatus({
        type: "error",
        message: `Not delivered: ${result.reason ?? result.code ?? result.landed}`,
      });
    } else if (result.landed === "queued") {
      setStatus({ type: "warning", message: "Queued: it will be sent when the current turn ends." });
    }
  };

  const abort = async (): Promise<void> => {
    if (client === null) return;
    try {
      const result = await client.agents.abort({ agentId: agent.id });
      if (!result.accepted)
        setStatus({ type: "warning", message: `Couldn't stop it: ${result.reason ?? "no running turn"}` });
    } catch (error) {
      report("warn", "composer.abort_failed", error, { agentId: agent.id });
    }
  };

  /** Upload files to the server and put their paths in the message (roamgate #70): every runtime reads files by path. */
  const attach = async (files: readonly File[]): Promise<void> => {
    if (client === null || files.length === 0) return;
    setStatus({ type: "warning", message: `Uploading ${files.map((f) => f.name || "a file").join(", ")}…` });
    try {
      for (const file of files) {
        const saved = await client.files.upload({ file });
        const mention = `\`${saved.path}\` `;
        if (inputRef.current === null)
          setDraft(agent.id, `${useDrafts.getState().byAgent[agent.id] ?? ""}${mention}`);
        else inputRef.current.insertText(mention);
      }
      setStatus(null);
    } catch (error) {
      setStatus({
        type: "error",
        message: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      report("warn", "composer.upload_failed", error, { agentId: agent.id });
    }
  };

  const context = agent.summary.context?.percent;
  return (
    <ChatComposer
      value={draft}
      onChange={(value) => setDraft(agent.id, value)}
      onSubmit={(value) => void send(value, "auto")}
      isStopShown={working && draft.trim() === ""}
      onStop={() => void abort()}
      isDisabled={archived || client === null}
      placeholder={
        archived
          ? "Archived. Unarchive it to continue."
          : working
            ? "Steer the running turn…"
            : "Message the agent…"
      }
      {...(status === null ? {} : { status })}
      input={
        <ChatComposerInput
          handleRef={inputRef}
          onFiles={(files) => void attach(files)}
          hasHistory
          maxRows={10}
          onKeyDown={(event) => {
            if (coarse && event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey)
              event.preventDefault();
          }}
        />
      }
      sendActions={
        working && draft.trim() !== "" ? (
          <Button label="Queue" size="sm" variant="ghost" onClick={() => void send(draft, "queue")} />
        ) : undefined
      }
      drawer={<ReviewDrawer workspaceId={workspaceId} agentId={agent.id} />}
      headerActions={
        <>
          <Button
            label="Attach a file"
            size="sm"
            variant="ghost"
            isIconOnly
            icon={<Icon icon={Paperclip} size="sm" />}
            isDisabled={archived || client === null}
            onClick={() => fileRef.current?.click()}
          />
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              void attach(picked);
            }}
          />
        </>
      }
      headerContext={
        context === null || context === undefined ? undefined : (
          <Text type="supporting">{`context ${Math.round(context)}%`}</Text>
        )
      }
    />
  );
}
