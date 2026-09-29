import { useSyncExternalStore } from "react";

/** Whether a media query matches, kept current. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
  );
}

/** Phone-width layout: the same breakpoint as Tailwind's `md`, where the side nav becomes a sheet. */
export function useNarrow(): boolean {
  return useMedia("(max-width: 767px)");
}

/** Room for the conversation and the inspector side by side (beside the side nav). */
export function useWide(): boolean {
  return useMedia("(min-width: 1100px)");
}
