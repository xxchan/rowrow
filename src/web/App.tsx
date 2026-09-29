import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Shell } from "./components/Shell.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { useApp, useConnection } from "./lib/store.ts";
import { usePresence } from "./lib/presence.ts";
import { useRoute } from "./lib/router.ts";
import { AgentPage } from "./pages/AgentPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { WorkspacePage } from "./pages/WorkspacePage.tsx";

export function App() {
  const status = useConnection((s) => s.status);
  const state = useApp((s) => s.state);
  const route = useRoute();
  usePresence(route);

  if (status.kind === "signed-out") return <SignIn />;
  if (state === null) {
    return (
      <Center height="100%">
        <Spinner size="lg" label="Connecting to rowrow" />
      </Center>
    );
  }
  return (
    <Shell route={route}>
      {route.name === "home" && <HomePage />}
      {route.name === "agent" && <AgentPage key={route.agentId} agentId={route.agentId} />}
      {route.name === "workspace" && (
        <WorkspacePage key={route.workspaceId} workspaceId={route.workspaceId} />
      )}
      {route.name === "settings" && <SettingsPage />}
      {route.name === "not-found" && (
        <EmptyState title="Nothing here" description={`No page at ${route.path}.`} />
      )}
    </Shell>
  );
}
