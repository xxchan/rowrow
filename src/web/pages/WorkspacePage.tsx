// One workspace: its git state, its agents, and its worktrees.
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Plus, RefreshCw } from "lucide-react";
import type { AppState, Workspace } from "../../shared/schemas.ts";
import { useNewAgent } from "../components/NewAgentDialog.tsx";
import { ago, statusDot, title } from "../lib/format.ts";
import { useApp, useClient } from "../lib/store.ts";
import { useNow } from "../lib/use-now.ts";

export function WorkspacePage({ workspaceId }: { workspaceId: string }) {
  const state = useApp((s) => s.state) as AppState;
  const ws = state.workspaces[workspaceId];
  if (ws === undefined)
    return <EmptyState title="No such workspace" description={`There is no workspace ${workspaceId}.`} />;
  return <WorkspaceView ws={ws} state={state} />;
}

function WorkspaceView({ ws, state }: { ws: Workspace; state: AppState }) {
  const client = useClient();
  const toast = useToast();
  const open = useNewAgent((s) => s.open);
  const now = useNow(15_000);
  const agents = Object.values(state.agents)
    .filter((a) => a.summary.workspaceId === ws.id && !a.summary.archived)
    .sort((a, b) => b.summary.lastActivityAt - a.summary.lastActivityAt);
  const worktrees = Object.values(state.workspaces).filter((w) => w.parentId === ws.id);
  const git = ws.git;

  const refresh = async (): Promise<void> => {
    if (client === null) return;
    try {
      await client.workspaces.refresh({ id: ws.id });
    } catch (error) {
      toast({
        body: `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        type: "error",
      });
    }
  };

  return (
    <Layout
      height="fill"
      padding={4}
      contentWidth={860}
      header={
        <LayoutHeader>
          <VStack gap={1}>
            <HStack hAlign="between" vAlign="center" gap={2}>
              <Heading level={1}>{ws.label}</Heading>
              <HStack gap={1}>
                <Button
                  label="Refresh"
                  variant="ghost"
                  icon={<Icon icon={RefreshCw} size="sm" />}
                  isIconOnly
                  onClick={() => void refresh()}
                />
                <Button
                  label="New agent here"
                  variant="primary"
                  icon={<Icon icon={Plus} size="sm" />}
                  onClick={() => open({ workspaceId: ws.id })}
                />
              </HStack>
            </HStack>
            <Text type="supporting">
              <Code>{ws.path}</Code>
              {ws.missing ? " — this folder no longer exists" : ""}
            </Text>
            {git !== null && (
              <Text type="supporting">
                {[
                  git.branch === null ? `detached at ${git.head ?? "?"}` : `on ${git.branch}`,
                  git.upstream === null
                    ? "no upstream"
                    : `${git.ahead} ahead, ${git.behind} behind ${git.upstream}`,
                  git.changed === 0 ? "clean" : `${git.changed} changed file${git.changed === 1 ? "" : "s"}`,
                  git.linked ? "linked worktree" : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </Text>
            )}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <VStack gap={5}>
            <VStack gap={1}>
              <Text type="label">{`Agents · ${agents.length}`}</Text>
              {agents.length === 0 ? (
                <EmptyState
                  title="No agents here yet"
                  isCompact
                  actions={<Button label="New agent here" onClick={() => open({ workspaceId: ws.id })} />}
                />
              ) : (
                <List hasDividers>
                  {agents.map((agent) => {
                    const dot = statusDot(agent, now);
                    return (
                      <ListItem
                        key={agent.id}
                        href={`/a/${agent.id}`}
                        label={title(agent)}
                        description={`${dot.label} · ${state.runtimes[agent.summary.runtime]?.name ?? agent.summary.runtime}`}
                        startContent={
                          <StatusDot variant={dot.variant} label={dot.label} isPulsing={dot.pulsing} />
                        }
                        endContent={<Text type="supporting">{ago(agent.summary.lastActivityAt, now)}</Text>}
                      />
                    );
                  })}
                </List>
              )}
            </VStack>
            {worktrees.length > 0 && (
              <VStack gap={1}>
                <Text type="label">{`Worktrees · ${worktrees.length}`}</Text>
                <List hasDividers>
                  {worktrees.map((w) => (
                    <ListItem key={w.id} href={`/w/${w.id}`} label={w.label} description={w.path} />
                  ))}
                </List>
              </VStack>
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
