// What the app is called on this server (settings.instanceName, roamgate #368): "rowrow · Work"
// in the tab's title, and on the Home Screen when it's installed. The server serves the page and
// the manifest with it already; this keeps them current when it changes while the page is open.
import { useEffect } from "react";
import { appName } from "../../shared/schemas.ts";
import { useApp } from "./store.ts";

export function useAppName(): void {
  const name = useApp((s) => appName(s.state?.settings.instanceName ?? ""));
  useEffect(() => {
    if (document.title === name) return;
    document.title = name;
    for (const meta of document.querySelectorAll(
      'meta[name="apple-mobile-web-app-title"], meta[name="application-name"]',
    ))
      meta.setAttribute("content", name);
    // A browser reads the manifest once per <link>: a new one makes it read the new name.
    const link = document.querySelector('link[rel="manifest"]');
    link?.replaceWith(link.cloneNode());
  }, [name]);
}
