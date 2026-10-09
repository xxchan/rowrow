// Coach's references, as roamgate's Ranger has them (#375): type @ in Coach's message box (or
// press its @ button) to pick a workspace Coach may read or an agent in one; each shows where it
// is and what it is, so two of the same name read apart. ↑/↓ and Enter or Tab pick, Escape closes
// the list, Shift+Enter is a new line. Picked ones wait under the box, removable, with the draft
// of their chat; editing a reference's text unbinds it, and a name you type or paste is just text.
// In the conversation each one is a link to its agent or workspace, opened only if it's still there.
import { cn } from "@/lib/utils";
import { AtSign, Folder, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  adjustMentions,
  insertMention,
  MAX_MENTIONS,
  mentionCandidates,
  mentionQuery,
  type CoachMention,
  type CoachMentionTarget,
  type MentionCandidate,
  type TextEdit,
} from "../../shared/coach-mentions.ts";
import type { AppState } from "../../shared/schemas.ts";
import { allowedWorkspaces, closeCoach, useCoach } from "../lib/coach.ts";
import { RouterLink } from "../lib/router.ts";
import { useApp } from "../lib/store.ts";
import { AgentIcon } from "./AgentIcon.tsx";

/** Candidates the list shows at most; typing narrows it. */
const SHOWN = 50;
const MAX_CHARS = 20_000;
const UNAVAILABLE =
  "This workspace or agent reference is no longer available. Select it again before using it.";

/** Where a reference leads: its agent, or its workspace's page. */
export function mentionHref(target: CoachMentionTarget): string {
  return target.kind === "agent" ? `/a/${target.id}` : `/w/${target.id}`;
}

/** Whether what a reference points at is still there to open. */
function present(state: AppState | null, target: CoachMentionTarget): boolean {
  return target.kind === "agent"
    ? state?.agents[target.id] !== undefined
    : state?.workspaces[target.id] !== undefined;
}

/** Follow a reference: when it's gone, Coach says so instead; on a phone, Coach steps aside. */
function follow(event: { preventDefault: () => void }, target: CoachMentionTarget): void {
  if (!present(useApp.getState().state, target)) {
    event.preventDefault();
    useCoach.setState({ error: UNAVAILABLE });
    return;
  }
  if (matchMedia("(max-width: 767px)").matches) closeCoach();
}

/** A reference in a message you sent: a link to its agent or workspace. */
export function MentionLink({ mention, text }: { mention: CoachMention; text: string }) {
  const where = useApp((s) => {
    const state = s.state;
    if (mention.kind === "workspace") return state?.workspaces[mention.id]?.path ?? null;
    const workspaceId = state?.agents[mention.id]?.summary.workspaceId;
    return workspaceId === undefined ? null : (state?.workspaces[workspaceId]?.label ?? null);
  });
  return (
    <RouterLink
      href={mentionHref(mention)}
      title={`${mention.kind === "agent" ? "Agent" : "Workspace"}${where === null ? "" : ` · ${where}`}`}
      onClick={(event) => follow(event, mention)}
      className="rounded border bg-background/70 px-[3px] text-primary [overflow-wrap:anywhere] hover:underline"
    >
      {text}
    </RouterLink>
  );
}

/**
 * Coach's message box with @ references: the box itself (its props), the list @ opens above it,
 * the @ button, and the references picked so far under it.
 */
export function MentionInput({
  state,
  draftKey,
  value,
  mentions,
  onChange,
  onSubmit,
  inputRef,
  narrow,
  className,
  children,
}: {
  state: AppState;
  /** The draft's key: another chat's draft closes the list. */
  draftKey: string;
  value: string;
  mentions: readonly CoachMention[];
  onChange: (text: string, mentions: readonly CoachMention[]) => void;
  onSubmit: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  narrow: boolean;
  className: string;
  /** What else sits in the box (Send, on a phone). */
  children?: ReactNode;
}) {
  const [picker, setPicker] = useState<ReturnType<typeof mentionQuery>>(null);
  const [category, setCategory] = useState<"all" | "workspace" | "agent">("all");
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const composing = useRef(false);
  /** Where the browser said the coming edit is (beforeinput). */
  const edit = useRef<TextEdit | undefined>(undefined);
  /** Opened with the @ button: moving the caret doesn't close it. */
  const browsing = useRef(false);
  /** The text and caret Escape closed the list at: it stays closed there. */
  const dismissed = useRef("");
  const caret = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = picker !== null;

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const capture = (event: InputEvent): void => {
      edit.current = { start: input.selectionStart, end: input.selectionEnd, inputType: event.inputType };
    };
    input.addEventListener("beforeinput", capture);
    return () => input.removeEventListener("beforeinput", capture);
  }, [inputRef]);

  // Another chat's draft: its own text, its own references, and no list open.
  const [shownKey, setShownKey] = useState(draftKey);
  if (shownKey !== draftKey) {
    setShownKey(draftKey);
    setPicker(null);
    setNotice(null);
  }

  // After a pick, the caret goes after the reference (once the box shows the new text).
  useLayoutEffect(() => {
    if (caret.current === null || inputRef.current === null) return;
    inputRef.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const allowed = allowedWorkspaces(state);
  // Read while the list is open, so it follows the crew as it changes.
  const all = open ? mentionCandidates(state, allowed) : [];
  const query = picker?.query.toLocaleLowerCase() ?? "";
  const matching = all.filter(
    (candidate) =>
      (category === "all" || candidate.kind === category) &&
      [candidate.label, candidate.where, candidate.what].join(" ").toLocaleLowerCase().includes(query),
  );
  const candidates = matching.slice(0, SHOWN);
  const current = Math.min(active, Math.max(0, candidates.length - 1));
  const selected = candidates[current];

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = (): void => {
    browsing.current = false;
    dismissed.current = `${draftKey}:${value}:${inputRef.current?.selectionStart ?? ""}`;
    setPicker(null);
  };

  /** Open the list for an @ being typed at the caret (not one inside a reference), or close it. */
  const updatePicker = (
    input: HTMLTextAreaElement,
    bound: readonly CoachMention[],
    changed = false,
  ): void => {
    if (browsing.current && !changed) return;
    browsing.current = false;
    if (composing.current || dismissed.current === `${draftKey}:${input.value}:${input.selectionStart}`)
      return;
    const next = mentionQuery(input.value, input.selectionStart, input.selectionEnd);
    setActive(0);
    setPicker(
      next !== null && !bound.some((mention) => next.start >= mention.start && next.start < mention.end)
        ? next
        : null,
    );
    if (next === null) setNotice(null);
  };

  const select = (target: MentionCandidate): void => {
    if (picker === null || composing.current) return;
    if (mentions.length >= MAX_MENTIONS) {
      setNotice(`Use up to ${MAX_MENTIONS} references per message.`);
      return;
    }
    const reference: CoachMentionTarget = { kind: target.kind, id: target.id, label: target.label };
    const next = insertMention(value, mentions, reference, picker.start, picker.end);
    if (next.text.length > MAX_CHARS) {
      setNotice("This reference would make the message too long.");
      return;
    }
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(picker.start, picker.end);
    // The browser's own insertion keeps its undo; the draft below is set either way.
    try {
      document.execCommand("insertText", false, `@${reference.label} `);
    } catch {
      // Not every browser inserts text this way: the controlled value below does it.
    }
    edit.current = undefined;
    caret.current = next.caret;
    onChange(next.text, next.mentions);
    setPicker(null);
    setNotice(null);
    browsing.current = false;
    dismissed.current = "";
  };

  const onInput = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const text = event.currentTarget.value;
    const where = edit.current;
    edit.current = undefined;
    dismissed.current = "";
    const bound = adjustMentions(value, text, mentions, where);
    onChange(text, bound);
    updatePicker(event.currentTarget, bound, true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
    if (open && event.key === "Escape") {
      // The list, not Coach's window.
      event.preventDefault();
      close();
      return;
    }
    if (open && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (candidates.length > 0)
          setActive((current + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || (event.key === "Tab" && selected !== undefined)) {
        event.preventDefault();
        if (selected !== undefined && !event.repeat) select(selected);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!event.repeat) onSubmit();
  };

  const keepFocus = (event: React.MouseEvent): void => event.preventDefault();
  const row = narrow ? "min-h-11" : "min-h-[26px]";

  return (
    <>
      <div className="relative">
        {open && (
          <div className="absolute inset-x-0 bottom-full z-30 mb-2 flex max-h-[min(340px,55dvh)] flex-col overflow-hidden rounded-xl border bg-popover shadow-xl">
            <div className="flex items-center justify-between gap-2 border-b p-1.5">
              <div role="group" aria-label="Reference types" className="flex gap-0.5">
                {(["all", "workspace", "agent"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={category === kind}
                    onMouseDown={keepFocus}
                    onClick={() => {
                      setCategory(kind);
                      setActive(0);
                    }}
                    className={cn(
                      "rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground",
                      row,
                    )}
                  >
                    {kind === "all" ? "All" : kind === "workspace" ? "Workspaces" : "Agents"}
                  </button>
                ))}
              </div>
              <button
                type="button"
                aria-label="Close reference menu"
                onMouseDown={keepFocus}
                onClick={close}
                className={cn(
                  "grid place-items-center rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                  row,
                  narrow && "min-w-11",
                )}
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div
              ref={list}
              id={id}
              role="listbox"
              aria-label="Workspace and agent references"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 empty:hidden"
            >
              {candidates.map((candidate, index) => (
                <button
                  key={`${candidate.kind}:${candidate.id}`}
                  id={`${id}-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === current}
                  onMouseDown={keepFocus}
                  onClick={() => select(candidate)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left aria-selected:bg-accent"
                >
                  {candidate.runtime === undefined ? (
                    <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <AgentIcon runtime={candidate.runtime} />
                  )}
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <strong className="text-xs font-medium [overflow-wrap:anywhere]">
                      {candidate.label}
                    </strong>
                    <small className="truncate text-[11px] text-muted-foreground">{candidate.where}</small>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{candidate.what}</span>
                </button>
              ))}
            </div>
            {candidates.length === 0 && (
              <p role="status" className="px-2.5 py-2 text-[11px] text-muted-foreground">
                {allowed.length === 0
                  ? "Allow workspaces in Coach's settings to reference them."
                  : "No matching references in the workspaces Coach may read."}
              </p>
            )}
            {matching.length > SHOWN && (
              <p role="status" className="px-2.5 py-2 text-[11px] text-muted-foreground">
                More match: keep typing to narrow the list.
              </p>
            )}
            {notice !== null && (
              <p role="status" className="px-2.5 py-2 text-[11px] text-destructive">
                {notice}
              </p>
            )}
            <div className="border-t px-2.5 py-[7px] text-[11px] text-muted-foreground">
              References add context. Actions follow Coach's permissions.
            </div>
          </div>
        )}
        <textarea
          ref={inputRef}
          aria-label="Message Coach"
          placeholder="Ask about your agents, or @mention one"
          rows={3}
          maxLength={MAX_CHARS}
          {...(narrow ? { enterKeyHint: "send" as const } : {})}
          value={value}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-activedescendant={open && selected !== undefined ? `${id}-${current}` : undefined}
          onChange={onInput}
          onSelect={(event) => updatePicker(event.currentTarget, mentions)}
          onCompositionStart={() => {
            composing.current = true;
            setPicker(null);
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            updatePicker(event.currentTarget, mentions);
          }}
          onKeyDown={onKeyDown}
          className={cn(className, narrow ? "pl-12" : "pr-9")}
        />
        <button
          type="button"
          aria-label="Mention workspace or agent"
          title="Mention a workspace or agent"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onMouseDown={keepFocus}
          onClick={() => {
            if (open) {
              close();
              return;
            }
            const input = inputRef.current;
            browsing.current = true;
            input?.focus({ preventScroll: true });
            setCategory("all");
            setActive(0);
            setPicker({
              start: input?.selectionStart ?? value.length,
              end: input?.selectionEnd ?? value.length,
              query: "",
            });
          }}
          className={cn(
            "absolute top-1 grid place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:text-foreground",
            narrow ? "left-1 size-11" : "right-1 size-7",
          )}
        >
          <AtSign className="size-[15px]" />
        </button>
        {children}
      </div>
      {mentions.length > 0 && (
        <MentionTray
          state={state}
          mentions={mentions}
          narrow={narrow}
          // Unbound; its text stays, as plain text.
          onRemove={(mention) =>
            onChange(
              value,
              mentions.filter((m) => m !== mention),
            )
          }
        />
      )}
    </>
  );
}

/** The references a draft carries, under the box: open one, or remove it (its text stays). */
function MentionTray({
  state,
  mentions,
  onRemove,
  narrow,
}: {
  state: AppState;
  mentions: readonly CoachMention[];
  onRemove: (mention: CoachMention) => void;
  narrow: boolean;
}) {
  const row = narrow ? "min-h-11" : "min-h-[26px]";
  // What the next message may read: a reference outside it (archived, removed, no longer
  // allowed) would refuse the message, so it says to pick it again.
  const allowed = allowedWorkspaces(state);
  return (
    <div
      role="group"
      aria-label="Message references"
      className="flex max-h-[100px] flex-wrap gap-[5px] overflow-y-auto"
    >
      {mentions.map((mention) => {
        const agent = mention.kind === "agent" ? state.agents[mention.id] : undefined;
        const where =
          mention.kind === "workspace"
            ? allowed.includes(mention.id)
              ? "Workspace"
              : null
            : agent === undefined || agent.summary.archived || !allowed.includes(agent.summary.workspaceId)
              ? null
              : (state.workspaces[agent.summary.workspaceId]?.label ?? agent.summary.workspaceId);
        return (
          <span
            key={`${mention.start}:${mention.kind}:${mention.id}`}
            className="inline-flex max-w-full items-center rounded-md border bg-muted/60"
          >
            <RouterLink
              href={mentionHref(mention)}
              title={`${mention.kind === "agent" ? "Agent" : "Workspace"}${where === null ? "" : ` · ${where}`}`}
              onClick={(event) => follow(event, mention)}
              className={cn("inline-flex min-w-0 items-center gap-1 px-1.5 py-0.5 text-[11px]", row)}
            >
              {mention.kind === "agent" ? (
                <AgentIcon runtime={agent?.summary.runtime ?? ""} className="size-3" />
              ) : (
                <Folder className="size-3 shrink-0" aria-hidden />
              )}
              <span className="grid min-w-0">
                <span className="truncate">{mention.label}</span>
                <small
                  className={cn(
                    "truncate text-[10px]",
                    where === null ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {where ?? "Unavailable: select it again"}
                </small>
              </span>
            </RouterLink>
            <button
              type="button"
              aria-label={`Remove reference to ${mention.label}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRemove(mention)}
              className={cn(
                "grid place-items-center px-1.5 text-muted-foreground hover:text-foreground",
                row,
                narrow && "min-w-11",
              )}
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
