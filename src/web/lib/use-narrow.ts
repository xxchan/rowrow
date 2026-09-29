import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  const media = matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Phone-width layout: the same breakpoint as Tailwind's `md`, where the side nav becomes a sheet. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => matchMedia(QUERY).matches);
}
