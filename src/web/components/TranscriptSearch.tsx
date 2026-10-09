// Transcript search (D-055): a bar above an agent's conversation that finds what was said or
// done anywhere in its history. The server searches the whole log (agents.search), which no
// browser holds, and an iPhone's home-screen app has no find-in-page anyway. Its filters and
// results are roamgate's history search (docs/HISTORY.md "Message filters"): You, Agent and
// Tool toggles with their counts, Tool off at first, kept while the app is open; each result
// says who and when; "Show all types" when the toggles hide every match. Picking a result jumps
// the conversation there (`onJump`); Enter and ⇧Enter step to the older and the newer one.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, List, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { stamp } from "../../shared/describe.ts";
import type { SearchWho, TranscriptHit, TranscriptSearch as Found } from "../../shared/schemas.ts";
import { searchPattern } from "../../shared/transcript-search.ts";
import { useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { useNarrow } from "../lib/use-narrow.ts";
import { ErrorText } from "./ErrorText.tsx";

const KINDS: readonly SearchWho[] = ["you", "agent", "tool"];

/** What a search came back with, for the text and kinds asked (`key`). */
interface Result {
  readonly key: string;
  readonly query: string;
  readonly found: Found | null;
  readonly error: string | null;
}
const LABELS: Record<SearchWho, string> = { you: "You", agent: "Agent", tool: "Tool" };
const TONES: Record<SearchWho, string> = {
  you: "aria-pressed:border-info aria-pressed:text-info",
  agent: "aria-pressed:border-success aria-pressed:text-success",
  tool: "aria-pressed:border-warning aria-pressed:text-warning",
};

/** The kinds shown, as roamgate starts them (tool calls off: they match the most and say the least). */
const useKinds = create<Record<SearchWho, boolean>>(() => ({ you: true, agent: true, tool: false }));

export function TranscriptSearch({
  agentId,
  assistant,
  onJump,
  onClose,
}: {
  agentId: string;
  /** The runtime's name, for what the agent said. */
  assistant: string;
  /** Show this hit in the conversation. */
  onJump: (hit: TranscriptHit, query: string) => void;
  onClose: () => void;
}) {
  const client = useClient();
  const narrow = useNarrow();
  const kinds = useKinds();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const who = KINDS.filter((kind) => kinds[kind]).join(",");
  const key = `${debounced}\n${who}`;
  const [result, setResult] = useState<Result | null>(null);
  // Which result is shown; null until you pick one.
  const [selected, setSelected] = useState<{ readonly key: string; readonly index: number } | null>(null);
  const [listOpen, setListOpen] = useState(true);
  // Enter before the search went out (typed fast, or a phone keyboard's Search key): what to do
  // when it's back.
  const whenBack = useRef<((back: Result) => void) | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Opening the bar asks once with nothing to find: the server folds the log while you type.
  useEffect(() => {
    client?.agents.search({ agentId, text: "" }).catch((error: unknown) => {
      report("warn", "transcript.search_failed", error, { agentId });
    });
  }, [client, agentId]);

  useEffect(() => {
    if (client === null || debounced === "") return;
    let cancelled = false;
    const asked = `${debounced}\n${who}`;
    const settle = (back: Result): void => {
      setResult(back);
      whenBack.current?.(back);
      whenBack.current = null;
    };
    void (async () => {
      try {
        const found = await client.agents.search({
          agentId,
          text: debounced,
          who: who === "" ? [] : (who.split(",") as SearchWho[]),
        });
        if (!cancelled) settle({ key: asked, query: debounced, found, error: null });
      } catch (error) {
        report("warn", "transcript.search_failed", error, { agentId });
        if (!cancelled)
          settle({
            key: asked,
            query: debounced,
            found: null,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, agentId, debounced, who]);

  const shown = debounced === "" || result === null ? null : result;
  const loading = debounced !== "" && result?.key !== key;
  const hits = shown?.found?.hits ?? [];
  const current = selected?.key === shown?.key ? (selected?.index ?? null) : null;

  // The picked result stays in view in the list.
  useEffect(() => {
    if (current === null || !listOpen) return;
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current, listOpen]);

  const pickIn = (from: Result, index: number): void => {
    const hit = from.found?.hits[index];
    if (hit === undefined) return;
    setSelected({ key: from.key, index });
    // On a phone the list and the keyboard cover the conversation: put both away to see the hit.
    if (narrow) {
      setListOpen(false);
      input.current?.blur();
    }
    onJump(hit, from.query);
  };
  const pick = (index: number): void => {
    if (shown !== null) pickIn(shown, index);
  };
  // Enter starts at the newest match and goes back in time, as you'd look back in a chat.
  const older = (): void => {
    if (hits.length > 0) pick(current === null ? hits.length - 1 : Math.max(0, current - 1));
  };
  const enter = (): void => {
    const text = query.trim();
    if (text === "") return;
    if (text === debounced && !loading) {
      older();
      return;
    }
    whenBack.current = (back) => {
      const newest = (back.found?.hits.length ?? 0) - 1;
      if (newest >= 0) pickIn(back, newest);
    };
    setDebounced(text);
  };
  const newer = (): void => {
    if (hits.length > 0) pick(current === null ? hits.length - 1 : Math.min(hits.length - 1, current + 1));
  };

  const counts = shown?.found?.counts;
  const total = counts === undefined ? 0 : counts.you + counts.agent + counts.tool;
  const counter =
    shown === null
      ? ""
      : hits.length === 0
        ? "0"
        : current === null
          ? `${hits.length}${shown.found?.more === true ? "+" : ""}`
          : `${current + 1} of ${hits.length}${shown.found?.more === true ? "+" : ""}`;

  return (
    <section
      aria-label="Conversation search"
      className="shrink-0 border-b bg-background"
      // Its buttons leave the field focused: Enter goes on from the match picked, and on a phone
      // the header doesn't unfold (index.css) under the finger mid-tap.
      onMouseDown={(event) => {
        if (event.target instanceof Element && event.target.closest("button") !== null)
          event.preventDefault();
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl items-center gap-1 px-3 py-2 md:px-6">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={input}
            type="search"
            autoFocus
            data-transcript-search
            aria-label="Search the conversation"
            placeholder="Search messages"
            title="Your messages, its answers and its tool calls, all of its history; any case, plain text"
            enterKeyHint="search"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setListOpen(true);
            }}
            onFocus={() => setListOpen(true)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) newer();
                else enter();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="h-9 pr-8 pl-8 md:h-8"
          />
          {loading && (
            <LoaderCircle className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        <span
          aria-live="polite"
          // Room for the count only once there is one: on a phone the field needs the width.
          className={cn(
            "shrink-0 text-center text-xs text-muted-foreground tabular-nums",
            counter !== "" && "min-w-10 px-1",
          )}
        >
          {counter}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="md:size-8"
          aria-label="Older match"
          title="Older match (↵)"
          disabled={hits.length === 0 || current === 0}
          onClick={older}
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="md:size-8"
          aria-label="Newer match"
          title="Newer match (⇧↵)"
          disabled={hits.length === 0 || current === null || current === hits.length - 1}
          onClick={newer}
        >
          <ChevronDown />
        </Button>
        {narrow && (
          <Button
            variant={listOpen ? "secondary" : "ghost"}
            size="icon"
            aria-label="Results"
            aria-pressed={listOpen}
            disabled={shown === null}
            onClick={() => setListOpen(!listOpen)}
          >
            <List />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="md:size-8"
          aria-label="Close search"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      {shown !== null && listOpen && (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 pb-2 md:px-6">
          <div role="group" aria-label="Filter results by message type" className="flex gap-1.5">
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-label={LABELS[kind]}
                aria-pressed={kinds[kind]}
                title={`${kinds[kind] ? "Hide" : "Show"} ${LABELS[kind].toLowerCase()} matches`}
                onClick={() => useKinds.setState({ [kind]: !kinds[kind] })}
                className={cn(
                  "inline-flex min-h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border px-2 text-xs text-muted-foreground hover:bg-accent/60 aria-pressed:bg-accent/40",
                  TONES[kind],
                )}
              >
                {LABELS[kind]}
                <span className="text-[10px] tabular-nums">{counts?.[kind] ?? 0}</span>
              </button>
            ))}
          </div>
          {shown.error !== null ? (
            <ErrorText>{shown.error}</ErrorText>
          ) : hits.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center text-sm text-muted-foreground">
              {total === 0 ? (
                "No matches."
              ) : (
                <>
                  No entries match the search and selected message types.
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => useKinds.setState({ you: true, agent: true, tool: true })}
                  >
                    Show all types
                  </Button>
                </>
              )}
            </div>
          ) : (
            <ol
              ref={list}
              aria-label="Matches"
              className="flex max-h-[min(34dvh,22rem)] md:max-h-[min(40dvh,22rem)] flex-col gap-1 overflow-y-auto overscroll-contain"
            >
              {shown.found?.more === true && (
                <li className="px-1 pb-1 text-xs text-muted-foreground">
                  {`More than ${hits.length} matches: these are the newest ${hits.length}.`}
                </li>
              )}
              {hits.map((hit, index) => (
                <li key={`${hit.itemId}:${hit.field}`} data-index={index}>
                  <button
                    type="button"
                    aria-current={index === current ? "true" : undefined}
                    onClick={() => pick(index)}
                    className="flex w-full min-w-0 flex-col gap-0.5 rounded-md border border-transparent px-2 py-1.5 text-left hover:bg-accent/60 aria-current:border-ring/60 aria-current:bg-accent/40"
                  >
                    <span className="flex items-baseline gap-2 text-[11px]">
                      <strong className={cn("font-semibold", WHO_TONE[hit.who])}>
                        {whoLabel(hit, assistant)}
                      </strong>
                      <time
                        className="text-muted-foreground tabular-nums"
                        dateTime={new Date(hit.at).toISOString()}
                      >
                        {stamp(hit.at)}
                      </time>
                    </span>
                    <span className="line-clamp-2 text-[13px] leading-snug break-words md:text-xs">
                      {marked(hit)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

const WHO_TONE: Record<SearchWho, string> = { you: "text-info", agent: "text-success", tool: "text-warning" };

/** Who it was, as roamgate's history says it: You, the assistant, Tool call: Bash, Tool output: Bash. */
function whoLabel(hit: TranscriptHit, assistant: string): string {
  if (hit.who === "you") return "You";
  if (hit.who === "agent") return assistant;
  return `${hit.field === "output" ? "Tool output" : "Tool call"}: ${hit.tool ?? "tool"}`;
}

function marked(hit: TranscriptHit): ReactNode {
  const [start, end] = hit.match;
  return (
    <>
      {hit.snippet.slice(0, start)}
      <mark className="rounded-sm bg-warning/30 text-foreground">{hit.snippet.slice(start, end)}</mark>
      {hit.snippet.slice(end)}
    </>
  );
}

const HIGHLIGHT = "transcript-search";
/** The item flashing now, and when its flash ends. */
let flashed: { readonly box: Element; readonly timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Scroll the conversation to a hit's item (its data-item) and flash it, with what matched marked
 * (the CSS Custom Highlight API, where the browser has it). False when it isn't on the page.
 */
export function revealHit(scroller: HTMLElement, itemId: string, query: string): boolean {
  const item = scroller.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
  if (item === null) return false;
  // A text's wrapper only groups what Streamdown draws: its box is the child's.
  const box = getComputedStyle(item).display === "contents" ? (item.firstElementChild ?? item) : item;
  const ranges = matchRanges(box, query);
  if ("highlights" in CSS) {
    styleMarks();
    CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
  }
  const viewport = scroller.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  // A long reply: its first match, rather than its top.
  const target =
    boxRect.height > viewport.height / 2 && ranges[0] !== undefined
      ? ranges[0].getBoundingClientRect()
      : boxRect;
  const scale = scroller.offsetHeight === 0 ? 1 : viewport.height / scroller.offsetHeight;
  scroller.scrollTop += (target.top - viewport.top) / (scale || 1) - Math.min(96, viewport.height / 4);
  // One flash at a time, restarted when it's the same item again.
  if (flashed !== null) {
    clearTimeout(flashed.timer);
    flashed.box.removeAttribute("data-found");
  }
  void (box as HTMLElement).offsetWidth;
  box.setAttribute("data-found", "");
  flashed = { box, timer: setTimeout(() => box.removeAttribute("data-found"), 2000) };
  return true;
}

let marksStyled = false;

/** How what matched looks: a sheet of its own, since the CSS build doesn't know `::highlight()` yet. */
function styleMarks(): void {
  if (marksStyled) return;
  marksStyled = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    `::highlight(${HIGHLIGHT}) { background-color: color-mix(in oklab, var(--warning) 45%, transparent); color: inherit; }`,
  );
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/** Forget the marks a jump left (the search closed). */
export function clearHitMarks(): void {
  if ("highlights" in CSS) CSS.highlights.delete(HIGHLIGHT);
}

/** Where the query is in an element's text, as the server matches it (one text node at a time). */
function matchRanges(root: Element, query: string): Range[] {
  const pattern = searchPattern(query, "giu");
  if (pattern === null) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null && ranges.length < 100; node = walker.nextNode()) {
    for (const found of (node.textContent ?? "").matchAll(pattern)) {
      const range = document.createRange();
      range.setStart(node, found.index);
      range.setEnd(node, found.index + found[0].length);
      ranges.push(range);
    }
  }
  return ranges;
}
