// The workspace inspector, beside an agent or on a workspace's page: what changed (and
// review comments on it), the files (search and preview), and the history (commits and the
// branch's pull request). Tabs stay mounted, so switching keeps a search or a commit open.
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { lazy, Suspense } from "react";
import { readPref, writePref } from "../lib/device-prefs.ts";
import { ChangesView } from "./ChangesView.tsx";
import { HistoryTab } from "./HistoryTab.tsx";

// The file tree (@pierre/trees) loads after the app, not with it.
const FilesTab = lazy(async () => ({ default: (await import("./FilesTab.tsx")).FilesTab }));

export type InspectorTab = "changes" | "files" | "history";

const TAB =
  "flex-none rounded-none border-0 border-b-2 border-transparent px-3 text-xs text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-primary dark:data-[state=active]:bg-transparent";
const PANE = "mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden";

export function Inspector({
  workspaceId,
  agentId,
  tab,
  onTabChange,
  onDelivered,
}: {
  workspaceId: string;
  agentId?: string;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onDelivered?: () => void;
}) {
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as InspectorTab)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList
        aria-label="Inspector"
        className="h-9 w-full shrink-0 justify-start rounded-none border-b bg-transparent p-0 px-1"
      >
        <TabsTrigger value="changes" className={TAB}>
          Changes
        </TabsTrigger>
        <TabsTrigger value="files" className={TAB}>
          Files
        </TabsTrigger>
        <TabsTrigger value="history" className={TAB}>
          History
        </TabsTrigger>
      </TabsList>
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
    </Tabs>
  );
}

const TAB_KEY = "rowrow.inspectorTab";

/** The tab the inspector opens on: the last one picked on this device (switching stays per tab). */
export function savedInspectorTab(): InspectorTab {
  const saved = readPref(TAB_KEY);
  return saved === "files" || saved === "history" ? saved : "changes";
}

export function saveInspectorTab(tab: InspectorTab): void {
  writePref(TAB_KEY, tab);
}
