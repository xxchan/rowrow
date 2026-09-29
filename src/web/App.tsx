import { LoaderCircle } from "lucide-react";
import { EmptyState } from "./components/EmptyState.tsx";
import { PageHeader, Shell } from "./components/Shell.tsx";
import { usePresence } from "./lib/presence.ts";
import { useRoute } from "./lib/router.ts";
import { useApp, useConnection } from "./lib/store.ts";
import { AgentPage } from "./pages/AgentPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { WorkspacePage } from "./pages/WorkspacePage.tsx";

export function App() {
  const status = useConnection((s) => s.status);
  const state = useApp((s) => s.state);
  const route = useRoute();
  usePresence(route);

  if (status.kind === "signed-out") return <SignIn />;
  if (state === null) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle className="size-4 animate-spin" /> Connecting to rowrow
      </div>
    );
  }
  return (
    <Shell route={route}>
      {route.name === "home" && <HomePage route={route} />}
      {route.name === "agent" && <AgentPage key={route.agentId} agentId={route.agentId} route={route} />}
      {route.name === "workspace" && (
        <WorkspacePage key={route.workspaceId} workspaceId={route.workspaceId} route={route} />
      )}
      {route.name === "settings" && <SettingsPage route={route} />}
      {route.name === "not-found" && (
        <>
          <PageHeader title="Not found" route={route} />
          <EmptyState title="Nothing here" description={`No page at ${route.path}.`} />
        </>
      )}
    </Shell>
  );
}
