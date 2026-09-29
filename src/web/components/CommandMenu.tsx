// ⌘K: jump to any agent or workspace, or run an action (herdr's goto picker). ⌘J: go to
// the next agent that needs you, in attention order. Everything reachable by keyboard.
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Folder, House, Plus, Settings } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";
import type { AgentState, AppState } from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { statusDot, title } from "../lib/format.ts";
import { navigate, type Route } from "../lib/router.ts";
import { useApp } from "../lib/store.ts";
import { useNewAgent } from "./NewAgentDialog.tsx";
import { StatusDot } from "./StatusDot.tsx";

export const useCommandMenu = create<{ isOpen: boolean; setOpen: (open: boolean) => void }>((set) => ({
  isOpen: false,
  setOpen: (isOpen) => set({ isOpen }),
}));

/** Agents that need you, most urgent first (blocked, then done), newest first within a kind. */
export function needsYou(state: AppState): AgentState[] {
  return Object.values(state.agents)
    .filter((a) => !a.summary.archived && (a.attention === "blocked" || a.attention === "done"))
    .sort(
      (a, b) =>
        ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
        b.summary.lastActivityAt - a.summary.lastActivityAt,
    );
}

export function CommandMenu({ route }: { route: Route }) {
  const { isOpen, setOpen } = useCommandMenu();
  const state = useApp((s) => s.state);
  const openNewAgent = useNewAgent((s) => s.open);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.shiftKey || event.altKey) return;
      if (event.key === "k") {
        event.preventDefault();
        setOpen(!useCommandMenu.getState().isOpen);
      } else if (event.key === "j" && state !== null) {
        event.preventDefault();
        const current = route.name === "agent" ? route.agentId : null;
        const next = needsYou(state).find((a) => a.id !== current);
        if (next !== undefined) navigate(`/a/${next.id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route, setOpen, state]);

  const run = (action: () => void): void => {
    setOpen(false);
    // Act after this keystroke is done: closing the palette returns focus to whatever had it
    // before (often a link), and the same Enter would otherwise activate that too.
    setTimeout(action, 0);
  };

  const urgent = state === null ? [] : needsYou(state);
  const urgentIds = new Set(urgent.map((a) => a.id));
  const others =
    state === null
      ? []
      : Object.values(state.agents)
          .filter((a) => !a.summary.archived && !urgentIds.has(a.id))
          .sort(
            (a, b) =>
              ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
              b.summary.lastActivityAt - a.summary.lastActivityAt,
          );
  const workspaces = state === null ? [] : Object.values(state.workspaces).filter((w) => !w.archived);

  const agentItem = (agent: AgentState) => {
    const dot = statusDot(agent);
    const ws = state?.workspaces[agent.summary.workspaceId];
    return (
      <CommandItem
        key={agent.id}
        value={`agent:${agent.id}`}
        keywords={[
          title(agent),
          agent.id,
          ws?.label ?? "",
          agent.summary.runtime,
          agent.attention,
          ws?.git?.branch ?? "",
        ]}
        onSelect={() => run(() => navigate(`/a/${agent.id}`))}
      >
        <StatusDot tone={dot.tone} label={dot.label} />
        <span className="truncate">{title(agent)}</span>
        <span className="ml-auto truncate text-xs text-muted-foreground">{`${dot.label} · ${ws?.label ?? ""}`}</span>
      </CommandItem>
    );
  };

  return (
    <CommandDialog
      open={isOpen}
      onOpenChange={setOpen}
      title="Go to an agent, a workspace, or an action"
      description="Type to filter; Enter opens the highlighted one."
      className="top-[20%] translate-y-0 sm:max-w-xl"
    >
      <CommandInput placeholder="Go to an agent or workspace, or run an action…" />
      <CommandList className="max-h-[min(60dvh,420px)]">
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {urgent.length > 0 && <CommandGroup heading="Needs you">{urgent.map(agentItem)}</CommandGroup>}
        {others.length > 0 && <CommandGroup heading="Agents">{others.map(agentItem)}</CommandGroup>}
        {workspaces.length > 0 && (
          <CommandGroup heading="Workspaces">
            {workspaces.map((ws) => (
              <CommandItem
                key={ws.id}
                value={`ws:${ws.id}`}
                keywords={[ws.label, ws.path, ws.git?.branch ?? ""]}
                onSelect={() => run(() => navigate(`/w/${ws.id}`))}
              >
                <Folder className="text-muted-foreground" />
                <span className="truncate">{ws.label}</span>
                <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{ws.path}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Actions">
          <CommandItem
            value="action:new"
            keywords={["New agent", "create", "start"]}
            onSelect={() => run(() => openNewAgent({}))}
          >
            <Plus /> New agent
          </CommandItem>
          <CommandItem
            value="action:home"
            keywords={["All agents", "home", "inbox"]}
            onSelect={() => run(() => navigate("/"))}
          >
            <House /> All agents
          </CommandItem>
          <CommandItem
            value="action:settings"
            keywords={["Settings", "pair", "devices", "push", "theme"]}
            onSelect={() => run(() => navigate("/settings"))}
          >
            <Settings /> Settings
            <CommandShortcut>⌘,</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
