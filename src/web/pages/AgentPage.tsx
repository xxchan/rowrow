// One agent: who it is and what it's doing, the transcript, and the composer. Seeing the
// latest turn here (visible, focused window) marks it seen, which clears its `done`
// attention on every device (docs/decisions.md, D-008).
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  ArrowDown,
  Archive,
  ArchiveRestore,
  Ellipsis,
  FileDiff,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Power,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStickToBottom } from "use-stick-to-bottom";
import type { AgentState, AppState } from "../../shared/schemas.ts";
import { ChangesView } from "../components/ChangesView.tsx";
import { Composer } from "../components/Composer.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { SelectionComment } from "../components/SelectionComment.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { statusDot, title } from "../lib/format.ts";
import { useLooking } from "../lib/presence.ts";
import { navigate, type Route } from "../lib/router.ts";
import { loadOlder, useApp, useClient, useTranscript } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { useNarrow } from "../lib/use-narrow.ts";
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
  const { summary } = agent;
  const ws = state.workspaces[summary.workspaceId];
  const dot = statusDot(agent, now);
  const head = transcript.timeline.headSeq;
  const [renaming, setRenaming] = useState(false);

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

  const [showChanges, setShowChanges] = useState(() => !narrow && localStorage.getItem(CHANGES_KEY) === "1");
  const toggleChanges = (): void => {
    if (!narrow) localStorage.setItem(CHANGES_KEY, showChanges ? "0" : "1");
    setShowChanges(!showChanges);
  };
  const changed = ws?.git?.changed ?? 0;

  const act = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      toast.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      report("warn", "agent.action_failed", error, { action: label, agentId: agent.id });
    }
  };

  const model = summary.reportedModel ?? summary.model;
  const runtime = state.runtimes[summary.runtime]?.name ?? summary.runtime;
  const branch = ws?.git?.branch;
  const facts = [
    runtime,
    model,
    summary.reportedEffort ?? summary.effort,
    ws === undefined
      ? null
      : `${ws.label}${branch === null || branch === undefined || branch === ws.label ? "" : ` (${branch})`}`,
    summary.usage === null ? null : `${formatTokens(summary.usage.input + summary.usage.output)} tokens`,
  ].filter((fact): fact is string => fact !== null && fact !== undefined);

  const chat = <Chat agent={agent} />;
  return (
    <>
      <PageHeader
        route={route}
        title={title(agent)}
        status={<StatusDot tone={dot.tone} label={dot.label} pulsing={dot.pulsing} />}
        subtitle={`${dot.label} · ${facts.join(" · ")}`}
        actions={
          <>
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
              <DropdownMenuContent align="end" className="w-56">
                {ws !== undefined && (
                  <DropdownMenuItem onSelect={() => navigate(`/w/${ws.id}`)}>
                    <FolderOpen /> Open workspace {ws.label}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                {summary.run !== null && client !== null && (
                  <DropdownMenuItem
                    onSelect={() => void act("Stop", () => client.agents.stop({ agentId: agent.id }))}
                  >
                    <Power /> Stop the agent process
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {client !== null && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void act(summary.archived ? "Unarchive" : "Archive", () =>
                        client.agents.update({ agentId: agent.id, archived: !summary.archived }),
                      )
                    }
                  >
                    {summary.archived ? <ArchiveRestore /> : <Archive />}
                    {summary.archived ? "Unarchive" : "Archive"}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <div className="min-h-0 flex-1">
        {showChanges && !narrow && ws !== undefined ? (
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={savedLayout()}
            onLayoutChanged={(layout) => localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))}
          >
            <ResizablePanel id="chat" minSize={360}>
              {chat}
            </ResizablePanel>
            <ResizableHandle aria-label="Resize the changes panel" />
            <ResizablePanel id="changes" defaultSize={520} minSize={320} maxSize={1100}>
              <section aria-label="Changes" className="h-full min-h-0 overflow-hidden bg-sidebar/40">
                <ChangesView workspaceId={ws.id} agentId={agent.id} />
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          chat
        )}
      </div>
      {narrow && ws !== undefined && (
        <Sheet open={showChanges} onOpenChange={setShowChanges}>
          <SheetContent side="bottom" className="h-[88dvh] gap-0 rounded-t-2xl p-0">
            <SheetHeader className="border-b px-4 py-3">
              <SheetTitle>Changes</SheetTitle>
              <SheetDescription className="sr-only">What changed in {ws.label}</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChangesView workspaceId={ws.id} agentId={agent.id} onDelivered={() => setShowChanges(false)} />
            </div>
          </SheetContent>
        </Sheet>
      )}
      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        current={summary.title ?? ""}
        onRename={(next) =>
          client === null
            ? undefined
            : void act("Rename", () =>
                client.agents.update({ agentId: agent.id, title: next === "" ? null : next }),
              )
        }
      />
    </>
  );
}

function savedLayout(): Record<string, number> | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    return value !== null && typeof value === "object" ? (value as Record<string, number>) : undefined;
  } catch {
    return undefined;
  }
}

/** The conversation, stuck to the bottom while the agent writes, and the composer under it. */
function Chat({ agent }: { agent: AgentState }) {
  const client = useClient();
  const transcript = useTranscript(agent.id);
  const chatRef = useRef<HTMLDivElement>(null);
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-4 md:px-6">
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
            <Transcript timeline={transcript.timeline} runtime={agent.summary.runtime} />
          )}
        </div>
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
      <Composer agent={agent} />
      <SelectionComment container={chatRef} workspaceId={agent.summary.workspaceId} agentId={agent.id} />
    </div>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  current,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  onRename: (title: string) => void;
}) {
  const [value, setValue] = useState(current);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setValue(current);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onRename(value.trim());
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename agent</DialogTitle>
            <DialogDescription>Leave it empty to name it after its first message.</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Title"
            value={value}
            autoFocus
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function formatTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);
}
