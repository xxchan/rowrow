// Writing to an agent. Enter sends; while the agent works, a message steers the running
// turn (or waits for the next one, when the runtime can't steer), "Queue" holds it for the
// next turn, and Stop interrupts. A send that may not have arrived keeps its id, so trying
// again can't deliver it twice (PRINCIPLES.md, engineering 2). On touch screens Return is a
// newline (IME and dictation users need it) and the button sends. Pasted, dropped or picked
// files upload at once and wait above the text as tiles; they go with the next message.
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ArrowUp, LoaderCircle, Paperclip, Slash, Square } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { InputMode } from "../../shared/entries.ts";
import { newInputId } from "../../shared/ids.ts";
import type { AgentState, SendResult, SkillInfo } from "../../shared/schemas.ts";
import { attachFiles, detachFile, filesOf, readyFiles } from "../lib/attachments.ts";
import {
  attachmentsOf,
  setAttachments,
  setDraft,
  useApp,
  useClient,
  useDrafts,
  usePendingAttachments,
} from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { ComposerAttachments } from "./Attachments.tsx";
import { ReviewDrawer } from "./ReviewDrawer.tsx";
import { SessionInfo } from "./SessionInfo.tsx";

const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
/** What you sent to each agent in this tab, for ↑ in an empty composer. */
const sentHistory = new Map<string, string[]>();

export function Composer({ agent, onSwitchModel }: { agent: AgentState; onSwitchModel: () => void }) {
  const workspaceId = agent.summary.workspaceId;
  const client = useClient();
  const draft = useDrafts((s) => s.byAgent[agent.id] ?? "");
  const attached = usePendingAttachments(agent.id);
  const pendingId = useRef<{ key: string; inputId: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const [status, setStatus] = useState<{ type: "error" | "warning" | "busy"; message: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const quickReplies = useApp((s) => s.state?.settings.quickReplies ?? []);
  // The / menu: what the runtime accepts as /name here (roamgate #226). Fills the draft, never sends.
  const [skills, setSkills] = useState<{ list: SkillInfo[]; error: string | null } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const typed = /^\/(\S*)$/.exec(draft)?.[1];
  const menuOpen = typed !== undefined && dismissed !== draft;
  const matches =
    typed === undefined || skills === null
      ? []
      : skills.list
          .filter((skill) => skill.name.toLowerCase().includes(typed.toLowerCase()))
          .sort(
            (a, b) =>
              Number(!a.name.toLowerCase().startsWith(typed.toLowerCase())) -
              Number(!b.name.toLowerCase().startsWith(typed.toLowerCase())),
          )
          .slice(0, 50);
  const wantsSkills = typed !== undefined && skills === null;
  useEffect(() => {
    if (!wantsSkills || client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.runtimes.skills({ runtime: agent.summary.runtime, workspaceId });
        if (!cancelled) setSkills({ list: result.skills, error: result.error });
      } catch (error) {
        if (!cancelled)
          setSkills({ list: [], error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantsSkills, client, agent.summary.runtime, workspaceId]);
  const pick = (skill: SkillInfo): void => {
    const text = `/${skill.name} `;
    caret.current = text.length;
    setDraft(agent.id, text);
    setHighlight(0);
    inputRef.current?.focus();
  };
  const working = agent.attention === "working";
  const archived = agent.summary.archived;
  const disabled = archived || client === null;
  const empty = draft.trim() === "" && attached.length === 0;
  const uploading = attached.some((file) => file.state === "uploading");

  // Grow with the text, up to a limit; then scroll inside.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.style.height = "auto";
    if (draft !== "") input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
    if (caret.current !== null) {
      input.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [draft]);

  const send = async (text: string, mode: InputMode): Promise<void> => {
    const trimmed = text.trim();
    const files = attachmentsOf(agent.id);
    if (client === null || (trimmed === "" && files.length === 0)) return;
    const ready = readyFiles(agent.id);
    if ("problem" in ready) {
      setStatus({ type: "warning", message: ready.problem });
      return;
    }
    const { attachments } = ready;
    // Reuse the id of an attempt that may have reached the server (same message, not confirmed).
    const key = JSON.stringify([trimmed, attachments.map((file) => file.path)]);
    const inputId = pendingId.current?.key === key ? pendingId.current.inputId : newInputId();
    pendingId.current = { key, inputId };
    setDraft(agent.id, "");
    setAttachments(agent.id, () => []);
    setStatus(null);
    const restore = (): void => {
      setDraft(agent.id, text);
      setAttachments(agent.id, (current) => [...files, ...current]);
    };
    let result: SendResult;
    try {
      result = await client.agents.send({
        agentId: agent.id,
        inputId,
        text: trimmed,
        ...(attachments.length === 0 ? {} : { attachments }),
        mode,
      });
    } catch (error) {
      restore();
      setStatus({
        type: "error",
        message: `Not sent (${error instanceof Error ? error.message : String(error)}). Send again to retry; it won't be delivered twice.`,
      });
      report("warn", "composer.send_failed", error, { agentId: agent.id });
      return;
    }
    pendingId.current = null;
    if (trimmed !== "") sentHistory.set(agent.id, [...(sentHistory.get(agent.id) ?? []), trimmed].slice(-50));
    if (result.landed === "rejected" || result.landed === "failed") {
      restore();
      setStatus({
        type: "error",
        message: `Not delivered: ${result.reason ?? result.code ?? result.landed}`,
      });
      return;
    }
    // Sent: the transcript shows the files from the server now.
    for (const file of files) if (file.preview !== null) URL.revokeObjectURL(file.preview);
    if (result.landed === "queued") {
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

  /** Upload files as the next message's attachments (roamgate #70); they show as tiles meanwhile. */
  const attach = (files: readonly File[]): void => {
    if (client === null || files.length === 0) return;
    setStatus(null);
    attachFiles(client, agent.id, files);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (menuOpen && matches.length > 0) {
      const current = Math.min(highlight, matches.length - 1);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const chosen = matches[current];
        if (chosen !== undefined) {
          event.preventDefault();
          pick(chosen);
          return;
        }
      }
    }
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      setDismissed(draft);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      // On a touch screen Return is a newline, unless you mean it (⌘/Ctrl+Return).
      if (touch && !event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      void send(draft, "auto");
    } else if (event.key === "ArrowUp" && draft === "") {
      const last = sentHistory.get(agent.id)?.at(-1);
      if (last !== undefined) {
        event.preventDefault();
        caret.current = last.length;
        setDraft(agent.id, last);
      }
    } else if (event.key === "Escape" && working && empty) {
      void abort();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = filesOf(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    attach(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDragging(false);
    const files = filesOf(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    attach(files);
  };

  return (
    <div className="relative mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">
      {menuOpen && (
        <div
          role="listbox"
          aria-label="Commands"
          className="absolute inset-x-3 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 shadow-xl md:inset-x-6"
        >
          {skills === null ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading commands
            </div>
          ) : matches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {skills.error ?? (skills.list.length === 0 ? "No commands here." : "No command matches.")}
            </p>
          ) : (
            matches.map((skill, index) => (
              <button
                key={skill.name}
                type="button"
                role="option"
                aria-selected={index === Math.min(highlight, matches.length - 1)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(skill)}
                className="flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left aria-selected:bg-accent"
              >
                <span className="font-mono text-[13px]">{`/${skill.name}`}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {skill.description ?? skill.source ?? ""}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      <div
        className={cn(
          "overflow-hidden rounded-xl border bg-card shadow-sm transition-colors focus-within:border-ring/60",
          dragging && "border-primary bg-primary/5",
          disabled && "opacity-70",
        )}
        onDragOver={(event) => {
          if (disabled || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <ReviewDrawer workspaceId={workspaceId} agentId={agent.id} />
        <ComposerAttachments items={attached} onRemove={(id) => detachFile(agent.id, id)} />
        {draft === "" && !disabled && quickReplies.length > 0 && (
          <div
            role="group"
            aria-label="Quick replies"
            className="flex gap-1.5 overflow-x-auto px-3 pt-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {quickReplies.map((reply) => (
              <button
                key={reply}
                type="button"
                onClick={() => {
                  caret.current = reply.length;
                  setDraft(agent.id, reply);
                  inputRef.current?.focus();
                }}
                className="shrink-0 rounded-full border bg-background/60 px-2.5 py-1 text-xs text-muted-foreground hover:border-ring/60 hover:text-foreground"
              >
                {reply}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          aria-label="Message input"
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder={
            archived
              ? "Archived. Unarchive it to continue."
              : working
                ? "Steer the running turn…"
                : "Message the agent…"
          }
          onChange={(event) => setDraft(agent.id, event.currentTarget.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="block max-h-60 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base leading-relaxed outline-none placeholder:text-muted-foreground md:text-sm"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label="Attach files"
                disabled={disabled}
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach files (or paste, or drop)</TooltipContent>
          </Tooltip>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              attach(picked);
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label="Commands"
                disabled={disabled || (draft !== "" && typed === undefined)}
                onClick={() => {
                  if (draft === "") {
                    caret.current = 1;
                    setDraft(agent.id, "/");
                  }
                  setDismissed(null);
                  inputRef.current?.focus();
                }}
              >
                <Slash />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Commands and skills (type /)</TooltipContent>
          </Tooltip>
          <SessionInfo agent={agent} onSwitchModel={onSwitchModel} />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {working && !empty && (
              <Button variant="ghost" size="sm" className="h-8" onClick={() => void send(draft, "queue")}>
                Queue
              </Button>
            )}
            {working && empty ? (
              <Button
                size="icon"
                variant="secondary"
                className="size-8 rounded-full"
                aria-label="Stop"
                onClick={() => void abort()}
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-8 rounded-full"
                aria-label="Send"
                disabled={disabled || empty || uploading}
                onClick={() => void send(draft, "auto")}
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
      {status !== null && (
        <p
          role={status.type === "error" ? "alert" : "status"}
          className={cn(
            "flex items-center gap-1.5 px-1 pt-1.5 text-xs",
            status.type === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {status.type === "busy" && <LoaderCircle className="size-3 animate-spin" />}
          {status.message}
        </p>
      )}
    </div>
  );
}
