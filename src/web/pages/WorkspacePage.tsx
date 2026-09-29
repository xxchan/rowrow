// One workspace: its git state, its agents, and its worktrees.
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ORPCError } from "@orpc/client";
import { useState } from "react";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Plus, RefreshCw } from "lucide-react";
import type { AppState, Workspace } from "../../shared/schemas.ts";
import { ChangesView } from "../components/ChangesView.tsx";
import { ErrorText } from "../components/ErrorText.tsx";
import { useNewAgent } from "../components/NewAgentDialog.tsx";
import { navigate } from "../lib/router.ts";
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

  const [newWorktree, setNewWorktree] = useState(false);
  const [removing, setRemoving] = useState<"ask" | "dirty" | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (force: boolean): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    try {
      await client.workspaces.removeWorktree({ id: ws.id, force });
      setRemoving(null);
      toast({ body: `Removed the worktree; branch ${git?.branch ?? ""} is kept.` });
      navigate(ws.parentId === null ? "/" : `/w/${ws.parentId}`);
    } catch (error) {
      if (!force && error instanceof ORPCError && error.code === "CONFLICT") setRemoving("dirty");
      else {
        setRemoving(null);
        toast({
          body: `Couldn't remove it: ${error instanceof Error ? error.message : String(error)}`,
          type: "error",
        });
      }
    } finally {
      setBusy(false);
    }
  };

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
    <>
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
                  {git !== null && !ws.missing && (
                    <MoreMenu
                      label="Workspace actions"
                      items={[
                        { label: "New worktree…", onClick: () => setNewWorktree(true) },
                        ...(git.linked
                          ? [{ label: "Remove this worktree…", onClick: () => setRemoving("ask") }]
                          : []),
                      ]}
                    />
                  )}
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
                    git.changed === 0
                      ? "clean"
                      : `${git.changed} changed file${git.changed === 1 ? "" : "s"}`,
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
              {git !== null && !ws.missing && (
                <VStack gap={1}>
                  <Text type="label">Changes</Text>
                  <ChangesView workspaceId={ws.id} />
                </VStack>
              )}
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
      <NewWorktreeDialog isOpen={newWorktree} onClose={() => setNewWorktree(false)} workspaceId={ws.id} />
      <AlertDialog
        isOpen={removing === "ask"}
        onOpenChange={(isOpen) => (isOpen ? undefined : setRemoving(null))}
        title="Remove this worktree?"
        description={`Deletes the checkout at ${ws.path}. The branch ${git?.branch ?? ""} is kept, so nothing committed is lost. Agents here stop.`}
        actionLabel="Remove"
        isActionLoading={busy}
        onAction={() => void remove(false)}
      />
      <AlertDialog
        isOpen={removing === "dirty"}
        onOpenChange={(isOpen) => (isOpen ? undefined : setRemoving(null))}
        title="It has uncommitted changes"
        description="Removing it now throws away the uncommitted changes in this checkout. Commit them first if you want to keep them."
        actionLabel="Discard changes and remove"
        isActionLoading={busy}
        onAction={() => void remove(true)}
      />
    </>
  );
}

function NewWorktreeDialog({
  isOpen,
  onClose,
  workspaceId,
}: {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
}) {
  const client = useClient();
  const toast = useToast();
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    setError(null);
    try {
      const { workspace, hook } = await client.workspaces.createWorktree({
        id: workspaceId,
        ...(branch.trim() === "" ? {} : { branch: branch.trim() }),
      });
      if (hook !== null && !hook.ok)
        toast({ body: `The setup hook failed: ${hook.output.slice(-300)}`, type: "error" });
      onClose();
      setBranch("");
      navigate(`/w/${workspace.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => (open ? undefined : onClose())}
      purpose="form"
      width={480}
    >
      <Layout
        header={
          <DialogHeader
            title="New worktree"
            subtitle="A new branch in its own checkout, from origin's default branch."
            onOpenChange={(open) => (open ? undefined : onClose())}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={2}>
              <TextInput
                label="Branch"
                value={branch}
                onChange={setBranch}
                placeholder="rowrow/… (a random name when empty)"
                width="100%"
                hasAutoFocus
                onEnter={() => void create()}
              />
              {error !== null && <ErrorText>{error}</ErrorText>}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Create" variant="primary" isLoading={busy} onClick={() => void create()} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
