// A small router: four kinds of pages don't need a routing library. Routes are plain
// paths, so every page has a URL you can paste, bookmark, or open from a notification.
import { createElement, forwardRef, useSyncExternalStore, type AnchorHTMLAttributes } from "react";

export type Route =
  | { readonly name: "home" }
  | { readonly name: "agent"; readonly agentId: string }
  | { readonly name: "workspace"; readonly workspaceId: string }
  | { readonly name: "settings" }
  | { readonly name: "not-found"; readonly path: string };

export function parse(pathname: string): Route {
  const parts = pathname.split("/").filter((part) => part !== "");
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "a" && parts[1] !== undefined)
    return { name: "agent", agentId: decodeURIComponent(parts[1]) };
  if (parts[0] === "w" && parts[1] !== undefined)
    return { name: "workspace", workspaceId: decodeURIComponent(parts[1]) };
  if (parts[0] === "settings") return { name: "settings" };
  return { name: "not-found", path: pathname };
}

const CHANGE = "rowrow:navigate";

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === location.pathname + location.search) return;
  if (options.replace === true) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

let cachedPath = "";
let cachedRoute: Route = { name: "home" };
function snapshot(): Route {
  if (location.pathname !== cachedPath) {
    cachedPath = location.pathname;
    cachedRoute = parse(cachedPath);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * An <a> that navigates inside the app for plain clicks on local links (and lets the
 * browser handle modified clicks, new tabs and external links). Every in-app link uses it.
 */
export const RouterLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  function RouterLink(props, ref) {
    const { href, onClick, target } = props;
    return createElement("a", {
      ...props,
      ref,
      onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || href === undefined || target === "_blank") return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const url = new URL(href, location.href);
        if (
          url.origin !== location.origin ||
          url.pathname.startsWith("/api/") ||
          url.pathname.startsWith("/auth/")
        )
          return;
        event.preventDefault();
        navigate(url.pathname + url.search);
      },
    });
  },
);
