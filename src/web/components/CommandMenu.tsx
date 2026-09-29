// ⌘K: jump to any agent or workspace, or run an action (herdr's goto picker). ⌘J: go to
// the next agent that needs you, in attention order. Everything reachable by keyboard.
import { CommandPalette, CommandPaletteInput } from "@astryxdesign/core/CommandPalette";
import { HStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { AgentState, AppState } from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { statusDot, title } from "../lib/format.ts";
import { navigate, type Route } from "../lib/router.ts";
import { useApp } from "../lib/store.ts";
import { useNewAgent } from "./NewAgentDialog.tsx";

export const useCommandMenu = create<{ isOpen: boolean; setOpen: (open: boolean) => void }>((set) => ({
  isOpen: false,
  setOpen: (isOpen) => set({ isOpen }),
}));

interface Item {
  readonly id: string;
  readonly label: string;
  readonly auxiliaryData: {
    readonly group: string;
    readonly detail: string;
    readonly agent?: AgentState;
    readonly keywords: string[];
  };
}

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

  const source = useMemo(() => {
    const items: Item[] = [];
    if (state !== null) {
      const urgent = new Set(needsYou(state).map((a) => a.id));
      const agents = Object.values(state.agents)
        .filter((a) => !a.summary.archived)
        .sort(
          (a, b) =>
            ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
            b.summary.lastActivityAt - a.summary.lastActivityAt,
        );
      for (const agent of agents) {
        const ws = state.workspaces[agent.summary.workspaceId];
        items.push({
          id: `agent:${agent.id}`,
          label: title(agent),
          auxiliaryData: {
            group: urgent.has(agent.id) ? "Needs you" : "Agents",
            detail: `${statusDot(agent).label} · ${ws?.label ?? ""}`,
            agent,
            keywords: [
              agent.id,
              ws?.label ?? "",
              agent.summary.runtime,
              agent.attention,
              ws?.git?.branch ?? "",
            ],
          },
        });
      }
      for (const ws of Object.values(state.workspaces).filter((w) => !w.archived)) {
        items.push({
          id: `ws:${ws.id}`,
          label: ws.label,
          auxiliaryData: { group: "Workspaces", detail: ws.path, keywords: [ws.path, ws.git?.branch ?? ""] },
        });
      }
    }
    items.push(
      {
        id: "action:new",
        label: "New agent",
        auxiliaryData: {
          group: "Actions",
          detail: "Start an agent in a workspace",
          keywords: ["create", "start"],
        },
      },
      {
        id: "action:home",
        label: "All agents",
        auxiliaryData: { group: "Actions", detail: "The attention-sorted list", keywords: ["home", "inbox"] },
      },
      {
        id: "action:settings",
        label: "Settings",
        auxiliaryData: {
          group: "Actions",
          detail: "Devices, notifications, runtimes",
          keywords: ["pair", "devices", "push"],
        },
      },
    );
    return createStaticSource(items, { keywords: (item) => item.auxiliaryData.keywords });
  }, [state]);

  const run = (id: string): void => {
    setOpen(false);
    const [kind, value = ""] = id.split(":");
    // Act after this keystroke is done: closing the palette returns focus to whatever had it
    // before (often a link), and the same Enter would otherwise activate that too.
    setTimeout(() => {
      if (kind === "agent") navigate(`/a/${value}`);
      else if (kind === "ws") navigate(`/w/${value}`);
      else if (value === "new") openNewAgent({});
      else if (value === "home") navigate("/");
      else if (value === "settings") navigate("/settings");
    }, 0);
  };

  return (
    <CommandPalette<Item>
      isOpen={isOpen}
      onOpenChange={setOpen}
      searchSource={source}
      onValueChange={run}
      input={
        <CommandPaletteInput
          placeholder="Go to an agent or workspace, or run an action…"
          onKeyDown={(event) => {
            // Enter picks the first result when nothing is highlighted yet, like other palettes.
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            if (event.currentTarget.getAttribute("aria-activedescendant") !== null) return;
            const list = document.getElementById(event.currentTarget.getAttribute("aria-controls") ?? "");
            const first = list?.querySelector<HTMLElement>('[role="option"]') ?? null;
            if (first !== null) {
              event.preventDefault();
              first.click();
            }
          }}
        />
      }
      label="Go to an agent, a workspace, or an action"
      emptyBootstrapText="Type an agent, a workspace or an action"
      renderItem={(item) => {
        const dot = item.auxiliaryData.agent === undefined ? null : statusDot(item.auxiliaryData.agent);
        return (
          <HStack gap={2} vAlign="center">
            {dot !== null && <StatusDot variant={dot.variant} label={dot.label} />}
            <Text type="body">{item.label}</Text>
            <Text type="supporting" maxLines={1}>
              {item.auxiliaryData.detail}
            </Text>
          </HStack>
        );
      }}
    />
  );
}
