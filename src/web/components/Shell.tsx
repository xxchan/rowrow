// The frame every page lives in: an attention-first side nav (PRINCIPLES.md, product 1).
// The agents you pinned come first (D-046); "Needs you" lists the others that are blocked or
// finished unseen; below it, workspaces hold their agents, and linked worktrees nest under
// their repository; archived workspaces wait folded at the bottom (D-047). On a phone the
// nav is a sheet, opened from each page's header (PageHeader), which shows how many
// agents need you. Coach (D-044) opens from every page's header and sits beside the page.
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArchiveRestore,
  ChevronRight,
  Folder,
  FolderGit2,
  GitBranch,
  House,
  Keyboard,
  Menu,
  Pin,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import {
  appName,
  byLastPersonInput,
  byPin,
  type AgentState,
  type AppState,
  type Workspace,
} from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { agentListed, workspaceLabel } from "../../shared/workspaces.ts";
import { useAppName } from "../lib/app-name.ts";
import { statusDot, title } from "../lib/format.ts";
import { navigate, RouterLink, type Route } from "../lib/router.ts";
import { onAttention, onNotification, onTaskNotice, useApp } from "../lib/store.ts";
import { useNarrow } from "../lib/use-narrow.ts";
import { AgentContextMenu, AgentDialogs, openAgentDialog, WorkspaceContextMenu } from "./AgentActions.tsx";
import { openCoachTask, useCoach } from "../lib/coach.ts";
import { CoachButton, CoachDock } from "./Coach.tsx";
import { CommandMenu, needsYou, useCommandMenu } from "./CommandMenu.tsx";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { NewAgentDialog, useNewAgent } from "./NewAgentDialog.tsx";
import { ShortcutsDialog, useShortcuts } from "./ShortcutsDialog.tsx";
import { UpdateBanner } from "./UpdateBanner.tsx";
import { openWorkspaceDialog, useUnarchive, WorkspaceDialogs } from "./WorkspaceActions.tsx";
import { AgentIcon } from "./AgentIcon.tsx";
import { StatusDot } from "./StatusDot.tsx";

/** The phone nav sheet: open only for the route it was opened on, so navigating closes it. */
const useNavSheet = create<{ openOn: Route | null }>(() => ({ openOn: null }));

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const openOn = useNavSheet((s) => s.openOn);
  const narrow = useNarrow();
  // Coach pinned in a narrow page sits under it (D-044).
  const coachStacked = useCoach((s) => s.stacked);
  useAttentionToasts(route);
  useAppBadge();
  useAppName();
  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner />
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        {narrow ? (
          <Sheet
            open={openOn === route}
            onOpenChange={(open) => useNavSheet.setState({ openOn: open ? route : null })}
          >
            <SheetContent side="left" className="w-[86vw] max-w-80 gap-0 border-sidebar-border p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">Agents and workspaces</SheetDescription>
              <Nav route={route} />
            </SheetContent>
          </Sheet>
        ) : (
          <aside className="flex w-64 shrink-0 border-r border-sidebar-border">
            <Nav route={route} />
          </aside>
        )}
        <div className={cn("relative flex min-w-0 flex-1", coachStacked && "flex-col")}>
          <main className="flex min-w-0 flex-1 flex-col">{children}</main>
          <CoachDock />
        </div>
      </div>
      <NewAgentDialog route={route} />
      <CommandMenu route={route} />
      <ShortcutsDialog />
      <AgentDialogs />
      <WorkspaceDialogs />
      <Toaster position="top-center" />
    </div>
  );
}

/**
 * A page's title bar. On a phone it leads with the nav button, badged with how many agents
 * need you (not counting the one on screen), so you always know if someone's waiting. While
 * you type on a phone it folds away (index.css, `data-folds-while-typing`).
 */
export function PageHeader({
  title: heading,
  subtitle,
  status,
  actions,
  route,
  onRename,
}: {
  title: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  route: Route;
  /** Double-clicking the title renames what it names. */
  onRename?: () => void;
}) {
  const state = useApp((s) => s.state);
  const narrow = useNarrow();
  const current = route.name === "agent" ? route.agentId : null;
  const waiting = state === null ? 0 : needsYou(state).filter((a) => a.id !== current).length;
  return (
    <header
      data-folds-while-typing
      data-titlebar
      // With no sidebar, the header is what sits under the Mac app's window buttons.
      {...(narrow ? { "data-traffic-lights": "" } : {})}
      className="flex min-h-14 shrink-0 items-center gap-2 border-b px-2 py-2 md:min-h-12 md:px-4"
    >
      <Button
        variant="ghost"
        size="icon"
        className="relative md:hidden"
        aria-label={waiting > 0 ? `Open navigation (${waiting} need you)` : "Open navigation"}
        onClick={() => useNavSheet.setState({ openOn: route })}
      >
        <Menu />
        {waiting > 0 && (
          <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-white">
            {waiting}
          </span>
        )}
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {status}
        <div className="min-w-0">
          <h1
            className="truncate text-[15px] leading-5 font-semibold md:text-sm"
            {...(onRename === undefined ? {} : renameOnDoubleClick(onRename))}
          >
            {heading}
          </h1>
          {subtitle !== undefined && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <CoachButton />
      </div>
    </header>
  );
}

function Nav({ route }: { route: Route }) {
  const state = useApp((s) => s.state) as AppState;
  const openNewAgent = useNewAgent((s) => s.open);
  const agents = useMemo(
    () => Object.values(state.agents).filter((a) => agentListed(state.workspaces, a)),
    [state.agents, state.workspaces],
  );
  const pinned = useMemo(() => agents.filter((a) => a.pinnedAt !== null).sort(byPin), [agents]);
  const urgent = useMemo(() => needsYou(state).filter((a) => a.pinnedAt === null), [state]);
  const roots = useMemo(
    () =>
      Object.values(state.workspaces)
        .filter((w) => !w.archived && w.parentId === null)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [state.workspaces],
  );
  const archived = useMemo(
    () =>
      Object.values(state.workspaces)
        .filter((w) => w.archived)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [state.workspaces],
  );
  const unarchive = useUnarchive();
  const selectedAgent = route.name === "agent" ? route.agentId : null;
  const selectedWorkspace = route.name === "workspace" ? route.workspaceId : null;

  // The tree's grid: each level indents 16px; a workspace keeps a slot for its chevron.
  const indent = (depth: number): number => 22 + depth * 16;
  // In a workspace a pinned agent leads, marked with the pin; in the Pinned section that's moot.
  const agentRow = (agent: AgentState, depth: number | null, showWorkspace = false): ReactNode => {
    const dot = statusDot(agent);
    const ws = showWorkspace ? workspaceLabel(state.workspaces, agent.summary.workspaceId) : undefined;
    return (
      <AgentContextMenu key={agent.id} agent={agent}>
        <NavRow
          href={`/a/${agent.id}`}
          selected={agent.id === selectedAgent}
          indent={depth === null ? 8 : indent(depth)}
          {...renameOnDoubleClick(() => openAgentDialog("rename", agent.id))}
        >
          <AgentIcon
            runtime={agent.summary.runtime}
            label={state.runtimes[agent.summary.runtime]?.name ?? agent.summary.runtime}
            className="size-3.5"
          />
          <span className="min-w-0 flex-1 truncate">
            {title(agent)}
            {ws !== undefined && <span className="text-muted-foreground"> · {ws}</span>}
          </span>
          {agent.summary.queued.length > 0 && (
            <span
              className={cn(
                "shrink-0 text-[11px] text-muted-foreground tabular-nums",
                agent.summary.queuePaused !== null && "text-warning",
              )}
              title={agent.summary.queuePaused !== null ? "Queue paused" : undefined}
            >
              {agent.summary.queued.length} queued
            </span>
          )}
          {depth !== null && agent.pinnedAt !== null && (
            <Pin aria-label="Pinned" className="size-3 shrink-0 fill-current text-muted-foreground" />
          )}
          <StatusDot tone={dot.tone} label={dot.label} pulsing={dot.pulsing} />
        </NavRow>
      </AgentContextMenu>
    );
  };

  const workspaceRow = (ws: Workspace, depth: number): ReactNode => {
    const worktrees = Object.values(state.workspaces).filter((w) => w.parentId === ws.id && !w.archived);
    const own = agents
      .filter((a) => a.summary.workspaceId === ws.id)
      .sort((a, b) => byPin(a, b) || byLastPersonInput(a, b));
    const worst = [
      ...own,
      ...worktrees.flatMap((c) => agents.filter((a) => a.summary.workspaceId === c.id)),
    ].sort((a, b) => ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention])[0];
    const dot = worst === undefined || worst.attention === "idle" ? null : statusDot(worst);
    const row = (
      <WorkspaceContextMenu workspace={ws}>
        <NavRow
          href={`/w/${ws.id}`}
          selected={ws.id === selectedWorkspace}
          indent={indent(depth)}
          {...renameOnDoubleClick(() => openWorkspaceDialog("rename", ws.id))}
        >
          <WorkspaceIcon ws={ws} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{ws.label}</span>
          {dot !== null && <StatusDot tone={dot.tone} label={dot.label} />}
        </NavRow>
      </WorkspaceContextMenu>
    );
    if (own.length === 0 && worktrees.length === 0) return <div key={ws.id}>{row}</div>;
    return (
      <Collapsible key={ws.id} defaultOpen className="group/ws">
        <div className="relative">
          {row}
          <CollapsibleTrigger
            aria-label={`Show or hide ${ws.label}`}
            className="absolute top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            style={{ left: 4 + depth * 16 }}
          >
            <ChevronRight className="size-3 transition-transform group-data-[state=open]/ws:rotate-90" />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          {own.map((agent) => agentRow(agent, depth + 1))}
          {worktrees.map((child) => workspaceRow(child, depth + 1))}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  return (
    <nav
      aria-label="Agents and workspaces"
      className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground"
    >
      <div data-titlebar data-traffic-lights className="flex items-center gap-2.5 px-3 pt-3 pb-2">
        <RouterLink href="/" className="flex min-w-0 items-center gap-2.5 rounded-md">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
            <RowrowMark />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm leading-4 font-semibold text-foreground">
              {appName(state.settings.instanceName)}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">{state.host.name}</span>
          </span>
        </RouterLink>
      </div>
      <div className="px-3 pb-2">
        <Button size="sm" className="w-full" onClick={() => openNewAgent({})}>
          <Plus /> New agent
          <Kbd
            aria-hidden
            className="ml-auto hidden bg-primary-foreground/15 text-primary-foreground md:inline-flex"
          >
            C
          </Kbd>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <NavRow href="/" selected={route.name === "home"} indent={8}>
          <House className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">All agents</span>
        </NavRow>
        <button
          type="button"
          onClick={() => useCommandMenu.getState().setOpen(true)}
          className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-sidebar-accent md:h-8"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">Go to…</span>
          <Kbd className="hidden md:inline-flex">⌘K</Kbd>
        </button>
        {pinned.length > 0 && (
          <NavSection label="Pinned">{pinned.map((agent) => agentRow(agent, null, true))}</NavSection>
        )}
        {urgent.length > 0 && (
          <NavSection label="Needs you">{urgent.map((agent) => agentRow(agent, null, true))}</NavSection>
        )}
        <NavSection
          label="Workspaces"
          action={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 text-muted-foreground hover:bg-sidebar-accent"
                  aria-label="New workspace"
                  onClick={() => openWorkspaceDialog("add")}
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New workspace</TooltipContent>
            </Tooltip>
          }
        >
          {roots.length === 0 ? (
            <button
              type="button"
              onClick={() => openWorkspaceDialog("add")}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground hover:bg-sidebar-accent md:h-8"
            >
              <Plus className="size-4" /> Add a workspace
            </button>
          ) : (
            roots.map((ws) => workspaceRow(ws, 0))
          )}
        </NavSection>
        {archived.length > 0 && (
          <Collapsible className="group/archived pt-4">
            <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-md px-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase hover:text-foreground">
              <ChevronRight className="size-3 transition-transform group-data-[state=open]/archived:rotate-90" />
              {`Archived · ${archived.length}`}
            </CollapsibleTrigger>
            <CollapsibleContent>
              {archived.map((ws) => (
                <WorkspaceContextMenu key={ws.id} workspace={ws}>
                  <div className="flex items-center gap-0.5 rounded-md pr-1 hover:bg-sidebar-accent">
                    <NavRow
                      href={`/w/${ws.id}`}
                      selected={ws.id === selectedWorkspace}
                      indent={indent(0)}
                      className="min-w-0 flex-1 text-muted-foreground hover:bg-transparent"
                    >
                      <WorkspaceIcon ws={ws} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{ws.label}</span>
                    </NavRow>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 shrink-0 text-muted-foreground hover:bg-sidebar"
                      aria-label={`Unarchive ${ws.label}`}
                      title="Unarchive"
                      onClick={() => unarchive(ws)}
                    >
                      <ArchiveRestore />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 shrink-0 text-muted-foreground hover:bg-sidebar hover:text-destructive"
                      aria-label={`Remove ${ws.label} from rowrow…`}
                      title="Remove from rowrow…"
                      onClick={() => openWorkspaceDialog("remove", ws.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </WorkspaceContextMenu>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-sidebar-border px-2 py-2">
        <div className="min-w-0 flex-1">
          <NavRow href="/settings" selected={route.name === "settings"} indent={8}>
            <Settings className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">Settings</span>
          </NavRow>
        </div>
        {/* Shortcuts need a keyboard: not on a phone. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden text-muted-foreground hover:bg-sidebar-accent md:inline-flex"
              aria-label="Keyboard shortcuts"
              onClick={() => useShortcuts.getState().setOpen(true)}
            >
              <Keyboard />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Keyboard shortcuts <Kbd>?</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}

function WorkspaceIcon({ ws, className }: { ws: Workspace; className: string }) {
  if (ws.git === null) return <Folder className={className} />;
  return ws.git.linked ? <GitBranch className={className} /> : <FolderGit2 className={className} />;
}

/**
 * Double-click to rename (roamgate #354). The first click still does what a click does (a row
 * opens its agent), and the double-click selects no text.
 */
function renameOnDoubleClick(rename: () => void) {
  return {
    onMouseDown: (event: MouseEvent) => {
      if (event.detail > 1) event.preventDefault();
    },
    onDoubleClick: (event: MouseEvent) => {
      event.preventDefault();
      rename();
    },
  };
}

function NavSection({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="pt-4">
      <div className="flex items-center justify-between pr-1">
        <h2 className="px-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {label}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function NavRow({
  href,
  selected,
  indent,
  children,
  className,
  style,
  ...props
}: ComponentProps<typeof RouterLink> & {
  href: string;
  selected: boolean;
  /** Left padding in px: where the row's content starts. */
  indent: number;
  children: ReactNode;
}) {
  return (
    <RouterLink
      {...props}
      href={href}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex h-9 items-center gap-2 rounded-md pr-2 text-[13px] hover:bg-sidebar-accent md:h-8",
        selected && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        className,
      )}
      style={{ ...style, paddingLeft: indent }}
    >
      {children}
    </RouterLink>
  );
}

/** The Home Screen icon counts the agents that need you (installed web apps that support badges). */
function useAppBadge(): void {
  const count = useApp((s) => (s.state === null ? 0 : needsYou(s.state).length));
  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    const done = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
    done.catch(() => undefined);
  }, [count]);
}

/**
 * A toast when an agent you're not looking at starts needing you, and for every notification
 * an agent sends you (notify.send: it asked to tell you, so even when it's on screen).
 */
function useAttentionToasts(route: Route): void {
  useEffect(() => {
    const stopAttention = onAttention(({ agent, to }) => {
      if (to !== "blocked" && to !== "done") return;
      if (route.name === "agent" && route.agentId === agent.id && document.hasFocus()) return;
      const dot = statusDot(agent);
      const show = dot.tone === "error" ? toast.error : toast.info;
      show(`${title(agent)}: ${dot.label.toLowerCase()}`, {
        id: `attention-${agent.id}`,
        action: { label: "Open", onClick: () => navigate(`/a/${agent.id}`) },
      });
    });
    const stopNotifications = onNotification((agent) => {
      const sent = agent.summary.lastNotification;
      if (sent === null) return;
      const here = route.name === "agent" && route.agentId === agent.id;
      toast.info(sent.title, {
        id: `notification-${agent.id}-${sent.seq}`,
        description: sent.body === "" ? title(agent) : `${title(agent)} · ${sent.body}`,
        duration: 10_000,
        ...(here ? {} : { action: { label: "Open", onClick: () => navigate(`/a/${agent.id}`) } }),
      });
    });
    // Coach's tasks (D-050): their notifications open Coach on the task and the run.
    const stopTaskNotices = onTaskNotice((task, notice) => {
      toast.info(notice.title, {
        id: `task-notice-${notice.id}`,
        description: notice.body,
        duration: 15_000,
        action: { label: "Open Coach task", onClick: () => openCoachTask(task.id, notice.runId) },
      });
    });
    return () => {
      stopAttention();
      stopNotifications();
      stopTaskNotices();
    };
  }, [route]);
}

export function RowrowMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 16c3-2 6-2 9 0s6 2 9 0" />
      <path d="M7 4l5 9" />
      <path d="M13 4l5 9" />
    </svg>
  );
}
