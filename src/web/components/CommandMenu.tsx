// ⌘K: jump to any agent or workspace, run an action (herdr's goto picker), or type what a new
// agent should do and start it (D-023). New workspace, and Rename, Archive and Remove for the
// workspace you're in (D-047). ⌘J: go to the next agent that needs you, in
// attention order. C: a new agent, set up for the page you're on. ⌘,: Settings. ?: every
// shortcut (ShortcutsDialog). Everything reachable by keyboard.
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useCommandState } from "cmdk";
import { commandFilter } from "../lib/command-filter.ts";
import {
  Archive,
  ArchiveRestore,
  Folder,
  FolderPlus,
  House,
  Keyboard,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { byPin, type AgentState, type AppState } from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { agentListed, workspaceArchived, workspaceLabel } from "../../shared/workspaces.ts";
import { statusDot, title } from "../lib/format.ts";
import { contextOf, loadPrefs, startAgent } from "../lib/new-agent.ts";
import { resolveSetup } from "../../shared/new-agent-setup.ts";
import { navigate, type Route } from "../lib/router.ts";
import { useApp, useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { useNewAgent } from "./NewAgentDialog.tsx";
import { AgentAvatar } from "./AgentIcon.tsx";
import { useShortcuts } from "./ShortcutsDialog.tsx";
import { openWorkspaceDialog, useUnarchive } from "./WorkspaceActions.tsx";

export const useCommandMenu = create<{ isOpen: boolean; setOpen: (open: boolean) => void }>((set) => ({
  isOpen: false,
  setOpen: (isOpen) => set({ isOpen }),
}));

/** Agents that need you, most urgent first (blocked, then done), newest first within a kind. */
export function needsYou(state: AppState): AgentState[] {
  return Object.values(state.agents)
    .filter((a) => agentListed(state.workspaces, a) && (a.attention === "blocked" || a.attention === "done"))
    .sort(
      (a, b) =>
        ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
        b.summary.lastActivityAt - a.summary.lastActivityAt,
    );
}

/** Where a bare key is someone typing, or belongs to something open, not a shortcut. */
function busyTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"]') !== null)
  );
}

export function CommandMenu({ route }: { route: Route }) {
  const { isOpen, setOpen } = useCommandMenu();
  const client = useClient();
  const state = useApp((s) => s.state);
  const openNewAgent = useNewAgent((s) => s.open);
  const unarchive = useUnarchive();
  // What's typed, and whether it matches nothing, as cmdk sees it (the palette resets when it closes).
  const [search, setSearch] = useState({ query: "", noMatch: false });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      const bare = !mod && !event.altKey && !event.repeat && !busyTarget(event.target);
      if (
        bare &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c" &&
        !useNewAgent.getState().isOpen &&
        !useCommandMenu.getState().isOpen
      ) {
        event.preventDefault();
        openNewAgent({});
        return;
      }
      // Shift is how most layouts type "?", so it isn't checked.
      if (bare && event.key === "?") {
        event.preventDefault();
        useShortcuts.getState().setOpen(true);
        return;
      }
      if (!mod || event.shiftKey || event.altKey) return;
      if (event.key === "k") {
        event.preventDefault();
        setOpen(!useCommandMenu.getState().isOpen);
      } else if (event.key === ",") {
        event.preventDefault();
        navigate("/settings");
      } else if (event.key === "j" && state !== null) {
        event.preventDefault();
        const current = route.name === "agent" ? route.agentId : null;
        const next = needsYou(state).find((a) => a.id !== current);
        if (next !== undefined) navigate(`/a/${next.id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route, setOpen, state, openNewAgent]);

  const run = (action: () => void): void => {
    setOpen(false);
    // Act after this keystroke is done: closing the palette returns focus to whatever had it
    // before (often a link), and the same Enter would otherwise activate that too.
    setTimeout(action, 0);
  };

  const text = isOpen ? search.query.trim() : "";
  const noMatch = search.noMatch;
  const setup = state === null || text === "" ? null : resolveSetup(state, contextOf(route), loadPrefs());
  const startIn =
    setup === null
      ? ""
      : [
          state?.workspaces[setup.workspaceId ?? ""]?.label,
          state?.runtimes[setup.runtime ?? ""]?.name,
          setup.isolate ? "new worktree" : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(" · ");
  /** Start an agent with the query as its first message, set up for this page; else open the dialog with it. */
  const start = async (): Promise<void> => {
    const workspaceId = setup?.workspaceId ?? null;
    const runtime = setup?.runtime ?? null;
    if (client === null || setup === null || workspaceId === null || runtime === null) {
      openNewAgent({ draft: text });
      return;
    }
    try {
      const id = await startAgent(client, { ...setup, workspaceId, runtime, branch: "", text });
      navigate(`/a/${id}`);
    } catch (error) {
      report("warn", "agent.create_failed", error);
      toast.error(`Couldn't start the agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const urgent = state === null ? [] : needsYou(state);
  const urgentIds = new Set(urgent.map((a) => a.id));
  const others =
    state === null
      ? []
      : Object.values(state.agents)
          .filter((a) => agentListed(state.workspaces, a) && !urgentIds.has(a.id))
          .sort(
            (a, b) =>
              byPin(a, b) ||
              ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
              b.summary.lastActivityAt - a.summary.lastActivityAt,
          );
  const workspaces =
    state === null
      ? []
      : Object.values(state.workspaces).filter((w) => !workspaceArchived(state.workspaces, w.id));
  // The workspace you're in: its page, or the agent's on screen.
  const here =
    state === null
      ? undefined
      : route.name === "workspace"
        ? state.workspaces[route.workspaceId]
        : route.name === "agent"
          ? state.workspaces[state.agents[route.agentId]?.summary.workspaceId ?? ""]
          : undefined;

  const agentItem = (agent: AgentState) => {
    const dot = statusDot(agent);
    const ws = state?.workspaces[agent.summary.workspaceId];
    const wsLabel = state === null ? "" : workspaceLabel(state.workspaces, agent.summary.workspaceId);
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
        <AgentAvatar
          runtime={agent.summary.runtime}
          tone={dot.tone}
          label={dot.label}
          size="sm"
          ring="ring-popover"
        />
        <span className="truncate">{title(agent)}</span>
        <span className="ml-auto truncate text-xs text-muted-foreground">{`${dot.label} · ${wsLabel}`}</span>
      </CommandItem>
    );
  };

  return (
    <CommandDialog
      filter={commandFilter}
      open={isOpen}
      onOpenChange={setOpen}
      title="Go to an agent, a workspace, or an action"
      description="Type to filter; Enter opens the highlighted one."
      className="top-[20%] translate-y-0 sm:max-w-xl"
    >
      <CommandInput
        placeholder="Go to an agent or workspace, or say what a new agent should do…"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || text === "" || event.nativeEvent.isComposing) return;
          // Return starts one when nothing else matches; ⌘Return always does; ⌥Return edits it first.
          if (event.altKey) {
            event.preventDefault();
            run(() => openNewAgent({ draft: text }));
          } else if (event.metaKey || event.ctrlKey || noMatch) {
            event.preventDefault();
            run(() => void start());
          }
        }}
      />
      <CommandList className="max-h-[min(60dvh,420px)]">
        <SearchState onChange={setSearch} />
        {text === "" ? (
          <CommandEmpty>Nothing matches.</CommandEmpty>
        ) : (
          noMatch && (
            <CommandGroup heading="New agent" forceMount>
              <CommandItem forceMount value="start" onSelect={() => run(() => void start())}>
                <Plus />
                <span className="min-w-0 truncate">{`Start an agent: “${text}”`}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{startIn}</span>
              </CommandItem>
              <CommandItem forceMount value="edit" onSelect={() => run(() => openNewAgent({ draft: text }))}>
                <Pencil /> Edit before starting…
                <CommandShortcut>⌥↵</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          )
        )}
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
            <CommandShortcut>C</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="action:new-workspace"
            keywords={["New workspace", "add workspace", "create workspace", "folder", "repository"]}
            onSelect={() => run(() => openWorkspaceDialog("add"))}
          >
            <FolderPlus /> New workspace
          </CommandItem>
          {here !== undefined && (
            <>
              <CommandItem
                value="action:rename-workspace"
                keywords={["Rename workspace", "workspace name", here.label]}
                onSelect={() => run(() => openWorkspaceDialog("rename", here.id))}
              >
                <Pencil /> Rename workspace
                <span className="ml-auto truncate text-xs text-muted-foreground">{here.label}</span>
              </CommandItem>
              <CommandItem
                value="action:archive-workspace"
                keywords={[here.archived ? "Unarchive workspace" : "Archive workspace", "hide", here.label]}
                onSelect={() =>
                  run(() => (here.archived ? unarchive(here) : openWorkspaceDialog("archive", here.id)))
                }
              >
                {here.archived ? <ArchiveRestore /> : <Archive />}
                {here.archived ? "Unarchive workspace" : "Archive workspace"}
                <span className="ml-auto truncate text-xs text-muted-foreground">{here.label}</span>
              </CommandItem>
              <CommandItem
                value="action:remove-workspace"
                keywords={[
                  "Remove workspace from rowrow",
                  "delete workspace",
                  "remove workspace",
                  "close workspace",
                  "forget",
                  here.label,
                ]}
                className="text-destructive data-[selected=true]:bg-destructive/10 data-[selected=true]:text-destructive *:[svg]:text-destructive!"
                onSelect={() => run(() => openWorkspaceDialog("remove", here.id))}
              >
                <Trash2 /> Remove workspace from rowrow
                <span className="ml-auto truncate text-xs text-muted-foreground">{here.label}</span>
              </CommandItem>
            </>
          )}
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
          <CommandItem
            value="action:shortcuts"
            keywords={["Keyboard shortcuts", "keys", "hotkeys", "cheatsheet", "help"]}
            onSelect={() => run(() => useShortcuts.getState().setOpen(true))}
          >
            <Keyboard /> Keyboard shortcuts
            <CommandShortcut>?</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** Reports what's typed and whether it matches nothing (only cmdk's children can ask it). */
function SearchState({ onChange }: { onChange: (search: { query: string; noMatch: boolean }) => void }) {
  const query = useCommandState((s) => s.search);
  const noMatch = useCommandState((s) => s.search !== "" && s.filtered.count === 0);
  useEffect(() => onChange({ query, noMatch }), [query, noMatch, onChange]);
  return null;
}
