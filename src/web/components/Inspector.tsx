// The workspace inspector, beside an agent or on a workspace's page: what changed (and
// review comments on it), the files (search and preview), the history (commits and the
// branch's pull request), and commands run there (D-052). Tabs stay mounted, so switching
// keeps a search, a commit or a command's output open. A folder that isn't a git checkout has
// only Commands. A file asked for (a path clicked in the transcript, Open in Files on a diff)
// turns it to Files, which shows it (lib/file-links.ts).
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { lazy, Suspense, useEffect, useEffectEvent } from "react";
import { readPref, writePref } from "../lib/device-prefs.ts";
import { onFileOpen } from "../lib/file-links.ts";
import { ChangesView } from "./ChangesView.tsx";
import { CommandsTab } from "./CommandsTab.tsx";
import { HistoryTab } from "./HistoryTab.tsx";

// The file tree (@pierre/trees) loads after the app, not with it.
const FilesTab = lazy(async () => ({ default: (await import("./FilesTab.tsx")).FilesTab }));

export type InspectorTab = "changes" | "files" | "history" | "commands";

const TAB =
  "flex-none rounded-none border-0 border-b-2 border-transparent px-3 text-xs text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-primary dark:data-[state=active]:bg-transparent";
const PANE = "mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden";

export function Inspector({
  workspaceId,
  agentId,
  git = true,
  tab,
  onTabChange,
  onDelivered,
}: {
  workspaceId: string;
  agentId?: string;
  /** A git checkout: false leaves only Commands. */
  git?: boolean;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onDelivered?: () => void;
}) {
  const toFiles = useEffectEvent(() => {
    if (tab !== "files") onTabChange("files");
  });
  useEffect(
    () =>
      onFileOpen((request) => {
        if (git && request.workspaceId === workspaceId) toFiles();
      }),
    [git, workspaceId],
  );
  return (
    <Tabs
      value={git ? tab : "commands"}
      onValueChange={(value) => onTabChange(value as InspectorTab)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList
        aria-label="Inspector"
        className="h-9 w-full shrink-0 justify-start rounded-none border-b bg-transparent p-0 px-1"
      >
        {git && (
          <>
            <TabsTrigger value="changes" className={TAB}>
              Changes
            </TabsTrigger>
            <TabsTrigger value="files" className={TAB}>
              Files
            </TabsTrigger>
            <TabsTrigger value="history" className={TAB}>
              History
            </TabsTrigger>
          </>
        )}
        <TabsTrigger value="commands" className={TAB}>
          Commands
        </TabsTrigger>
      </TabsList>
      {git && (
        <>
          <TabsContent value="changes" forceMount className={PANE}>
            <ChangesView
              workspaceId={workspaceId}
              {...(agentId === undefined ? {} : { agentId })}
              {...(onDelivered === undefined ? {} : { onDelivered })}
            />
          </TabsContent>
          <TabsContent value="files" forceMount className={PANE}>
            <Suspense>
              <FilesTab workspaceId={workspaceId} {...(agentId === undefined ? {} : { agentId })} />
            </Suspense>
          </TabsContent>
          <TabsContent value="history" forceMount className={PANE}>
            <HistoryTab workspaceId={workspaceId} />
          </TabsContent>
        </>
      )}
      <TabsContent value="commands" forceMount className={PANE}>
        <CommandsTab
          workspaceId={workspaceId}
          {...(agentId === undefined ? {} : { agentId })}
          {...(onDelivered === undefined ? {} : { onDelivered })}
        />
      </TabsContent>
    </Tabs>
  );
}

const TAB_KEY = "rowrow.inspectorTab";

/** The tab the inspector opens on: the last one picked on this device (switching stays per tab). */
export function savedInspectorTab(): InspectorTab {
  const saved = readPref(TAB_KEY);
  return saved === "files" || saved === "history" || saved === "commands" ? saved : "changes";
}

export function saveInspectorTab(tab: InspectorTab): void {
  writePref(TAB_KEY, tab);
}
