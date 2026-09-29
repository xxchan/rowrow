import "./index.css";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { connection } from "./lib/connection.ts";
import { registerServiceWorker } from "./lib/push.ts";
import { RouterLink } from "./lib/router.ts";
import { installGlobalHandlers } from "./lib/telemetry.ts";

installGlobalHandlers();
connection.start();
void registerServiceWorker();

const root = document.getElementById("root");
if (root === null) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <Theme theme={neutralTheme} mode="system">
      <LinkProvider component={RouterLink}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </LinkProvider>
    </Theme>
  </StrictMode>,
);
