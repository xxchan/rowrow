// The frame every page lives in: an attention-first side nav (PRINCIPLES.md, product 1).
// "Needs you" lists the agents that are blocked or finished unseen; below it, workspaces
// hold their agents, and linked worktrees nest under their repository. On a phone the
// nav becomes a drawer.
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useToast } from "@astryxdesign/core/Toast";
import { FolderGit2, Folder, GitBranch, Home, Plus, Settings } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentState, AppState, Workspace } from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { statusDot, title } from "../lib/format.ts";
import { navigate, type Route } from "../lib/router.ts";
import { onAttention, useApp } from "../lib/store.ts";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { NewAgentDialog, useNewAgent } from "./NewAgentDialog.tsx";

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const state = useApp((s) => s.state) as AppState;
  // The phone drawer closes by itself after navigating: it is open only for the route it was opened on.
  const [drawer, setDrawer] = useState<Route | null>(null);
  const drawerOpen = drawer === route;
  const openNewAgent = useNewAgent((s) => s.open);
  useAttentionToasts(route);

  const agents = useMemo(
    () => Object.values(state.agents).filter((a) => !a.summary.archived),
    [state.agents],
  );
  const needsYou = useMemo(
    () =>
      agents
        .filter((a) => a.attention === "blocked" || a.attention === "done")
        .sort(
          (a, b) =>
            ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
            b.summary.lastActivityAt - a.summary.lastActivityAt,
        ),
    [agents],
  );
  const roots = useMemo(
    () =>
      Object.values(state.workspaces)
        .filter((w) => !w.archived && w.parentId === null)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [state.workspaces],
  );
  const selectedAgent = route.name === "agent" ? route.agentId : null;
  const selectedWorkspace = route.name === "workspace" ? route.workspaceId : null;

  const agentItem = (agent: AgentState, showWorkspace = false): ReactNode => {
    const dot = statusDot(agent);
    const ws = showWorkspace ? state.workspaces[agent.summary.workspaceId]?.label : undefined;
    return (
      <SideNavItem
        key={agent.id}
        label={ws === undefined ? title(agent) : `${title(agent)} · ${ws}`}
        href={`/a/${agent.id}`}
        isSelected={agent.id === selectedAgent}
        endContent={<StatusDot variant={dot.variant} label={dot.label} isPulsing={dot.pulsing} />}
      />
    );
  };

  const workspaceItem = (ws: Workspace): ReactNode => {
    const worktrees = Object.values(state.workspaces).filter((w) => w.parentId === ws.id && !w.archived);
    const own = agents
      .filter((a) => a.summary.workspaceId === ws.id)
      .sort((a, b) => b.summary.lastActivityAt - a.summary.lastActivityAt);
    const hasChildren = own.length > 0 || worktrees.length > 0;
    const worst = [
      ...own,
      ...worktrees.flatMap((c) => agents.filter((a) => a.summary.workspaceId === c.id)),
    ].sort((a, b) => ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention])[0];
    const dot = worst === undefined || worst.attention === "idle" ? null : statusDot(worst);
    return (
      <SideNavItem
        key={ws.id}
        label={ws.label}
        icon={ws.git === null ? Folder : ws.git.linked ? GitBranch : FolderGit2}
        href={`/w/${ws.id}`}
        isSelected={ws.id === selectedWorkspace}
        {...(dot === null ? {} : { endContent: <StatusDot variant={dot.variant} label={dot.label} /> })}
        {...(hasChildren ? { collapsible: { defaultIsCollapsed: false } } : {})}
      >
        {hasChildren ? (
          <>
            {own.map((agent) => agentItem(agent))}
            {worktrees.map((child) => workspaceItem(child))}
          </>
        ) : undefined}
      </SideNavItem>
    );
  };

  return (
    <>
      <AppShell
        contentPadding={0}
        banner={<ConnectionBanner />}
        mobileNav={{ isOpen: drawerOpen, onOpenChange: (open) => setDrawer(open ? route : null) }}
        sideNav={
          <SideNav
            aria-label="Agents and workspaces"
            collapsible
            resizable={{ defaultWidth: 290, minWidth: 220, maxWidth: 440, autoSaveId: "rowrow-sidenav" }}
            header={
              <SideNavHeading
                heading="rowrow"
                subheading={state.host.name}
                headingHref="/"
                icon={<NavIcon icon={<RowrowMark />} />}
              />
            }
            topContent={
              <Button
                label="New agent"
                variant="primary"
                icon={<Icon icon={Plus} size="sm" />}
                onClick={() => openNewAgent({})}
                width="100%"
              />
            }
            footer={
              <SideNavSection title="App" isHeaderHidden>
                <SideNavItem
                  label="Settings"
                  icon={Settings}
                  href="/settings"
                  isSelected={route.name === "settings"}
                />
              </SideNavSection>
            }
          >
            <SideNavSection title="Home" isHeaderHidden>
              <SideNavItem label="All agents" icon={Home} href="/" isSelected={route.name === "home"} />
            </SideNavSection>
            {needsYou.length > 0 && (
              <SideNavSection title="Needs you">
                {needsYou.map((agent) => agentItem(agent, true))}
              </SideNavSection>
            )}
            <SideNavSection title="Workspaces">
              {roots.length === 0 ? (
                <SideNavItem label="Add a workspace" icon={Plus} onClick={() => openNewAgent({})} />
              ) : (
                roots.map(workspaceItem)
              )}
            </SideNavSection>
          </SideNav>
        }
      >
        {children}
      </AppShell>
      <NewAgentDialog />
    </>
  );
}

/** A toast when an agent you're not looking at starts needing you. */
function useAttentionToasts(route: Route): void {
  const toast = useToast();
  useEffect(
    () =>
      onAttention(({ agent, to }) => {
        if (to !== "blocked" && to !== "done") return;
        if (route.name === "agent" && route.agentId === agent.id && document.hasFocus()) return;
        const dot = statusDot(agent);
        toast({
          body: `${title(agent)}: ${dot.label.toLowerCase()}`,
          type: dot.variant === "error" ? "error" : "info",
          uniqueID: `attention-${agent.id}`,
          endContent: (
            <Button label="Open" size="sm" variant="secondary" onClick={() => navigate(`/a/${agent.id}`)} />
          ),
        });
      }),
    [route, toast],
  );
}

function RowrowMark() {
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
    >
      <path d="M3 16c3-2 6-2 9 0s6 2 9 0" />
      <path d="M7 4l5 9" />
      <path d="M13 4l5 9" />
    </svg>
  );
}
