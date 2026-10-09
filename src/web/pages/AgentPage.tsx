// One agent: who it is and what it's doing, the transcript, and the composer. Seeing the
// latest turn here (visible, focused window) marks it seen, which clears its `done`
// attention on every device (docs/decisions.md, D-008).
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowDown, ChevronsRight, Ellipsis, FileDiff, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { useStickToBottom } from "use-stick-to-bottom";
import type { AgentState, AppState } from "../../shared/schemas.ts";
import { workspaceLabel } from "../../shared/workspaces.ts";
import { openAgentDialog, useAgentActions } from "../components/AgentActions.tsx";
import { MenuActions } from "../components/MenuActions.tsx";
import { needsYou } from "../components/CommandMenu.tsx";
import { Composer } from "../components/Composer.tsx";
import { ConversationWave } from "../components/ConversationWave.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FileLinks } from "../components/FileLinks.tsx";
import {
  Inspector,
  saveInspectorTab,
  savedInspectorTab,
  type InspectorTab,
} from "../components/Inspector.tsx";
import { SelectionComment } from "../components/SelectionComment.tsx";
import { BackgroundTasks } from "../components/BackgroundTasks.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { AgentAvatar } from "../components/AgentIcon.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { onPrefChange, readPref, writePref } from "../lib/device-prefs.ts";
import { onFileOpen } from "../lib/file-links.ts";
import { statusDot, title } from "../lib/format.ts";
import { useLooking } from "../lib/presence.ts";
import { navigate, type Route } from "../lib/router.ts";
import { loadOlder, useApp, useClient, useTranscript } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { useNarrow, useWide } from "../lib/use-narrow.ts";
import { useNow } from "../lib/use-now.ts";

export function AgentPage({ agentId, route }: { agentId: string; route: Route }) {
  const state = useApp((s) => s.state) as AppState;
  const agent = state.agents[agentId];
  if (agent === undefined)
    return (
      <>
        <PageHeader title="No such agent" route={route} />
        <EmptyState title="No such agent" description={`There is no agent ${agentId} on this server.`} />
      </>
    );
  return <AgentView agent={agent} state={state} route={route} />;
}

const CHANGES_KEY = "rowrow.changesOpen";
const LAYOUT_KEY = "rowrow.agentLayout";

function AgentView({ agent, state, route }: { agent: AgentState; state: AppState; route: Route }) {
  const client = useClient();
  const transcript = useTranscript(agent.id);
  const looking = useLooking();
  const now = useNow(5000);
  const narrow = useNarrow();
  const wide = useWide();
  const { summary } = agent;
  const ws = state.workspaces[summary.workspaceId];
  const dot = statusDot(agent, now);
  const head = transcript.timeline.headSeq;
  const actions = useAgentActions(agent, { here: true });
  // The next agent that needs you, one tap away (⌘J on a keyboard).
  const waiting = needsYou(state).filter((a) => a.id !== agent.id);
  const nextUp = waiting[0];

  // Mark seen: the latest entries are on screen, in a window you're looking at.
  useEffect(() => {
    if (client === null || !looking || head <= agent.seenSeq || transcript.loading) return;
    const timer = setTimeout(() => {
      client.agents
        .markSeen({ agentId: agent.id, seq: head })
        .catch((error: unknown) => report("warn", "mark_seen_failed", error));
    }, 400);
    return () => clearTimeout(timer);
  }, [client, looking, head, agent.id, agent.seenSeq, transcript.loading]);

  // Remembered open only where it sits beside the conversation; elsewhere it covers it. Opened,
  // closed or resized there, it is in the app's other tabs too (which tab it shows is per tab).
  const [showChanges, setShowChanges] = useState(() => wide && readPref(CHANGES_KEY) === "1");
  useEffect(() => {
    if (!wide) return;
    return onPrefChange(CHANGES_KEY, () => setShowChanges(readPref(CHANGES_KEY) === "1"));
  }, [wide]);
  const panels = useRef<GroupImperativeHandle | null>(null);
  useEffect(
    () =>
      onPrefChange(LAYOUT_KEY, () => {
        const layout = savedLayout();
        if (layout !== undefined) panels.current?.setLayout(layout);
      }),
    [],
  );
  const [tab, setTab] = useState<InspectorTab>(savedInspectorTab);
  const chooseTab = (next: InspectorTab): void => {
    setTab(next);
    saveInspectorTab(next);
  };
  // The button shows the changes: it opens the inspector there, or switches to them, or closes.
  const toggleChanges = (): void => {
    const open = !showChanges || tab !== "changes";
    chooseTab("changes");
    setShowChanges(open);
    if (wide) writePref(CHANGES_KEY, open ? "1" : "0");
  };
  // A path clicked in the transcript opens the inspector on Files, which shows the file.
  const wsId = ws?.id;
  useEffect(
    () =>
      onFileOpen((request) => {
        if (request.workspaceId !== wsId) return;
        setTab("files");
        saveInspectorTab("files");
        setShowChanges(true);
        if (wide) writePref(CHANGES_KEY, "1");
      }),
    [wsId, wide],
  );
  const changed = ws?.git?.changed ?? 0;

  // Who and where; what it runs on (model, effort, context) sits by the composer.
  const runtime = state.runtimes[summary.runtime]?.name ?? summary.runtime;
  const branch = ws?.git?.branch;
  const facts = [
    runtime,
    ws === undefined
      ? workspaceLabel(state.workspaces, summary.workspaceId)
      : `${ws.label}${branch === null || branch === undefined || branch === ws.label ? "" : ` (${branch})`}`,
  ];

  const chat = <Chat agent={agent} onSwitchModel={() => openAgentDialog("model", agent.id)} />;
  return (
    <>
      <PageHeader
        route={route}
        title={title(agent)}
        onRename={() => openAgentDialog("rename", agent.id)}
        status={
          <AgentAvatar
            runtime={summary.runtime}
            runtimeName={runtime}
            tone={dot.tone}
            label={dot.label}
            pulsing={dot.pulsing}
            size="lg"
          />
        }
        subtitle={`${dot.label} · ${facts.join(" · ")}`}
        actions={
          <>
            <BackgroundTasks tasks={summary.tasks} now={now} />
            {nextUp !== undefined && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    aria-label={`Next agent that needs you: ${title(nextUp)}`}
                    onClick={() => navigate(`/a/${nextUp.id}`)}
                  >
                    <ChevronsRight />
                    <span className="tabular-nums">{waiting.length}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{`Next: ${title(nextUp)} (⌘J)`}</TooltipContent>
              </Tooltip>
            )}
            {ws?.git !== null && ws !== undefined && (
              <Button
                variant={showChanges ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={showChanges}
                aria-label={changed > 0 ? `Changes · ${changed}` : "Changes"}
                onClick={toggleChanges}
              >
                <FileDiff />
                <span className="hidden md:inline">{changed > 0 ? `Changes · ${changed}` : "Changes"}</span>
                {changed > 0 && <span className="tabular-nums md:hidden">{changed}</span>}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Agent actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <MenuActions
                  actions={actions}
                  parts={{ Item: DropdownMenuItem, Separator: DropdownMenuSeparator }}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <div className="min-h-0 flex-1">
        {showChanges && wide && ws !== undefined ? (
          <ResizablePanelGroup
            orientation="horizontal"
            groupRef={panels}
            defaultLayout={savedLayout()}
            // Only what you dragged: a layout applied from another tab isn't written back.
            onLayoutChanged={(layout, { isUserInteraction }) => {
              if (isUserInteraction) writePref(LAYOUT_KEY, JSON.stringify(layout));
            }}
          >
            <ResizablePanel id="chat" minSize={360}>
              {chat}
            </ResizablePanel>
            <ResizableHandle aria-label="Resize the changes panel" />
            <ResizablePanel id="changes" defaultSize={520} minSize={320} maxSize={1100}>
              <section aria-label="Inspector" className="h-full min-h-0 overflow-hidden bg-sidebar/40">
                <Inspector workspaceId={ws.id} agentId={agent.id} tab={tab} onTabChange={chooseTab} />
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          chat
        )}
      </div>
      {!wide && ws !== undefined && (
        <Sheet open={showChanges} onOpenChange={setShowChanges}>
          <SheetContent
            side={narrow ? "bottom" : "right"}
            className={
              narrow ? "h-[88dvh] gap-0 rounded-t-2xl p-0" : "w-[min(560px,90vw)] gap-0 p-0 sm:max-w-none"
            }
          >
            <SheetHeader className="border-b px-4 py-3">
              <SheetTitle>{ws.label}</SheetTitle>
              <SheetDescription className="sr-only">
                Changes, files, history and commands of {ws.label}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-hidden">
              <Inspector
                workspaceId={ws.id}
                agentId={agent.id}
                tab={tab}
                onTabChange={chooseTab}
                onDelivered={() => setShowChanges(false)}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

function savedLayout(): Record<string, number> | undefined {
  try {
    const value: unknown = JSON.parse(readPref(LAYOUT_KEY) ?? "null");
    return value !== null && typeof value === "object" ? (value as Record<string, number>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The conversation, stuck to the bottom while the agent writes, and the composer under it. On
 * a desktop, a wave bar at its right edge maps the messages (roamgate #354): hover to preview
 * one, click or the arrow keys to jump.
 */
function Chat({ agent, onSwitchModel }: { agent: AgentState; onSwitchModel: () => void }) {
  const client = useClient();
  const transcript = useTranscript(agent.id);
  const chatRef = useRef<HTMLDivElement>(null);
  const runtime = useApp((s) => s.state?.runtimes[agent.summary.runtime]?.name ?? agent.summary.runtime);
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } = useStickToBottom({
    initial: "instant",
    resize: "smooth",
  });
  // Loading older turns keeps what you're reading where it is.
  const anchor = useRef<number | null>(null);
  const blocks = transcript.timeline.blocks.length;
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (anchor.current === null || scroller === null || blocks === 0) return;
    scroller.scrollTop = scroller.scrollHeight - anchor.current;
    anchor.current = null;
  }, [blocks, scrollRef]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const older = async (): Promise<void> => {
    const scroller = scrollRef.current;
    if (client === null || scroller === null) return;
    anchor.current = scroller.scrollHeight - scroller.scrollTop;
    setLoadingOlder(true);
    try {
      await loadOlder(client, agent.id);
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div ref={chatRef} className="relative flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className={cn("min-h-0 flex-1 overflow-y-auto", blocks > 0 && "md:pr-11")}>
          <div
            ref={contentRef}
            className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-4 md:px-6"
          >
            {transcript.hasMore && client !== null && (
              <Button
                variant="ghost"
                size="sm"
                className="self-center text-muted-foreground"
                onClick={() => void older()}
              >
                {loadingOlder && <LoaderCircle className="animate-spin" />} Load earlier turns
              </Button>
            )}
            {blocks === 0 ? (
              transcript.loading ? (
                <div
                  role="status"
                  className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
                >
                  <LoaderCircle className="size-4 animate-spin" /> Loading the conversation
                </div>
              ) : (
                <EmptyState
                  title="Nothing yet"
                  description="Write the first message below. The agent starts working in its workspace when it arrives."
                />
              )
            ) : (
              <FileLinks workspaceId={agent.summary.workspaceId}>
                <Transcript timeline={transcript.timeline} runtime={agent.summary.runtime} />
              </FileLinks>
            )}
          </div>
        </div>
        {/* Not on a phone: the transcript needs the width there, and a finger the scrolling. */}
        {blocks > 0 && (
          <ConversationWave
            key={agent.id}
            scrollRef={scrollRef}
            contentRef={contentRef}
            assistant={runtime}
            label="Conversation navigation"
            className="hidden md:flex"
            onNavigate={stopScroll}
          />
        )}
      </div>
      {!isAtBottom && blocks > 0 && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-28 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-md"
          onClick={() => void scrollToBottom()}
        >
          <ArrowDown /> Latest
        </Button>
      )}
      <Composer agent={agent} onSwitchModel={onSwitchModel} />
      <SelectionComment container={chatRef} workspaceId={agent.summary.workspaceId} agentId={agent.id} />
    </div>
  );
}
