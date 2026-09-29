// Start an agent: pick a workspace (or add one from the server's disk), a runtime, a model
// and effort, and write the first prompt. The agent's run starts with that prompt.
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { newInputId } from "../../shared/ids.ts";
import type { ModelInfo } from "../../shared/schemas.ts";
import { navigate } from "../lib/router.ts";
import { useApp, useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { AddWorkspace } from "./AddWorkspace.tsx";
import { ErrorText } from "./ErrorText.tsx";

const LAST_RUNTIME = "rowrow.lastRuntime";

export const useNewAgent = create<{
  isOpen: boolean;
  workspaceId: string | null;
  open: (options: { workspaceId?: string }) => void;
  close: () => void;
}>((set) => ({
  isOpen: false,
  workspaceId: null,
  open: ({ workspaceId }) => set({ isOpen: true, workspaceId: workspaceId ?? null }),
  close: () => set({ isOpen: false }),
}));

export function NewAgentDialog() {
  const { isOpen, close } = useNewAgent();
  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => (open ? undefined : close())} purpose="form" width={560}>
      {isOpen && <NewAgentForm onDone={close} />}
    </Dialog>
  );
}

function NewAgentForm({ onDone }: { onDone: () => void }) {
  const client = useClient();
  const state = useApp((s) => s.state);
  const initialWorkspace = useNewAgent((s) => s.workspaceId);
  const workspaces = useMemo(
    () => Object.values(state?.workspaces ?? {}).filter((w) => !w.archived),
    [state?.workspaces],
  );
  const runtimes = useMemo(
    () => Object.values(state?.runtimes ?? {}).filter((r) => r.installed),
    [state?.runtimes],
  );
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    initialWorkspace ?? workspaces[0]?.id ?? null,
  );
  const [adding, setAdding] = useState(workspaces.length === 0);
  const [runtime, setRuntime] = useState<string | null>(() => {
    const last = localStorage.getItem(LAST_RUNTIME);
    return (
      runtimes.find((r) => r.id === last)?.id ??
      runtimes.find((r) => r.id === "claude")?.id ??
      runtimes[0]?.id ??
      null
    );
  });
  // Tagged with the runtime they belong to, so switching runtimes shows "loading" without resetting state in an effect.
  const [models, setModels] = useState<{ runtime: string; models: ModelInfo[]; error: string | null } | null>(
    null,
  );
  const [model, setModel] = useState<string>("");
  const [effort, setEffort] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  // One agent per worktree keeps parallel work apart (docs/decisions.md, D-007).
  const [isolate, setIsolate] = useState(false);
  const [branch, setBranch] = useState("");
  const selected = workspaces.find((w) => w.id === workspaceId);
  const canIsolate = selected?.git !== null && selected?.git !== undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (client === null || runtime === null) return;
    let cancelled = false;
    void (async () => {
      let result: { models: ModelInfo[]; error: string | null };
      try {
        result = await client.runtimes.models({ runtime });
      } catch (err) {
        result = { models: [], error: err instanceof Error ? err.message : String(err) };
      }
      if (!cancelled) setModels({ runtime, ...result });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, runtime]);

  const loaded = models?.runtime === runtime ? models : null;
  const chooseRuntime = (value: string): void => {
    setRuntime(value);
    setModel("");
    setEffort("");
  };

  const efforts = loaded?.models.find((m) => m.id === model)?.effortLevels ?? [];

  const submit = async (): Promise<void> => {
    if (client === null || workspaceId === null || runtime === null) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(LAST_RUNTIME, runtime);
      const text = prompt.trim();
      let target = workspaceId;
      if (isolate && canIsolate) {
        const created = await client.workspaces.createWorktree({
          id: workspaceId,
          ...(branch.trim() === "" ? {} : { branch: branch.trim() }),
        });
        target = created.workspace.id;
        if (created.hook !== null && !created.hook.ok) {
          report("warn", "worktree.setup_hook_failed", undefined, {
            output: created.hook.output.slice(-500),
          });
        }
      }
      const { agent, sent } = await client.agents.create({
        workspaceId: target,
        runtime,
        ...(model === "" ? {} : { model }),
        ...(effort === "" ? {} : { effort }),
        ...(text === "" ? {} : { input: { inputId: newInputId(), text } }),
      });
      if (sent !== null && (sent.landed === "failed" || sent.landed === "rejected")) {
        report("warn", "agent.first_input_not_delivered", undefined, {
          landed: sent.landed,
          reason: sent.reason,
        });
      }
      onDone();
      navigate(`/a/${agent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      report("warn", "agent.create_failed", err);
    } finally {
      setBusy(false);
    }
  };

  if (adding) {
    return (
      <AddWorkspace
        onCancel={workspaces.length === 0 ? onDone : () => setAdding(false)}
        onAdded={(id) => {
          setWorkspaceId(id);
          setAdding(false);
        }}
      />
    );
  }

  return (
    <Layout
      header={<DialogHeader title="New agent" onOpenChange={(open) => (open ? undefined : onDone())} />}
      content={
        <LayoutContent>
          <VStack gap={3}>
            <HStack gap={2} vAlign="end">
              <Selector
                label="Workspace"
                options={workspaces.map((w) => ({ value: w.id, label: w.label, description: w.path }))}
                {...(workspaceId === null ? {} : { value: workspaceId })}
                onChange={setWorkspaceId}
                hasSearch={workspaces.length > 8}
                width="100%"
              />
              <Button label="Add…" variant="secondary" onClick={() => setAdding(true)} />
            </HStack>
            <Selector
              label="Agent"
              options={runtimes.map((r) => ({
                value: r.id,
                label: r.name,
                ...(r.version === null ? {} : { description: r.version }),
              }))}
              {...(runtime === null ? {} : { value: runtime })}
              onChange={chooseRuntime}
              width="100%"
            />
            {canIsolate && (
              <VStack gap={1}>
                <Switch
                  label="Work in a new worktree"
                  description="A new branch from origin's default branch, in its own checkout, so parallel agents don't collide."
                  value={isolate}
                  onChange={setIsolate}
                />
                {isolate && (
                  <TextInput
                    label="Branch"
                    value={branch}
                    onChange={setBranch}
                    placeholder="rowrow/… (a random name when empty)"
                    width="100%"
                  />
                )}
              </VStack>
            )}
            {runtimes.length === 0 && (
              <Text type="supporting">
                No agent runtime is installed on this machine. Install Claude Code, Codex, Grok, Kimi or Pi,
                then refresh in Settings.
              </Text>
            )}
            <HStack gap={2}>
              <Selector
                label="Model"
                options={[
                  { value: "", label: "Default" },
                  ...(loaded?.models ?? []).map((m) => ({ value: m.id, label: m.name })),
                ]}
                value={model}
                onChange={(value) => {
                  setModel(value);
                  setEffort("");
                }}
                isLoading={loaded === null}
                width="100%"
                hasSearch={(loaded?.models.length ?? 0) > 8}
              />
              {efforts.length > 0 && (
                <Selector
                  label="Effort"
                  options={[
                    { value: "", label: "Default" },
                    ...efforts.map((level) => ({ value: level, label: level })),
                  ]}
                  value={effort}
                  onChange={setEffort}
                  width={180}
                />
              )}
            </HStack>
            {loaded?.error !== null && loaded?.error !== undefined && (
              <Text type="supporting">Models: {loaded.error}</Text>
            )}
            <TextArea
              label="First message"
              value={prompt}
              onChange={setPrompt}
              rows={5}
              placeholder="What should it do? (optional: you can also write to it later)"
              width="100%"
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {error !== null && <ErrorText>{error}</ErrorText>}
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="secondary" onClick={onDone} />
            <Button
              label={prompt.trim() === "" ? "Create" : "Create and send"}
              variant="primary"
              isLoading={busy}
              isDisabled={workspaceId === null || runtime === null}
              onClick={() => void submit()}
            />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}
