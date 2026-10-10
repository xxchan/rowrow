import "./index.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { connection } from "./lib/connection.ts";
import { inDesktopApp, registerServiceWorker } from "./lib/push.ts";
import { installGlobalHandlers } from "./lib/telemetry.ts";
import { startTheme } from "./lib/theme.ts";

installGlobalHandlers();
// The Mac app draws no title bar: the page leaves room for its window buttons (index.css, D-057).
if (inDesktopApp()) document.documentElement.dataset.chrome = "mac";
startTheme();
connection.start();
void registerServiceWorker();

const root = document.getElementById("root");
if (root === null) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </TooltipProvider>
  </StrictMode>,
);
