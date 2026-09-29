// Start an agent: say what it should do; where and how it runs are already filled in from
// the page you opened it on and what you used there last (docs/decisions.md, D-023), so
// changing them is a chip, not a form. C opens it anywhere; on a phone it's a bottom sheet.
// The same composer sits at the top of the home page.
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Check, Cpu, Folder, FolderGit2, GitBranch, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { create } from "zustand";
import type { ModelInfo } from "../../shared/schemas.ts";
import { versionNumber } from "../lib/format.ts";
import { contextOf, loadPrefs, startAgent } from "../lib/new-agent.ts";
import { resolveSetup, type NewAgentContext } from "../lib/new-agent-setup.ts";
import { navigate, type Route } from "../lib/router.ts";
import { useApp, useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { useNarrow } from "../lib/use-narrow.ts";
import { AddWorkspace } from "./AddWorkspace.tsx";
import { AgentIcon } from "./AgentIcon.tsx";
import { ErrorText } from "./ErrorText.tsx";

/** On a touch screen Return is a newline, as in the composer. */
const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export const useNewAgent = create<{
  isOpen: boolean;
  /** Start in this workspace rather than the one the current page implies. */
  workspaceId: string | null;
  /** What you wrote and didn't send: closing keeps it for next time. */
  draft: string;
  open: (options?: { workspaceId?: string; draft?: string }) => void;
  close: () => void;
  setDraft: (draft: string) => void;
}>((set) => ({
  isOpen: false,
  workspaceId: null,
  draft: "",
  open: (options = {}) =>
    set((s) => ({ isOpen: true, workspaceId: options.workspaceId ?? null, draft: options.draft ?? s.draft })),
  close: () => set({ isOpen: false }),
  setDraft: (draft) => set({ draft }),
}));

export function NewAgentDialog({ route }: { route: Route }) {
  const { isOpen, workspaceId, draft, close, setDraft } = useNewAgent();
  const narrow = useNarrow();
  const context: NewAgentContext =
    workspaceId === null ? contextOf(route) : { kind: "workspace", workspaceId };
  const form = isOpen && (
    <NewAgentForm
      variant="dialog"
      context={context}
      draft={draft}
      onDraft={setDraft}
      onDone={(started) => {
        if (started) setDraft("");
        close();
      }}
    />
  );
  const onOpenChange = (open: boolean): void => (open ? undefined : close());
  if (narrow)
    return (
      <Sheet open={isOpen} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[92dvh] gap-0 overflow-y-auto rounded-t-xl bg-popover p-0 pb-[env(safe-area-inset-bottom)]"
        >
          {form}
        </SheetContent>
      </Sheet>
    );
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[16%] max-h-[80dvh] translate-y-0 gap-0 overflow-y-auto p-0 sm:max-w-xl"
      >
        {form}
      </DialogContent>
    </Dialog>
  );
}

type ChipName = "workspace" | "runtime" | "model";
const ALT_KEYS: Record<string, ChipName> = { KeyW: "workspace", KeyA: "runtime", KeyM: "model" };

export function NewAgentForm({
  variant,
  context,
  draft,
  onDraft,
  onDone,
}: {
  /** In the dialog (or the phone's sheet), or inline on the home page. */
  variant: "dialog" | "inline";
  context: NewAgentContext;
  draft: string;
  onDraft: (draft: string) => void;
  /** `started`: an agent was started (and is being navigated to); else you cancelled. */
  onDone: (started: boolean) => void;
}) {
  const client = useClient();
  const state = useApp((s) => s.state);
  const workspaces = useMemo(
    () =>
      Object.values(state?.workspaces ?? {})
        .filter((w) => !w.archived)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [state?.workspaces],
  );
  const runtimes = useMemo(
    () => Object.values(state?.runtimes ?? {}).filter((r) => r.installed),
    [state?.runtimes],
  );
  const [initial] = useState(() => (state === null ? null : resolveSetup(state, context, loadPrefs())));
  const [workspaceId, setWorkspaceId] = useState(initial?.workspaceId ?? null);
  const [runtime, setRuntime] = useState(initial?.runtime ?? null);
  const [model, setModel] = useState(initial?.model ?? null);
  const [effort, setEffort] = useState(initial?.effort ?? null);
  // One agent per worktree keeps parallel work apart (docs/decisions.md, D-007).
  const [isolate, setIsolate] = useState(initial?.isolate ?? false);
  const [branch, setBranch] = useState("");
  const [adding, setAdding] = useState(variant === "dialog" && workspaces.length === 0);
  const [chip, setChipState] = useState<ChipName | null>(null);
  const openChip = useRef<ChipName | null>(null);
  const setChip = (name: ChipName | null): void => {
    openChip.current = name;
    setChipState(name);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);

  const selected = workspaces.find((w) => w.id === workspaceId);
  const canIsolate = selected?.git !== null && selected?.git !== undefined;
  const isolated = isolate && canIsolate;
  const runtimeInfo = runtimes.find((r) => r.id === runtime);

  // Tagged with the runtime they belong to, so switching runtimes shows "loading" without resetting state in an effect.
  const [models, setModels] = useState<{ runtime: string; models: ModelInfo[]; error: string | null } | null>(
    null,
  );
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
  const modelInfo = loaded?.models.find((m) => m.id === model);
  const efforts = modelInfo?.effortLevels ?? [];
  // A remembered effort the model doesn't take is dropped; with a model we can't look up, it's kept.
  const effectiveEffort =
    modelInfo !== undefined && effort !== null && !efforts.includes(effort) ? null : effort;

  /** Picking another workspace brings the setup you last used there. */
  const pickWorkspace = (id: string): void => {
    setWorkspaceId(id);
    if (state === null) return;
    const setup = resolveSetup(state, { kind: "workspace", workspaceId: id }, loadPrefs());
    setRuntime(setup.runtime);
    setModel(setup.model);
    setEffort(setup.effort);
    setIsolate(setup.isolate);
  };

  const submit = async (forceIsolate: boolean): Promise<void> => {
    if (client === null || workspaceId === null || runtime === null || busy) return;
    const text = draft.trim();
    if (variant === "inline" && text === "") return;
    setBusy(true);
    setError(null);
    try {
      const id = await startAgent(client, {
        workspaceId,
        runtime,
        model,
        effort: effectiveEffort,
        isolate: canIsolate && (isolate || forceIsolate),
        branch: branch.trim(),
        text,
      });
      onDone(true);
      navigate(`/a/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      report("warn", "agent.create_failed", err);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit(event.shiftKey);
    } else if (event.altKey && !event.metaKey && !event.ctrlKey) {
      // By physical key: on a Mac, ⌥W types "∑".
      const name = ALT_KEYS[event.code];
      if (name !== undefined) {
        event.preventDefault();
        setChip(name);
      } else if (event.code === "KeyT" && canIsolate) {
        event.preventDefault();
        setIsolate((on) => !on);
      }
    }
  };

  if (adding)
    return (
      <AddWorkspace
        onCancel={workspaces.length === 0 ? () => onDone(false) : () => setAdding(false)}
        onAdded={(id) => {
          pickWorkspace(id);
          setAdding(false);
        }}
      />
    );

  // Closing a chip's menu goes back to writing, unless another menu opened meanwhile (⌥M, Esc, ⌥W).
  const backToPrompt = (event: Event): void => {
    event.preventDefault();
    if (openChip.current === null) prompt.current?.focus();
  };
  const chipMenu = (name: ChipName) => ({
    open: chip === name,
    // A closing menu mustn't close the one that just opened.
    onOpenChange: (open: boolean) => {
      if (open) setChip(name);
      else if (openChip.current === name) setChip(null);
    },
  });
  const inline = variant === "inline";
  const promptLabel = inline ? "What should a new agent do?" : "First message";
  const disabled = busy || workspaceId === null || runtime === null || (inline && draft.trim() === "");

  const chips = (
    <div className={cn("flex flex-wrap items-center gap-1.5", inline ? "px-3 pb-3" : "px-4 pb-3")}>
      <Popover {...chipMenu("workspace")}>
        <PopoverTrigger asChild>
          <Chip aria-label={`Workspace: ${selected?.label ?? "none"}`} title="Workspace (⌥W)">
            {selected?.git === null || selected === undefined ? <Folder /> : <FolderGit2 />}
            <span className="truncate">{selected?.label ?? "Choose a workspace"}</span>
          </Chip>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={8}
          className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col p-0"
          onCloseAutoFocus={backToPrompt}
        >
          <Command>
            <CommandInput placeholder="Filter workspaces…" />
            <CommandList>
              <CommandEmpty>No workspace matches.</CommandEmpty>
              <CommandGroup>
                {workspaces.map((w) => (
                  <CommandItem
                    key={w.id}
                    value={w.id}
                    keywords={[w.label, w.path, w.git?.branch ?? ""]}
                    onSelect={() => {
                      pickWorkspace(w.id);
                      setChip(null);
                    }}
                  >
                    {w.git === null ? <Folder /> : w.git.linked ? <GitBranch /> : <FolderGit2 />}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{w.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{w.path}</span>
                    </span>
                    {w.id === workspaceId && <Check className="ml-auto" />}
                  </CommandItem>
                ))}
              </CommandGroup>
              {!inline && (
                <CommandGroup>
                  <CommandItem
                    value="add-workspace"
                    keywords={["Add a workspace", "folder", "new"]}
                    onSelect={() => {
                      setChip(null);
                      setAdding(true);
                    }}
                  >
                    <Plus /> Add a workspace…
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Popover {...chipMenu("runtime")}>
        <PopoverTrigger asChild>
          <Chip aria-label={`Agent: ${runtimeInfo?.name ?? "none"}`} title="Agent (⌥A)">
            {runtimeInfo !== undefined && (
              <AgentIcon runtime={runtimeInfo.id} label={runtimeInfo.name} className="size-3.5" />
            )}
            <span className="truncate">{runtimeInfo?.name ?? "Choose an agent"}</span>
          </Chip>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={8}
          className="flex max-h-(--radix-popover-content-available-height) w-72 flex-col p-0"
          onCloseAutoFocus={backToPrompt}
        >
          <Command>
            <CommandList>
              <CommandEmpty>
                No agent runtime is installed on this machine. Install Claude Code, Codex, Grok, Kimi or Pi,
                then refresh in Settings.
              </CommandEmpty>
              <CommandGroup>
                {runtimes.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={r.id}
                    keywords={[r.name]}
                    onSelect={() => {
                      if (r.id !== runtime) {
                        setRuntime(r.id);
                        setModel(null);
                        setEffort(null);
                      }
                      setChip(null);
                    }}
                  >
                    <AgentIcon runtime={r.id} label={r.name} />
                    <span className="shrink-0 whitespace-nowrap">{r.name}</span>
                    {r.version !== null && (
                      <span title={r.version} className="ml-auto truncate text-xs text-muted-foreground">
                        {versionNumber(r.version)}
                      </span>
                    )}
                    <Check
                      className={cn(
                        "shrink-0",
                        r.version === null && "ml-auto",
                        r.id !== runtime && "invisible",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {runtime !== null && (
        <Popover {...chipMenu("model")}>
          <PopoverTrigger asChild>
            <Chip
              aria-label={`Model: ${model === null ? "default" : (modelInfo?.name ?? model)}${effectiveEffort === null ? "" : `, ${effectiveEffort} effort`}`}
              title="Model and effort (⌥M)"
            >
              <Cpu />
              <span className="truncate">
                {model === null ? "Default model" : (modelInfo?.name ?? model)}
              </span>
              {effectiveEffort !== null && <span className="text-muted-foreground">· {effectiveEffort}</span>}
            </Chip>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={8}
            className="flex max-h-(--radix-popover-content-available-height) w-72 flex-col p-0"
            onCloseAutoFocus={backToPrompt}
          >
            <ModelMenu
              loaded={loaded}
              model={model}
              effort={effectiveEffort}
              efforts={efforts}
              onModel={(id, done) => {
                if (id !== model) {
                  setModel(id);
                  setEffort(null);
                }
                if (done) setChip(null);
              }}
              onEffort={(level, done) => {
                setEffort(level);
                if (done) setChip(null);
              }}
            />
          </PopoverContent>
        </Popover>
      )}

      {canIsolate && (
        <Chip
          aria-pressed={isolated}
          title="Work in a new worktree: a new branch from origin's default branch, in its own checkout (⌥T)"
          className={cn(
            isolated
              ? "border-primary/50 bg-primary/10 text-foreground hover:bg-primary/15 [&_svg]:text-primary"
              : "text-muted-foreground",
          )}
          onClick={() => setIsolate(!isolated)}
        >
          <GitBranch />
          New worktree
        </Chip>
      )}
    </div>
  );

  const branchInput = isolated && (
    <div className={inline ? "px-3 pb-3" : "px-4 pb-3"}>
      <Input
        aria-label="Branch"
        value={branch}
        onChange={(event) => setBranch(event.currentTarget.value)}
        placeholder="Branch: rowrow/… (a random name when empty)"
        className="h-8"
      />
    </div>
  );

  const textarea = (
    <>
      <Label htmlFor={inline ? "home-new-agent-prompt" : "new-agent-prompt"} className="sr-only">
        {promptLabel}
      </Label>
      <Textarea
        ref={prompt}
        id={inline ? "home-new-agent-prompt" : "new-agent-prompt"}
        autoFocus={!inline}
        value={draft}
        onChange={(event) => onDraft(event.currentTarget.value)}
        placeholder={inline ? promptLabel : "What should it do? (optional: you can also write to it later)"}
        className={cn(
          "resize-none rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent",
          inline ? "min-h-11 px-3 pt-3 pb-1" : "max-h-[40dvh] min-h-28 px-4 pt-2 pb-2 md:text-[15px]",
        )}
        onKeyDown={(event) => {
          // Inline, Return starts it, as in the composer; in the dialog it's a newline and ⌘Return starts it.
          if (
            inline &&
            !touch &&
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.altKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void submit(false);
          }
        }}
      />
    </>
  );

  if (inline)
    return (
      <form
        aria-label="Start an agent"
        className="rounded-lg border bg-card transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/15"
        onKeyDown={onKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        {textarea}
        <div className="flex items-start">
          <div className="min-w-0 flex-1">{chips}</div>
          <Button type="submit" size="sm" className="mt-0 mr-3 mb-3" disabled={disabled}>
            {busy && <LoaderCircle className="animate-spin" />}
            Start agent
          </Button>
        </div>
        {branchInput}
        {error !== null && <ErrorText className="px-3 pb-3">{error}</ErrorText>}
      </form>
    );

  return (
    <form
      className="flex min-w-0 flex-col"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      <DialogHeader className="gap-0.5 px-4 pt-4 text-left">
        <DialogTitle className="text-[15px]">New agent</DialogTitle>
        <DialogDescription className="truncate text-xs">
          {selected === undefined
            ? "Pick a workspace for it to work in."
            : `In ${selected.path}${isolated ? ", on a new worktree" : ""}, on this machine.`}
        </DialogDescription>
      </DialogHeader>
      {textarea}
      {chips}
      {branchInput}
      {loaded?.error !== null && loaded?.error !== undefined && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">Models: {loaded.error}</p>
      )}
      {error !== null && <ErrorText className="px-4 pb-3">{error}</ErrorText>}
      <div className="flex items-center gap-2 border-t px-4 py-3">
        <p className="hidden min-w-0 flex-1 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground md:flex">
          <Kbd>⌘↵</Kbd> start
          {canIsolate && (
            <>
              <span className="px-1">·</span>
              <Kbd>⌘⇧↵</Kbd> in a new worktree
            </>
          )}
        </p>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={disabled}>
            {busy && <LoaderCircle className="animate-spin" />}
            {draft.trim() === "" ? "Create" : "Create and send"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** A setting shown as its value; opens its menu. */
function Chip({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "h-8 max-w-full min-w-0 gap-1.5 px-2.5 text-[13px] font-normal shadow-none md:h-7 md:text-xs [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Models, then the chosen model's effort levels. ←/→ change the effort while the filter is empty. */
function ModelMenu({
  loaded,
  model,
  effort,
  efforts,
  onModel,
  onEffort,
}: {
  loaded: { models: ModelInfo[]; error: string | null } | null;
  model: string | null;
  effort: string | null;
  efforts: string[];
  /** `done`: close the menu (there's no effort to pick, or it was picked again). */
  onModel: (model: string | null, done: boolean) => void;
  onEffort: (effort: string | null, done: boolean) => void;
}) {
  const [filter, setFilter] = useState("");
  const levels: (string | null)[] = [null, ...efforts];
  const list = loaded?.models ?? [];
  const unlisted = model !== null && loaded !== null && !list.some((m) => m.id === model);
  const pick = (id: string | null): void => {
    const takesEffort = (list.find((m) => m.id === id)?.effortLevels.length ?? 0) > 0;
    onModel(id, !takesEffort || id === model);
  };
  return (
    <Command>
      <CommandInput
        placeholder="Filter models…"
        value={filter}
        onValueChange={setFilter}
        onKeyDown={(event) => {
          if (filter !== "" || efforts.length === 0) return;
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const at = levels.indexOf(effort);
          const next = (at + (event.key === "ArrowRight" ? 1 : levels.length - 1)) % levels.length;
          onEffort(levels[next] ?? null, false);
        }}
      />
      <CommandList>
        {loaded === null ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading models
          </div>
        ) : (
          <>
            <CommandEmpty>No model matches.</CommandEmpty>
            <CommandGroup heading="Model">
              <CommandItem value="__default" keywords={["Default"]} onSelect={() => pick(null)}>
                Default
                {model === null && <Check className="ml-auto" />}
              </CommandItem>
              {unlisted && (
                <CommandItem value={model} onSelect={() => pick(model)}>
                  {model}
                  <Check className="ml-auto" />
                </CommandItem>
              )}
              {list.map((m) => (
                <CommandItem key={m.id} value={m.id} keywords={[m.name]} onSelect={() => pick(m.id)}>
                  {m.name}
                  {m.id === model && <Check className="ml-auto" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
      {efforts.length > 0 && (
        <div className="border-t p-2">
          <div className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">Effort</div>
          <div role="group" aria-label="Effort" className="flex overflow-hidden rounded-md border">
            {levels.map((level) => (
              <button
                key={level ?? "default"}
                type="button"
                aria-pressed={level === effort}
                onClick={() => onEffort(level, true)}
                className="flex-1 border-r px-1 py-1 text-xs text-muted-foreground last:border-r-0 hover:bg-accent aria-pressed:bg-primary aria-pressed:font-medium aria-pressed:text-primary-foreground"
              >
                {level ?? "Default"}
              </button>
            ))}
          </div>
        </div>
      )}
    </Command>
  );
}
