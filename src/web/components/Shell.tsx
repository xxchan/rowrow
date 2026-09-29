// The frame every page lives in: an attention-first side nav (PRINCIPLES.md, product 1).
// "Needs you" lists the agents that are blocked or finished unseen; below it, workspaces
// hold their agents, and linked worktrees nest under their repository. On a phone the
// nav is a sheet, opened from each page's header (PageHeader), which shows how many
// agents need you.
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  Folder,
  FolderGit2,
  GitBranch,
  House,
  Keyboard,
  Menu,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import type { AgentState, AppState, Workspace } from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { statusDot, title } from "../lib/format.ts";
import { navigate, RouterLink, type Route } from "../lib/router.ts";
import { onAttention, useApp } from "../lib/store.ts";
import { useNarrow } from "../lib/use-narrow.ts";
import { CommandMenu, needsYou, useCommandMenu } from "./CommandMenu.tsx";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { NewAgentDialog, useNewAgent } from "./NewAgentDialog.tsx";
import { ShortcutsDialog, useShortcuts } from "./ShortcutsDialog.tsx";
import { AgentIcon } from "./AgentIcon.tsx";
import { StatusDot } from "./StatusDot.tsx";

/** The phone nav sheet: open only for the route it was opened on, so navigating closes it. */
const useNavSheet = create<{ openOn: Route | null }>(() => ({ openOn: null }));

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const openOn = useNavSheet((s) => s.openOn);
  const narrow = useNarrow();
  useAttentionToasts(route);
  useAppBadge();
  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner />
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
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      <NewAgentDialog route={route} />
      <CommandMenu route={route} />
      <ShortcutsDialog />
      <Toaster position="top-center" />
    </div>
  );
}

/**
 * A page's title bar. On a phone it leads with the nav button, badged with how many agents
 * need you (not counting the one on screen), so you always know if someone's waiting.
 */
export function PageHeader({
  title: heading,
  subtitle,
  status,
  actions,
  route,
}: {
  title: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  route: Route;
}) {
  const state = useApp((s) => s.state);
  const current = route.name === "agent" ? route.agentId : null;
  const waiting = state === null ? 0 : needsYou(state).filter((a) => a.id !== current).length;
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-2 py-2 md:min-h-12 md:px-4">
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
          <h1 className="truncate text-[15px] leading-5 font-semibold md:text-sm">{heading}</h1>
          {subtitle !== undefined && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
        </div>
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

function Nav({ route }: { route: Route }) {
  const state = useApp((s) => s.state) as AppState;
  const openNewAgent = useNewAgent((s) => s.open);
  const agents = useMemo(
    () => Object.values(state.agents).filter((a) => !a.summary.archived),
    [state.agents],
  );
  const urgent = useMemo(() => needsYou(state), [state]);
  const roots = useMemo(
    () =>
      Object.values(state.workspaces)
        .filter((w) => !w.archived && w.parentId === null)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [state.workspaces],
  );
  const selectedAgent = route.name === "agent" ? route.agentId : null;
  const selectedWorkspace = route.name === "workspace" ? route.workspaceId : null;

  // The tree's grid: each level indents 16px; a workspace keeps a slot for its chevron.
  const indent = (depth: number): number => 22 + depth * 16;
  const agentRow = (agent: AgentState, depth: number | null, showWorkspace = false): ReactNode => {
    const dot = statusDot(agent);
    const ws = showWorkspace ? state.workspaces[agent.summary.workspaceId]?.label : undefined;
    return (
      <NavRow
        key={agent.id}
        href={`/a/${agent.id}`}
        selected={agent.id === selectedAgent}
        indent={depth === null ? 8 : indent(depth)}
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
        <StatusDot tone={dot.tone} label={dot.label} pulsing={dot.pulsing} />
      </NavRow>
    );
  };

  const workspaceRow = (ws: Workspace, depth: number): ReactNode => {
    const worktrees = Object.values(state.workspaces).filter((w) => w.parentId === ws.id && !w.archived);
    const own = agents
      .filter((a) => a.summary.workspaceId === ws.id)
      .sort((a, b) => b.summary.lastActivityAt - a.summary.lastActivityAt);
    const worst = [
      ...own,
      ...worktrees.flatMap((c) => agents.filter((a) => a.summary.workspaceId === c.id)),
    ].sort((a, b) => ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention])[0];
    const dot = worst === undefined || worst.attention === "idle" ? null : statusDot(worst);
    const Icon = ws.git === null ? Folder : ws.git.linked ? GitBranch : FolderGit2;
    const row = (
      <NavRow href={`/w/${ws.id}`} selected={ws.id === selectedWorkspace} indent={indent(depth)}>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{ws.label}</span>
        {dot !== null && <StatusDot tone={dot.tone} label={dot.label} />}
      </NavRow>
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
      <div className="flex items-center gap-2.5 px-3 pt-3 pb-2">
        <RouterLink href="/" className="flex min-w-0 items-center gap-2.5 rounded-md">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/15 text-primary">
            <RowrowMark />
          </span>
          <span className="min-w-0">
            <span className="block text-sm leading-4 font-semibold text-foreground">rowrow</span>
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
        {urgent.length > 0 && (
          <NavSection label="Needs you">{urgent.map((agent) => agentRow(agent, null, true))}</NavSection>
        )}
        <NavSection label="Workspaces">
          {roots.length === 0 ? (
            <button
              type="button"
              onClick={() => openNewAgent({})}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground hover:bg-sidebar-accent md:h-8"
            >
              <Plus className="size-4" /> Add a workspace
            </button>
          ) : (
            roots.map((ws) => workspaceRow(ws, 0))
          )}
        </NavSection>
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

function NavSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="pt-4">
      <h2 className="px-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </h2>
      {children}
    </section>
  );
}

function NavRow({
  href,
  selected,
  indent,
  children,
}: {
  href: string;
  selected: boolean;
  /** Left padding in px: where the row's content starts. */
  indent: number;
  children: ReactNode;
}) {
  return (
    <RouterLink
      href={href}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex h-9 items-center gap-2 rounded-md pr-2 text-[13px] hover:bg-sidebar-accent md:h-8",
        selected && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
      )}
      style={{ paddingLeft: indent }}
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

/** A toast when an agent you're not looking at starts needing you. */
function useAttentionToasts(route: Route): void {
  useEffect(
    () =>
      onAttention(({ agent, to }) => {
        if (to !== "blocked" && to !== "done") return;
        if (route.name === "agent" && route.agentId === agent.id && document.hasFocus()) return;
        const dot = statusDot(agent);
        const show = dot.tone === "error" ? toast.error : toast.info;
        show(`${title(agent)}: ${dot.label.toLowerCase()}`, {
          id: `attention-${agent.id}`,
          action: { label: "Open", onClick: () => navigate(`/a/${agent.id}`) },
        });
      }),
    [route],
  );
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
