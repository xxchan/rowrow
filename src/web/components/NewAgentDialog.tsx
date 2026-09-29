// Start an agent: pick a workspace (or add one from the server's disk), a runtime, a model
// and effort, and write the first prompt. The agent's run starts with that prompt.
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { LoaderCircle, Plus } from "lucide-react";
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
/** Radix Select items can't have an empty value; this one means "let the runtime pick". */
const DEFAULT = "__default";

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
    <Dialog open={isOpen} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="max-h-[92dvh] gap-0 overflow-y-auto p-0 sm:max-w-xl">
        {isOpen && <NewAgentForm onDone={close} />}
      </DialogContent>
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
  const [model, setModel] = useState(DEFAULT);
  const [effort, setEffort] = useState(DEFAULT);
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
        if (created.hook !== null && !created.hook.ok)
          report("warn", "worktree.setup_hook_failed", undefined, {
            output: created.hook.output.slice(-500),
          });
      }
      const { agent, sent } = await client.agents.create({
        workspaceId: target,
        runtime,
        ...(model === DEFAULT ? {} : { model }),
        ...(effort === DEFAULT ? {} : { effort }),
        ...(text === "" ? {} : { input: { inputId: newInputId(), text } }),
      });
      if (sent !== null && (sent.landed === "failed" || sent.landed === "rejected"))
        report("warn", "agent.first_input_not_delivered", undefined, {
          landed: sent.landed,
          reason: sent.reason,
        });
      onDone();
      navigate(`/a/${agent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      report("warn", "agent.create_failed", err);
    } finally {
      setBusy(false);
    }
  };

  if (adding)
    return (
      <AddWorkspace
        onCancel={workspaces.length === 0 ? onDone : () => setAdding(false)}
        onAdded={(id) => {
          setWorkspaceId(id);
          setAdding(false);
        }}
      />
    );

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle>New agent</DialogTitle>
        <DialogDescription>It works in the workspace's folder on this machine.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Workspace" htmlFor="new-agent-workspace">
          <div className="flex gap-2">
            <Select {...(workspaceId === null ? {} : { value: workspaceId })} onValueChange={setWorkspaceId}>
              <SelectTrigger id="new-agent-workspace" className="min-w-0 flex-1">
                <SelectValue placeholder="Choose a workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    <span className="truncate">{w.label}</span>
                    <span className="truncate text-xs text-muted-foreground">{w.path}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" onClick={() => setAdding(true)}>
              <Plus /> Add
            </Button>
          </div>
        </Field>
        <Field label="Agent" htmlFor="new-agent-runtime">
          <Select
            {...(runtime === null ? {} : { value: runtime })}
            onValueChange={(value) => {
              setRuntime(value);
              setModel(DEFAULT);
              setEffort(DEFAULT);
            }}
          >
            <SelectTrigger id="new-agent-runtime" className="w-full">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent>
              {runtimes.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                  {r.version !== null && <span className="text-xs text-muted-foreground">{r.version}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {runtimes.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No agent runtime is installed on this machine. Install Claude Code, Codex, Grok, Kimi or Pi,
              then refresh in Settings.
            </p>
          )}
        </Field>
        <div className="flex gap-3">
          <Field label="Model" htmlFor="new-agent-model" className="min-w-0 flex-1">
            <Select
              value={model}
              onValueChange={(value) => {
                setModel(value);
                setEffort(DEFAULT);
              }}
            >
              <SelectTrigger id="new-agent-model" className="w-full">
                {loaded === null ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <LoaderCircle className="animate-spin" /> Loading models
                  </span>
                ) : (
                  <SelectValue />
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>Default</SelectItem>
                {(loaded?.models ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {efforts.length > 0 && (
            <Field label="Effort" htmlFor="new-agent-effort" className="w-40">
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger id="new-agent-effort" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>Default</SelectItem>
                  {efforts.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
        {loaded?.error !== null && loaded?.error !== undefined && (
          <p className="text-xs text-muted-foreground">Models: {loaded.error}</p>
        )}
        {canIsolate && (
          <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <Label htmlFor="new-agent-worktree">Work in a new worktree</Label>
                <p className="text-xs text-muted-foreground">
                  A new branch from origin's default branch, in its own checkout, so parallel agents don't
                  collide.
                </p>
              </div>
              <Switch id="new-agent-worktree" checked={isolate} onCheckedChange={setIsolate} />
            </div>
            {isolate && (
              <Input
                aria-label="Branch"
                value={branch}
                onChange={(event) => setBranch(event.currentTarget.value)}
                placeholder="rowrow/… (a random name when empty)"
              />
            )}
          </div>
        )}
        <Field label="First message" htmlFor="new-agent-prompt">
          <Textarea
            id="new-agent-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            rows={5}
            placeholder="What should it do? (optional: you can also write to it later)"
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
        </Field>
        {error !== null && <ErrorText>{error}</ErrorText>}
      </div>
      <DialogFooter className="border-t px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || workspaceId === null || runtime === null}>
          {busy && <LoaderCircle className="animate-spin" />}
          {prompt.trim() === "" ? "Create" : "Create and send"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className === undefined ? "flex flex-col gap-1.5" : `flex flex-col gap-1.5 ${className}`}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
