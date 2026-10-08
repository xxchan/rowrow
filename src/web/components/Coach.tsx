// Coach (docs/decisions.md, D-044), rowrow's assistant, as roamgate's Ranger looks and behaves
// (notes: ranger-spec.md, sections 1 and 2): a button in every page's header (⌘⌥⇧A), a window
// floating at the right, pinned beside the page (under it when the page is narrow) or
// maximized over it, full screen on a phone. Its chat is an agent's transcript (the same fold),
// its composer sends with coach.send, and its settings say which workspaces it may read and
// what it runs on. Closing it never stops it: the button's dot says it works.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  History,
  LoaderCircle,
  Maximize2,
  Megaphone,
  Minimize2,
  Pin,
  PinOff,
  Plus,
  Send,
  Settings,
  Square,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { canCoach, CANT_COACH, COACH_TOOLS_LEAKED, type CoachChat } from "../../shared/coach.ts";
import { newInputId } from "../../shared/ids.ts";
import type { AgentState, AppState, CoachSettings, ModelInfo } from "../../shared/schemas.ts";
import type { Timeline } from "../../shared/timeline.ts";
import {
  closeCoach,
  COACH_MIN_WIDTH,
  COACH_WIDTH,
  PAGE_MIN_WIDTH,
  setCoachLayout,
  STACK_WIDTH,
  toggleCoach,
  useCoach,
} from "../lib/coach.ts";
import {
  loadOlder,
  setDraft,
  useApp,
  useClient,
  useConnection,
  useDrafts,
  useTranscript,
} from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { useNarrow } from "../lib/use-narrow.ts";
import { CoachWave } from "./CoachWave.tsx";
import { Transcript } from "./Transcript.tsx";

/** In every page's header: opens and closes Coach; a dot while it works. */
export function CoachButton() {
  const open = useCoach((s) => s.open);
  const working = useApp((s) => s.state?.coach.chat?.summary.status.kind === "running");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={open ? "secondary" : "ghost"}
          size="sm"
          className="relative [&_svg:not([class*='size-'])]:size-4 md:[&_svg:not([class*='size-'])]:size-[15px]"
          aria-label={working ? "Coach is working" : "Open Coach"}
          aria-pressed={open}
          data-coach-button
          onClick={toggleCoach}
        >
          <Megaphone />
          <span className="hidden md:inline">Coach</span>
          {working && (
            <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Coach (⌘⌥⇧A)</TooltipContent>
    </Tooltip>
  );
}

/** Where Coach's window lives, beside the page (Shell): its layout, size and shortcut. */
export function CoachDock() {
  const { mounted, open, maximized, layout, width } = useCoach();
  const narrow = useNarrow();
  const ref = useRef<HTMLElement>(null);
  const [host, setHost] = useState(Number.POSITIVE_INFINITY);

  // ⌘⌥⇧A (Ctrl+Alt+Shift+A elsewhere), anywhere but while typing.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey || !event.shiftKey || event.code !== "KeyA")
        return;
      if (event.repeat || editable(event.target)) return;
      event.preventDefault();
      toggleCoach();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // How wide the page area is: pinned in a narrow one, Coach goes under the page.
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!mounted || parent === null || parent === undefined) return;
    const observer = new ResizeObserver(() => setHost(parent.clientWidth));
    observer.observe(parent);
    return () => observer.disconnect();
  }, [mounted]);

  const big = narrow || maximized;
  const pinned = open && !big && layout === "pinned";
  const stacked = pinned && host <= STACK_WIDTH;
  useEffect(() => useCoach.setState({ stacked }), [stacked]);

  if (!mounted) return null;
  return (
    <aside
      ref={ref}
      aria-label="Coach"
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        !open && "hidden",
        narrow && "fixed inset-0 z-50",
        !narrow && maximized && "absolute inset-0 z-30",
        pinned && "relative shrink-0 rounded-[10px] border",
        pinned && (stacked ? "mx-2 mb-2 basis-[45%]" : "my-2 mr-2 ml-2"),
        open && !big && !pinned && "absolute top-2 right-2 bottom-2 z-20 rounded-[10px] border shadow-lg",
      )}
      style={
        big || stacked ? undefined : pinned ? { width } : { width: `min(${width}px, calc(100% - 1rem))` }
      }
    >
      {pinned && !stacked && <Resizer dock={ref} />}
      <CoachPanel narrow={narrow} />
    </aside>
  );
}

/** The pinned window's left edge: drag, arrows, Home/End; a double click puts it back to 380 px. */
function Resizer({ dock }: { dock: RefObject<HTMLElement | null> }) {
  const width = useCoach((s) => s.width);
  const max = (): number =>
    Math.max(COACH_WIDTH, (dock.current?.parentElement?.clientWidth ?? 0) - PAGE_MIN_WIDTH);
  const set = (next: number): void =>
    useCoach.setState({ width: Math.round(Math.min(max(), Math.max(COACH_MIN_WIDTH, next))) });
  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const from = event.clientX;
    const was = width;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => set(was + (from - e.clientX));
    const up = (): void => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Coach"
      aria-valuenow={width}
      aria-valuemin={COACH_MIN_WIDTH}
      tabIndex={0}
      title="Drag to resize Coach; double-click to reset"
      onPointerDown={start}
      onDoubleClick={() => set(COACH_WIDTH)}
      onKeyDown={(event) => {
        const by = { ArrowLeft: 24, ArrowRight: -24 }[event.key];
        if (by !== undefined) set(width + by);
        else if (event.key === "Home") set(COACH_MIN_WIDTH);
        else if (event.key === "End") set(max());
        else return;
        event.preventDefault();
      }}
      className="absolute inset-y-0 left-0 z-10 w-[7px] cursor-col-resize touch-none outline-none hover:bg-primary/40 focus-visible:bg-primary/40"
    />
  );
}

function CoachPanel({ narrow }: { narrow: boolean }) {
  const state = useApp((s) => s.state) as AppState;
  const connection = useConnection((s) => s.status);
  const { open, maximized, layout, view, error } = useCoach();
  const chat = state.coach.chat;
  const working = chat?.summary.status.kind === "running";
  const status = connection.kind !== "open" ? "Reconnecting" : working ? "Working" : "Idle";
  // A dialog or menu of the panel takes Escape for itself.
  const [layers, setLayers] = useState(0);
  const layer = (isOpen: boolean): void => setLayers((n) => Math.max(0, n + (isOpen ? 1 : -1)));

  // Settings first when Coach can't run at all yet.
  const usable = runtimeProblem(state) === null;
  const opened = useRef(false);
  useEffect(() => {
    if (!open || opened.current) return;
    opened.current = true;
    if (!usable) useCoach.setState({ view: "settings" });
  }, [open, usable]);

  return (
    // Keys stay in Coach: typing here never reaches the page's shortcuts.
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Escape" || event.nativeEvent.isComposing || layers > 0 || event.defaultPrevented)
          return;
        event.preventDefault();
        if (maximized && !narrow) useCoach.setState({ maximized: false });
        else closeCoach();
      }}
    >
      <header className="flex min-h-12 shrink-0 items-center gap-1.5 border-b bg-muted/40 px-2.5 py-2">
        <div className="grid min-w-0 flex-1 gap-[3px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <strong
              className="text-[13px] leading-4 font-semibold"
              title="Experimental assistant for your agents"
            >
              Coach
            </strong>
            <span className="rounded-[4px] border px-[5px] py-px text-[9px] leading-[1.3] whitespace-nowrap text-muted-foreground">
              Experimental
            </span>
          </div>
          <span role="status" className="truncate text-[10px] text-muted-foreground" title={status}>
            {status}
          </span>
        </div>
        {!narrow && !maximized && (
          <HeaderButton
            label={layout === "floating" ? "Pin Coach" : "Float Coach"}
            tip={layout === "floating" ? "Fixed layout" : "Floating layout"}
            pressed={layout === "pinned"}
            onClick={() => setCoachLayout(layout === "floating" ? "pinned" : "floating")}
          >
            {layout === "floating" ? <Pin /> : <PinOff />}
          </HeaderButton>
        )}
        {!narrow && (
          <HeaderButton
            label={maximized ? "Restore Coach" : "Maximize Coach"}
            tip={maximized ? "Restore window" : "Maximize window"}
            pressed={maximized}
            onClick={() => useCoach.setState({ maximized: !maximized })}
          >
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </HeaderButton>
        )}
        <HeaderButton
          label="Coach settings"
          tip="Runtime and workspace permissions"
          pressed={view === "settings"}
          onClick={() => useCoach.setState({ view: view === "settings" ? "chat" : "settings" })}
        >
          <Settings />
        </HeaderButton>
        <HeaderButton label="Close Coach" tip="Close" onClick={closeCoach}>
          <X />
        </HeaderButton>
      </header>
      {error !== null && (
        <div
          role="alert"
          className="grid gap-[5px] bg-destructive/10 px-3 py-[9px] text-[11px] text-destructive"
        >
          <span className="[overflow-wrap:anywhere]">{error}</span>
          <Button
            variant="ghost"
            size="xs"
            className="justify-self-start text-[11px]"
            onClick={() => useCoach.setState({ error: null })}
          >
            <X /> Dismiss
          </Button>
        </div>
      )}
      {view === "settings" ? (
        <CoachSettingsView state={state} wide={maximized && !narrow} narrow={narrow} />
      ) : (
        <CoachChatView
          state={state}
          chat={chat}
          wide={maximized && !narrow}
          compact={narrow || (!maximized && layout === "floating")}
          narrow={narrow}
          onLayer={layer}
        />
      )}
    </div>
  );
}

function HeaderButton({
  label,
  tip,
  pressed,
  onClick,
  children,
}: {
  label: string;
  tip: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          aria-label={label}
          {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

/** Why Coach can't run on what its settings say, or null. */
function runtimeProblem(state: AppState): string | null {
  const id = state.settings.coach.runtime;
  const info = state.runtimes[id];
  if (!canCoach(id)) return CANT_COACH;
  if (info === undefined || !info.installed) return `${info?.name ?? id} isn't installed here.`;
  return null;
}

/** The allowed workspaces that are still there: what the next message may read. */
function allowedWorkspaces(state: AppState): string[] {
  return state.settings.coach.workspaces.filter((id) => {
    const ws = state.workspaces[id];
    return ws !== undefined && !ws.archived && !ws.missing;
  });
}

function CoachChatView({
  state,
  chat,
  wide,
  compact,
  narrow,
  onLayer,
}: {
  state: AppState;
  chat: AgentState | null;
  wide: boolean;
  /** The floating window or a phone: less room beside the conversation. */
  compact: boolean;
  narrow: boolean;
  onLayer: (open: boolean) => void;
}) {
  const client = useClient();
  const history = useCoach((s) => s.history);
  const [confirming, setConfirming] = useState(false);
  const working = chat?.summary.status.kind === "running";
  const idle = client !== null && !working;
  const problem = runtimeProblem(state);
  const notice =
    problem !== null
      ? `${problem} Choose a runtime in Coach's settings.`
      : allowedWorkspaces(state).length === 0
        ? "Allow workspaces in Coach's settings to send messages."
        : null;
  const runtimeId = chat?.summary.runtime ?? state.settings.coach.runtime;
  const runtimeName = state.runtimes[runtimeId]?.name ?? runtimeId;
  const model =
    (chat === null ? null : (chat.summary.reportedModel ?? chat.summary.model)) ??
    state.settings.coach.model ??
    "Default model";

  const newChat = async (): Promise<void> => {
    if (client === null) return;
    try {
      await client.coach.newChat();
      useCoach.setState({ history: false });
    } catch (error) {
      useCoach.setState({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2.5 py-1.5 text-[10px] text-muted-foreground">
        <div className="grid min-w-0 flex-1">
          <strong className="truncate text-[11px] font-semibold text-foreground">
            {chat?.summary.title ?? "New chat"}
          </strong>
          <span className="truncate" title={`${runtimeName} / ${model}`}>
            {model}
          </span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="min-h-11 text-[11px] text-muted-foreground md:min-h-6 [&_svg]:size-[13px]"
          disabled={!idle}
          aria-label="Coach chat history"
          aria-expanded={history}
          onClick={() => useCoach.setState({ history: !history })}
        >
          <History /> History
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="min-h-11 text-[11px] text-muted-foreground md:min-h-6 [&_svg]:size-[13px]"
          disabled={!idle || chat === null}
          onClick={() => {
            setConfirming(true);
            onLayer(true);
          }}
        >
          <Plus /> New chat
        </Button>
      </div>
      {notice !== null && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-3 py-[9px] text-[11px] text-muted-foreground">
          <span className="min-w-0">{notice}</span>
          <Button
            variant="ghost"
            size="xs"
            className="min-h-11 shrink-0 text-[11px] md:min-h-6 [&_svg]:size-[13px]"
            onClick={() => useCoach.setState({ view: "settings" })}
          >
            <Settings /> Coach settings
          </Button>
        </div>
      )}
      {history && <HistoryDrawer current={chat?.id ?? null} />}
      {chat === null ? (
        <div className="flex min-h-[180px] flex-1 flex-col items-center justify-center gap-2 p-[22px] text-center text-muted-foreground">
          <Megaphone className="size-6" aria-hidden />
          <strong className="text-[13px] font-semibold text-foreground">
            What would you like to work on?
          </strong>
          <span className="text-[11px] leading-normal">
            Ask about progress or changes in the workspaces you allow Coach to read.
          </span>
        </div>
      ) : (
        <Conversation chat={chat} wide={wide} compact={compact} />
      )}
      <Composer
        state={state}
        chat={chat}
        canSend={notice === null}
        wide={wide}
        narrow={narrow}
        onLayer={onLayer}
      />
      <AlertDialog
        open={confirming}
        onOpenChange={(isOpen) => {
          setConfirming(isOpen);
          if (!isOpen) onLayer(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new Coach chat?</AlertDialogTitle>
            <AlertDialogDescription>
              The current chat will be saved in History. Your runtime and workspace permissions stay saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void newChat()}>New chat</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Conversation({ chat, wide, compact }: { chat: AgentState; wide: boolean; compact: boolean }) {
  const client = useClient();
  const transcript = useTranscript(chat.id);
  const follow = useCoach((s) => s.follow);
  const { scrollRef, contentRef, stopScroll, scrollToBottom } = useStickToBottom({
    initial: "instant",
    resize: "smooth",
  });
  const blocks = transcript.timeline.blocks.length;
  // Sending follows the conversation's end again.
  useEffect(() => {
    if (follow > 0) void scrollToBottom();
  }, [follow, scrollToBottom]);
  // Loading earlier messages keeps what you're reading where it is.
  const anchor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (anchor.current === null || scroller === null || blocks === 0) return;
    scroller.scrollTop = scroller.scrollHeight - anchor.current;
    anchor.current = null;
  }, [blocks, scrollRef]);
  const older = (): void => {
    const scroller = scrollRef.current;
    if (client === null || scroller === null) return;
    stopScroll();
    anchor.current = scroller.scrollHeight - scroller.scrollTop;
    void loadOlder(client, chat.id);
  };
  const leak = leakedNotice(transcript.timeline);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {leak !== null && (
        <p
          role="alert"
          className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
        >
          {leak}
        </p>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div
          ref={contentRef}
          className={cn(
            "grid content-start gap-[18px] py-3 pl-3",
            blocks === 0 ? "pr-3" : compact ? "pr-9" : "pr-[52px]",
            wide && "mx-auto w-full max-w-[960px]",
          )}
        >
          {transcript.hasMore && (
            <Button
              variant="ghost"
              size="xs"
              className="justify-self-center text-[11px] text-muted-foreground"
              disabled={transcript.loadingOlder}
              onClick={older}
            >
              {transcript.loadingOlder && <LoaderCircle className="animate-spin" />} Earlier messages
            </Button>
          )}
          {blocks === 0 ? (
            transcript.loading && (
              <p
                role="status"
                className="flex items-center justify-center gap-2 py-10 text-[11px] text-muted-foreground"
              >
                <LoaderCircle className="size-3.5 animate-spin" /> Loading the conversation
              </p>
            )
          ) : (
            <Transcript timeline={transcript.timeline} runtime={chat.summary.runtime} coach />
          )}
        </div>
      </div>
      {blocks > 0 && (
        <CoachWave
          key={chat.id}
          scrollRef={scrollRef}
          contentRef={contentRef}
          compact={compact}
          onNavigate={stopScroll}
        />
      )}
    </div>
  );
}

/**
 * What the server found when the latest run said which tools it has, if any beside rowrow's
 * (its host.error after that run started): Coach's tools being off is never taken on trust.
 */
function leakedNotice(timeline: Timeline): string | null {
  const blocks = timeline.blocks;
  const lastRun = blocks.findLastIndex((block) => block.kind === "run");
  const notice = blocks
    .slice(lastRun === -1 ? 0 : lastRun)
    .findLast(
      (block) =>
        block.kind === "notice" &&
        block.entry.kind === "host.error" &&
        block.entry.code === COACH_TOOLS_LEAKED,
    );
  return notice?.kind === "notice" && notice.entry.kind === "host.error" ? notice.entry.message : null;
}

/** Earlier chats, inline above the conversation: open one to carry on with it. */
function HistoryDrawer({ current }: { current: string | null }) {
  const client = useClient();
  const [chats, setChats] = useState<CoachChat[] | null>(null);
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await client.coach.chats();
        if (!cancelled) setChats(list);
      } catch (error) {
        report("warn", "coach.chats_failed", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);
  const open = async (chatId: string): Promise<void> => {
    if (client === null) return;
    try {
      await client.coach.open({ chatId });
      useCoach.setState({ history: false, follow: useCoach.getState().follow + 1 });
    } catch (error) {
      useCoach.setState({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <section
      aria-label="History"
      className="max-h-[min(240px,35vh)] shrink-0 overflow-y-auto overscroll-contain border-b px-3 py-2"
    >
      <div className="mb-[5px] flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold">History</h3>
        <Button
          variant="ghost"
          size="xs"
          className="min-h-11 text-[11px] text-muted-foreground md:min-h-6"
          onClick={() => useCoach.setState({ history: false })}
        >
          <ChevronLeft /> Chat
        </Button>
      </div>
      {chats === null ? (
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" /> Loading chats
        </p>
      ) : chats.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No saved chats yet. Your conversations are saved automatically.
        </p>
      ) : (
        <ul className="grid gap-1">
          {chats.map((chat) => {
            const isCurrent = chat.id === current;
            return (
              <li key={chat.id}>
                <button
                  type="button"
                  disabled={isCurrent}
                  onClick={() => void open(chat.id)}
                  className={cn(
                    "grid min-h-11 w-full gap-0.5 rounded-md border px-2 py-1.5 text-left hover:bg-accent md:min-h-0",
                    isCurrent && "border-primary/40 bg-primary/10",
                  )}
                >
                  <span className="truncate text-[11px] font-medium">{chat.title ?? "New chat"}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {isCurrent
                      ? "Current"
                      : `${new Date(chat.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${chat.messages} ${chat.messages === 1 ? "message" : "messages"}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ─── Composer ─────────────────────────────────────────────────────────────────

function Composer({
  state,
  chat,
  canSend,
  wide,
  narrow,
  onLayer,
}: {
  state: AppState;
  chat: AgentState | null;
  canSend: boolean;
  wide: boolean;
  narrow: boolean;
  onLayer: (open: boolean) => void;
}) {
  const client = useClient();
  const key = `coach:${chat?.id ?? "new"}`;
  const draft = useDrafts((s) => s.byAgent[key] ?? "");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { open, view } = useCoach();
  const working = chat?.summary.status.kind === "running";
  const settings = state.settings.coach;
  // What the next message runs with, when it isn't what this turn runs with.
  const changed =
    working &&
    chat !== null &&
    (chat.summary.model !== settings.model || chat.summary.effort !== settings.effort);

  // Ready to type whenever the chat shows.
  useEffect(() => {
    if (open && view === "chat") inputRef.current?.focus();
  }, [open, view]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (client === null || text === "" || sending || working || !canSend) return;
    setSending(true);
    useCoach.setState({ error: null });
    try {
      await client.coach.send({ inputId: newInputId(), text, chatId: chat?.id ?? null });
      setDraft(key, "");
      useCoach.setState({ follow: useCoach.getState().follow + 1 });
    } catch (failure) {
      useCoach.setState({ error: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setSending(false);
    }
  };
  const stop = async (): Promise<void> => {
    if (client === null || chat === null) return;
    try {
      await client.agents.abort({ agentId: chat.id });
    } catch (failure) {
      report("warn", "coach.stop_failed", failure);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) void send();
  };
  const disabled = client === null || !canSend || sending || draft.trim() === "";
  const action = working ? (
    <Button
      type="button"
      variant="secondary"
      aria-label="Stop"
      title="Stop Coach's answer"
      // Tapping it keeps the keyboard up.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void stop()}
      className={cn(
        "shrink-0",
        narrow
          ? "absolute right-1.5 bottom-1.5 size-11 [&_svg]:size-4"
          : "h-[30px] min-w-[68px] text-[11px] [&_svg]:size-[13px]",
      )}
    >
      <Square className="fill-current" />
      {!narrow && "Stop"}
    </Button>
  ) : (
    <Button
      type="submit"
      aria-label="Send"
      title="Send message"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      className={cn(
        "shrink-0",
        narrow
          ? "absolute right-1.5 bottom-1.5 size-11 [&_svg]:size-4"
          : "h-[30px] min-w-[68px] text-[11px] [&_svg]:size-[13px]",
      )}
    >
      {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
      {!narrow && "Send"}
    </Button>
  );

  return (
    <form
      className={cn(
        "grid shrink-0 gap-2 border-t bg-muted/40 px-2.5 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]",
        wide && "px-[max(16px,calc((100%-960px)/2))]",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="relative">
        <textarea
          ref={inputRef}
          aria-label="Message Coach"
          placeholder="Ask about your agents"
          rows={3}
          maxLength={20_000}
          {...(narrow ? { enterKeyHint: "send" as const } : {})}
          value={draft}
          onChange={(event) => setDraft(key, event.currentTarget.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "block max-h-40 min-h-[70px] w-full resize-y rounded-md border bg-background p-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring md:text-xs",
            narrow && "pr-[58px]",
          )}
        />
        {/* On a phone, Send sits in the box. */}
        {narrow && action}
      </div>
      {!narrow && (
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[9px] text-muted-foreground">
            {working ? "Coach is working" : "Enter to send, Shift+Enter for a new line"}
          </span>
          {action}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <ModelPills state={state} inputRef={inputRef} narrow={narrow} onLayer={onLayer} />
        {changed && <span className="px-[5px] text-[10px] text-muted-foreground">Next message</span>}
      </div>
    </form>
  );
}

const models = new Map<string, Promise<{ models: ModelInfo[]; error: string | null }>>();

/** A runtime's models, asked once per page. */
function useModels(runtime: string): { models: ModelInfo[]; error: string | null } | null {
  const client = useClient();
  const [loaded, setLoaded] = useState<{
    runtime: string;
    result: { models: ModelInfo[]; error: string | null };
  } | null>(null);
  useEffect(() => {
    if (client === null || !canCoach(runtime)) return;
    let cancelled = false;
    let pending = models.get(runtime);
    if (pending === undefined) {
      pending = client.runtimes.models({ runtime });
      models.set(runtime, pending);
    }
    const asked = pending;
    void (async () => {
      let result: { models: ModelInfo[]; error: string | null };
      try {
        result = await asked;
      } catch (error) {
        models.delete(runtime);
        result = { models: [], error: error instanceof Error ? error.message : String(error) };
      }
      if (!cancelled) setLoaded({ runtime, result });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, runtime]);
  return loaded?.runtime === runtime ? loaded.result : null;
}

const LEVELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};
const levelName = (level: string): string => LEVELS[level] ?? level;

/** Model and thinking effort for the next message, saved for every device at once. */
function ModelPills({
  state,
  inputRef,
  narrow,
  onLayer,
}: {
  state: AppState;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  narrow: boolean;
  onLayer: (open: boolean) => void;
}) {
  const client = useClient();
  const settings = state.settings.coach;
  const runtimeName = state.runtimes[settings.runtime]?.name ?? settings.runtime;
  const loaded = useModels(settings.runtime);
  const [picking, setPicking] = useState(false);
  const list = loaded?.models ?? [];
  const model = list.find((m) => m.id === settings.model);
  const levels = settings.model === null ? (list[0]?.effortLevels ?? []) : (model?.effortLevels ?? []);
  const modelLabel =
    settings.model === null
      ? "Default model"
      : (model?.name ?? `${settings.model}${loaded === null ? "" : " (unavailable)"}`);
  const defaultLevel = (settings.model === null ? null : model?.defaultEffort) ?? null;
  const effortLabel =
    settings.effort === null
      ? levelName(defaultLevel ?? "Default")
      : levels.includes(settings.effort)
        ? levelName(settings.effort)
        : `Unavailable (${levelName(settings.effort)})`;
  const save = async (change: Partial<CoachSettings>): Promise<void> => {
    if (client === null) return;
    try {
      await client.settings.update({ coach: { ...settings, ...change } });
    } catch (error) {
      report("warn", "coach.settings_failed", error);
    }
    inputRef.current?.focus({ preventScroll: true });
  };
  const pill = cn(
    "max-w-full min-w-0 gap-1 rounded-full border-transparent bg-transparent px-[9px] py-[5px] text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground",
    narrow ? "min-h-11" : "h-auto min-h-[30px]",
  );
  return (
    <>
      <Popover
        open={picking}
        onOpenChange={(isOpen) => {
          setPicking(isOpen);
          onLayer(isOpen);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className={cn(pill, "max-w-[65%]")}
            aria-label={`Model: ${modelLabel}`}
            title={`${modelLabel} (${runtimeName}). Changes apply to the next message.`}
          >
            <span className="truncate">{modelLabel}</span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-[min(340px,calc(100vw-16px))] p-0">
          <Command>
            <CommandInput placeholder="Search models" />
            <CommandList>
              {loaded === null ? (
                <p className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" /> Loading models
                </p>
              ) : (
                <>
                  <CommandEmpty>{loaded.error ?? "No models found"}</CommandEmpty>
                  <CommandGroup>
                    <CommandItem
                      value="__default"
                      keywords={["Default", runtimeName]}
                      onSelect={() => {
                        setPicking(false);
                        onLayer(false);
                        void save({ model: null, effort: null });
                      }}
                    >
                      Default
                      <span className="ml-auto text-xs text-muted-foreground">{runtimeName}</span>
                      {settings.model === null && <Check />}
                    </CommandItem>
                    {list.map((m) => (
                      <CommandItem
                        key={m.id}
                        value={m.id}
                        keywords={[m.name, runtimeName]}
                        onSelect={() => {
                          setPicking(false);
                          onLayer(false);
                          // An effort the new model doesn't take goes back to its default.
                          const keep = settings.effort !== null && m.effortLevels.includes(settings.effort);
                          void save({ model: m.id, effort: keep ? settings.effort : null });
                        }}
                      >
                        {m.name}
                        <span className="ml-auto text-xs text-muted-foreground">{runtimeName}</span>
                        {m.id === settings.model && <Check />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {levels.length < 2 ? (
        <Button
          type="button"
          variant="ghost"
          className={pill}
          disabled
          title="This model has no adjustable thinking effort"
        >
          Thinking unavailable
        </Button>
      ) : (
        <DropdownMenu onOpenChange={onLayer}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" className={pill}>
              <span className="truncate">{`Thinking: ${effortLabel}`}</span>
              <ChevronDown className="size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuRadioGroup
              value={settings.effort ?? "__default"}
              onValueChange={(value) => void save({ effort: value === "__default" ? null : value })}
            >
              <DropdownMenuRadioItem value="__default">
                {defaultLevel === null ? "Default" : `Default (${levelName(defaultLevel)})`}
              </DropdownMenuRadioItem>
              {levels.map((level) => (
                <DropdownMenuRadioItem key={level} value={level}>
                  {levelName(level)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/** What Coach runs on and which workspaces it may read: changed here, applied with Save. */
function CoachSettingsView({ state, wide, narrow }: { state: AppState; wide: boolean; narrow: boolean }) {
  const client = useClient();
  const connected = useConnection((s) => s.status.kind === "open");
  const working = state.coach.chat?.summary.status.kind === "running";
  const [draft, setDraftSettings] = useState<CoachSettings>(state.settings.coach);
  const [saving, setSaving] = useState(false);
  const runtimes = Object.values(state.runtimes).sort(
    (a, b) => Number(canCoach(b.id)) - Number(canCoach(a.id)) || a.name.localeCompare(b.name),
  );
  const workspaces = Object.values(state.workspaces)
    .filter((ws) => !ws.archived)
    .sort((a, b) => a.label.localeCompare(b.label));
  const allowed = new Set(draft.workspaces);
  const locked = working || !connected || saving;
  const save = async (): Promise<void> => {
    if (client === null) return;
    setSaving(true);
    try {
      const changedRuntime = draft.runtime !== state.settings.coach.runtime;
      // A model and effort belong to their runtime.
      await client.settings.update({
        coach: {
          ...state.settings.coach,
          workspaces: draft.workspaces,
          runtime: draft.runtime,
          ...(changedRuntime ? { model: null, effort: null } : {}),
        },
      });
      useCoach.setState({ view: "chat" });
    } catch (error) {
      useCoach.setState({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };
  const row = cn(
    "flex cursor-pointer items-start gap-[7px] py-[3px] text-xs",
    narrow && "min-h-11 items-center",
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
      <div className={cn("grid content-start gap-2.5", wide && "mx-auto w-full max-w-[720px]")}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold">Runtime</h3>
          <Button
            variant="ghost"
            size="xs"
            className="min-h-11 text-[11px] text-muted-foreground md:min-h-6"
            onClick={() => useCoach.setState({ view: "chat" })}
          >
            <ChevronLeft /> Chat
          </Button>
        </div>
        <p className="text-[11px] leading-normal text-muted-foreground">
          Coach runs on a runtime signed in on this machine, with that runtime's own tools turned off: it only
          reads, through rowrow. Another runtime starts a new chat.
        </p>
        <fieldset disabled={locked} className="grid min-w-0 gap-0.5 disabled:opacity-60">
          <legend className="sr-only">Coach's runtime</legend>
          {runtimes.map((runtime) => {
            const why = !canCoach(runtime.id)
              ? CANT_COACH
              : !runtime.installed
                ? "Not installed here."
                : runtime.auth?.kind === "logged_out"
                  ? "Signed out: sign it in from Settings."
                  : null;
            const usable = canCoach(runtime.id) && runtime.installed;
            return (
              <label key={runtime.id} className={cn(row, !usable && "cursor-default opacity-60")}>
                <input
                  type="radio"
                  name="coach-runtime"
                  className="mt-[3px] shrink-0 accent-primary"
                  checked={draft.runtime === runtime.id}
                  disabled={!usable}
                  onChange={() => setDraftSettings({ ...draft, runtime: runtime.id })}
                />
                <span className="grid min-w-0 [overflow-wrap:anywhere]">
                  {runtime.name}
                  {why !== null && <small className="text-[10px] text-muted-foreground">{why}</small>}
                </span>
              </label>
            );
          })}
        </fieldset>

        <h3 className="pt-1 text-[13px] font-semibold">Allowed workspaces</h3>
        <p className="text-[11px] leading-normal text-muted-foreground">
          Select workspaces Coach may read: none until you do. Each question uses the allowed workspaces that
          are currently available. Workspace status, conversations and diffs may be sent to your model
          provider.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="ghost"
            size="xs"
            className="min-h-11 text-[11px] md:min-h-6"
            disabled={locked || workspaces.length === 0}
            onClick={() => setDraftSettings({ ...draft, workspaces: workspaces.map((ws) => ws.id) })}
          >
            Select all
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="min-h-11 text-[11px] md:min-h-6"
            aria-label="Clear allowed Coach workspaces"
            disabled={locked || allowed.size === 0}
            onClick={() => setDraftSettings({ ...draft, workspaces: [] })}
          >
            Clear
          </Button>
        </div>
        <fieldset
          disabled={locked}
          className="grid max-h-[min(240px,35dvh)] min-w-0 grid-cols-[repeat(auto-fit,minmax(min(130px,100%),1fr))] content-start gap-x-3 gap-y-1.5 overflow-auto overscroll-contain disabled:opacity-60"
        >
          <legend className="sr-only">Allowed workspaces</legend>
          {workspaces.map((ws) => (
            <label key={ws.id} className={row}>
              <input
                type="checkbox"
                className="mt-[3px] shrink-0 accent-primary"
                checked={allowed.has(ws.id)}
                onChange={(event) =>
                  setDraftSettings({
                    ...draft,
                    workspaces: event.currentTarget.checked
                      ? [...draft.workspaces, ws.id]
                      : draft.workspaces.filter((id) => id !== ws.id),
                  })
                }
              />
              <span className="grid min-w-0 [overflow-wrap:anywhere]">
                {ws.label}
                {ws.git !== null && ws.git.branch !== null && ws.git.branch !== ws.label && (
                  <small className="text-[10px] text-muted-foreground">{ws.git.branch}</small>
                )}
              </span>
            </label>
          ))}
          {workspaces.length === 0 && (
            <span className="text-[11px] text-muted-foreground">No workspaces yet.</span>
          )}
        </fieldset>
        <Button
          className="h-[30px] text-[11px]"
          disabled={locked || client === null}
          onClick={() => void save()}
        >
          {saving && <LoaderCircle className="animate-spin" />} Save
        </Button>
      </div>
    </div>
  );
}

function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null)
  );
}
