// A whole file highlighted for the Files preview: the shared highlighter and themes the diffs
// use (DiffView), so a file reads like its diff. Big files stay plain text: highlighting runs on
// the page's thread, and a megabyte of it would hold the page up.
import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";
import { useEffect, useState } from "react";
import { report } from "./telemetry.ts";

const THEME = { light: "github-light", dark: "tokyo-night" } as const;
/** Past this many characters a file shows as plain text. */
export const HIGHLIGHT_MAX_CHARS = 300_000;

/**
 * The file's lines as highlighted HTML (what goes inside its `<pre>`), or null: while the
 * highlighter loads, for a file it has no grammar for, or for a big one.
 */
export function useHighlightedLines(path: string, text: string | undefined, dark: boolean): string | null {
  const [done, setDone] = useState<{ path: string; text: string; dark: boolean; html: string } | null>(null);
  useEffect(() => {
    if (text === undefined || text.length > HIGHLIGHT_MAX_CHARS) return;
    const lang = getFiletypeFromFileName(path);
    if (lang === "text") return;
    const theme = dark ? THEME.dark : THEME.light;
    let cancelled = false;
    void (async () => {
      try {
        const highlighter = await getSharedHighlighter({ themes: [theme], langs: [lang] });
        if (cancelled) return;
        // shiki's <pre> carries its own background and padding: keep just the code.
        const html = highlighter
          .codeToHtml(text, { lang, theme })
          .replace(/^<pre[^>]*>/, "")
          .replace(/<\/pre>$/, "");
        setDone({ path, text, dark, html });
      } catch (error) {
        report("warn", "files.highlight_failed", error, { lang });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, text, dark]);
  return done !== null && done.path === path && done.text === text && done.dark === dark ? done.html : null;
}
