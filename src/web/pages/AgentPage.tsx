// One agent: who it is and what it's doing, the transcript, and the composer. Seeing the
// latest turn here (visible, focused window) marks it seen, which clears its `done`
// attention on every device (docs/decisions.md, D-008).
import { ChatLayout, ChatMessageList } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import { FileDiff } from "lucide-react";
import { useNarrow } from "../lib/use-narrow.ts";
import type { AgentState, AppState } from "../../shared/schemas.ts";
import { ChangesView } from "../components/ChangesView.tsx";
import { Composer } from "../components/Composer.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { statusDot, title } from "../lib/format.ts";
import { useLooking } from "../lib/presence.ts";
import { navigate } from "../lib/router.ts";
import { loadOlder, useApp, useClient, useTranscript } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { useNow } from "../lib/use-now.ts";

export function AgentPage({ agentId }: { agentId: string }) {
  const state = useApp((s) => s.state) as AppState;
  const agent = state.agents[agentId];
  if (agent === undefined)
    return <EmptyState title="No such agent" description={`There is no agent ${agentId} on this server.`} />;
  return <AgentView agent={agent} state={state} />;
}

function AgentView({ agent, state }: { agent: AgentState; state: AppState }) {
  const client = useClient();
  const transcript = useTranscript(agent.id);
  const looking = useLooking();
  const now = useNow(5000);
  const toast = useToast();
  const { summary } = agent;
  const ws = state.workspaces[summary.workspaceId];
  const dot = statusDot(agent, now);
  const head = transcript.timeline.headSeq;

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

  const narrow = useNarrow();
  const [showChanges, setShowChanges] = useState(() => localStorage.getItem(CHANGES_KEY) === "1");
  const toggleChanges = (): void => {
    setShowChanges((open) => {
      if (!narrow) localStorage.setItem(CHANGES_KEY, open ? "0" : "1");
      return !open;
    });
  };
  const panel = useResizable({
    defaultSize: 520,
    minSize: 320,
    maxSize: 1100,
    autoSaveId: "rowrow-changes-panel",
  });
  const changed = ws?.git?.changed ?? 0;

  const act = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      toast({
        body: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
        type: "error",
      });
      report("warn", "agent.action_failed", error, { action: label, agentId: agent.id });
    }
  };

  const model = summary.reportedModel ?? summary.model;
  const runtime = state.runtimes[summary.runtime]?.name ?? summary.runtime;
  const facts = [
    runtime,
    model,
    summary.reportedEffort ?? summary.effort,
    ws === undefined
      ? null
      : `${ws.label}${ws.git?.branch === null || ws.git?.branch === undefined ? "" : ` (${ws.git.branch})`}`,
    summary.usage === null ? null : `${formatTokens(summary.usage.input + summary.usage.output)} tokens`,
  ].filter((fact): fact is string => fact !== null && fact !== undefined);

  return (
    <>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider>
            <HStack gap={2} vAlign="center" padding={3}>
              <StatusDot variant={dot.variant} label={dot.label} isPulsing={dot.pulsing} />
              <StackItem size="fill">
                <VStack gap={0}>
                  <Heading level={2}>{title(agent)}</Heading>
                  <Text type="supporting">{`${dot.label} · ${facts.join(" · ")}`}</Text>
                </VStack>
              </StackItem>
              {ws?.git !== null && ws !== undefined && (
                <Button
                  label={changed > 0 ? `Changes · ${changed}` : "Changes"}
                  variant={showChanges ? "secondary" : "ghost"}
                  size="sm"
                  icon={<Icon icon={FileDiff} size="sm" />}
                  isIconOnly={narrow && changed === 0}
                  onClick={toggleChanges}
                />
              )}
              <MoreMenu
                label="Agent actions"
                items={[
                  ...(ws === undefined
                    ? []
                    : [{ label: `Open workspace ${ws.label}`, onClick: () => navigate(`/w/${ws.id}`) }]),
                  {
                    label: "Rename",
                    onClick: () => {
                      const next = prompt("Rename agent", summary.title ?? "");
                      if (next !== null && client !== null)
                        void act("Rename", () =>
                          client.agents.update({
                            agentId: agent.id,
                            title: next.trim() === "" ? null : next.trim(),
                          }),
                        );
                    },
                  },
                  ...(summary.run === null || client === null
                    ? []
                    : [
                        {
                          label: "Stop the agent process",
                          onClick: () => void act("Stop", () => client.agents.stop({ agentId: agent.id })),
                        },
                      ]),
                  client === null
                    ? { label: "Archive", onClick: () => undefined }
                    : summary.archived
                      ? {
                          label: "Unarchive",
                          onClick: () =>
                            void act("Unarchive", () =>
                              client.agents.update({ agentId: agent.id, archived: false }),
                            ),
                        }
                      : {
                          label: "Archive",
                          onClick: () =>
                            void act("Archive", () =>
                              client.agents.update({ agentId: agent.id, archived: true }),
                            ),
                        },
                ]}
              />
            </HStack>
          </LayoutHeader>
        }
        {...(showChanges && !narrow && ws !== undefined
          ? {
              end: (
                <>
                  <ResizeHandle
                    direction="horizontal"
                    isReversed
                    hasDivider
                    resizable={panel.props}
                    label="Resize the changes panel"
                  />
                  <LayoutPanel width={panel.size} padding={3} label="Changes">
                    <ChangesView workspaceId={ws.id} />
                  </LayoutPanel>
                </>
              ),
            }
          : {})}
        content={
          <LayoutContent padding={0} isScrollable={false}>
            <ChatLayout composer={<Composer agent={agent} />} xstyle={styles.chat}>
              <ChatMessageList
                isStreaming={summary.status.kind === "running"}
                {...(transcript.hasMore && client !== null
                  ? { scrollToTopAction: () => loadOlder(client, agent.id) }
                  : {})}
                emptyState={
                  transcript.loading ? (
                    <Spinner label="Loading the conversation" />
                  ) : (
                    <EmptyState
                      title="Nothing yet"
                      description="Write the first message below. The agent starts working in its workspace when it arrives."
                      isCompact
                    />
                  )
                }
              >
                {transcript.timeline.blocks.length === 0 ? null : (
                  <Transcript timeline={transcript.timeline} runtime={summary.runtime} />
                )}
              </ChatMessageList>
            </ChatLayout>
          </LayoutContent>
        }
      />
      {narrow && ws !== undefined && (
        <BottomSheet isOpen={showChanges} onOpenChange={setShowChanges} label="Changes" height="tall">
          <ChangesView workspaceId={ws.id} />
        </BottomSheet>
      )}
    </>
  );
}

const CHANGES_KEY = "rowrow.changesOpen";

const styles = stylex.create({
  // The chat fills the page below the header and scrolls inside itself, so the composer stays put.
  chat: { height: "100%", minHeight: 0 },
});

function formatTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);
}
