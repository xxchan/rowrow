// Home: every agent, the ones that need you first (PRINCIPLES.md, product 1). On a phone
// this is the screen you open from the home screen icon.
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Bot, Plus } from "lucide-react";
import { useMemo } from "react";
import type { AgentState, AppState } from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { useNewAgent } from "../components/NewAgentDialog.tsx";
import { ago, statusDot, title } from "../lib/format.ts";
import { useApp } from "../lib/store.ts";
import { useNow } from "../lib/use-now.ts";

export function HomePage() {
  const state = useApp((s) => s.state) as AppState;
  const open = useNewAgent((s) => s.open);
  const now = useNow(15_000);
  const agents = useMemo(
    () =>
      Object.values(state.agents)
        .filter((a) => !a.summary.archived)
        .sort(
          (a, b) =>
            ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
            b.summary.lastActivityAt - a.summary.lastActivityAt,
        ),
    [state.agents],
  );
  const groups: [string, AgentState[]][] = [
    ["Needs you", agents.filter((a) => a.attention === "blocked" || a.attention === "done")],
    ["Working", agents.filter((a) => a.attention === "working")],
    ["Idle", agents.filter((a) => a.attention === "idle")],
  ];

  return (
    <Layout
      height="fill"
      padding={4}
      contentWidth={860}
      header={
        <LayoutHeader>
          <HStack hAlign="between" vAlign="center">
            <Heading level={1}>Agents</Heading>
            <Button
              label="New agent"
              variant="primary"
              icon={<Icon icon={Plus} size="sm" />}
              onClick={() => open({})}
            />
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          {agents.length === 0 ? (
            <EmptyState
              icon={<Icon icon={Bot} size="lg" />}
              title={
                Object.keys(state.workspaces).length === 0 ? "Add a workspace to start" : "No agents yet"
              }
              description="An agent is a conversation with Claude Code, Codex, Grok, Kimi or Pi, working in a folder on this machine. Start a few; rowrow tells you which one needs you."
              actions={<Button label="New agent" variant="primary" onClick={() => open({})} />}
            />
          ) : (
            <VStack gap={5}>
              {groups
                .filter(([, list]) => list.length > 0)
                .map(([name, list]) => (
                  <VStack gap={1} key={name}>
                    <Text type="label">{`${name} · ${list.length}`}</Text>
                    <List hasDividers density="balanced">
                      {list.map((agent) => (
                        <AgentRow key={agent.id} agent={agent} state={state} now={now} />
                      ))}
                    </List>
                  </VStack>
                ))}
            </VStack>
          )}
        </LayoutContent>
      }
    />
  );
}

function AgentRow({ agent, state, now }: { agent: AgentState; state: AppState; now: number }) {
  const dot = statusDot(agent, now);
  const ws = state.workspaces[agent.summary.workspaceId];
  const runtime = state.runtimes[agent.summary.runtime]?.name ?? agent.summary.runtime;
  const detail =
    agent.attention === "done" && agent.summary.lastError !== null
      ? agent.summary.lastError
      : (agent.summary.preview ?? "");
  return (
    <ListItem
      href={`/a/${agent.id}`}
      label={title(agent)}
      description={`${dot.label} · ${ws?.label ?? "?"}${ws?.git?.branch !== undefined && ws.git.branch !== null ? ` (${ws.git.branch})` : ""} · ${runtime}${detail === "" ? "" : ` — ${oneLine(detail)}`}`}
      startContent={<StatusDot variant={dot.variant} label={dot.label} isPulsing={dot.pulsing} />}
      endContent={<Text type="supporting">{ago(agent.summary.lastActivityAt, now)}</Text>}
    />
  );
}

function oneLine(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}
