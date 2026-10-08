// A Mermaid diagram, from a ```mermaid fence in Markdown or from a .mmd file (roamgate #26,
// #159, #346, #350): drawn in the app's colors, sized to its content, zoomable, with fullscreen.
// What it says while it draws, when there's nothing to draw, and when Mermaid can't draw it
// (with the source a click away) follow roamgate.
import { cn } from "@/lib/utils";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { CustomRenderer, CustomRendererProps } from "streamdown";
import { emptyDiagram, mermaidSource } from "../lib/diagram.ts";
import type { Drawn } from "../lib/mermaid.ts";
import { useTheme } from "../lib/theme.ts";
import { ZoomablePreview } from "./ZoomablePreview.tsx";

type State = { kind: "drawing" } | { kind: "error"; error: string } | ({ kind: "drawn" } & Drawn);

export function MermaidDiagram({
  code,
  pending = false,
  fill = false,
  className,
}: {
  code: string;
  /** Still streaming in: wait for the fence to close before drawing. */
  pending?: boolean;
  /** Fill the space it's given: a file preview. */
  fill?: boolean;
  className?: string | undefined;
}) {
  const { dark } = useTheme();
  const [state, setState] = useState<State>({ kind: "drawing" });
  const empty = !pending && emptyDiagram(code);

  useEffect(() => {
    if (pending || empty) return;
    let cancelled = false;
    // A theme change redraws in place: the old drawing stays until the new one is ready.
    void (async () => {
      try {
        const { drawMermaid } = await import("../lib/mermaid.ts");
        const drawn = await drawMermaid(mermaidSource(code), dark);
        if (!cancelled) setState({ kind: "drawn", ...drawn });
      } catch (error) {
        // Mermaid's own words for what's wrong with the diagram, shown with its source.
        if (!cancelled)
          setState({ kind: "error", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, dark, pending, empty]);

  const frame = cn(fill ? "m-4" : "my-3", className);
  if (empty) {
    return (
      <div
        data-mermaid
        className={cn(frame, "flex justify-center px-3 py-6 text-[13px] text-muted-foreground")}
      >
        Empty diagram
      </div>
    );
  }
  if (pending || state.kind === "drawing") {
    return (
      <div
        data-mermaid
        role="status"
        aria-live="polite"
        className={cn(frame, "flex items-center gap-2 text-[13px] text-muted-foreground")}
      >
        <LoaderCircle className="size-3.5 animate-spin" /> Rendering diagram
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        data-mermaid
        role="alert"
        className={cn(
          frame,
          "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive",
        )}
      >
        <p className="whitespace-pre-wrap">Mermaid render failed: {state.error}</p>
        <details className="mt-2">
          <summary className="cursor-pointer">Show diagram source</summary>
          <pre className="mt-1 max-h-60 overflow-auto font-mono text-xs text-foreground">
            <code>{code}</code>
          </pre>
        </details>
      </div>
    );
  }
  return (
    <ZoomablePreview
      // A new diagram starts at Fit; the same one redrawn for a new theme keeps its zoom.
      key={code}
      size={state}
      label="Mermaid diagram"
      fill={fill}
      className={fill ? className : frame}
    >
      <div
        data-mermaid
        role="img"
        aria-label="Mermaid diagram"
        className="size-full [&>svg]:block [&>svg]:size-full! [&>svg]:max-w-none!"
        // drawMermaid sanitized it (lib/mermaid.ts).
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    </ZoomablePreview>
  );
}

function MermaidFence({ code, isIncomplete }: CustomRendererProps) {
  return <MermaidDiagram code={code} pending={isIncomplete} />;
}

/** Streamdown's renderer for ```mermaid fences, in the transcript and in Markdown previews. */
export const mermaidRenderer: CustomRenderer = { language: "mermaid", component: MermaidFence };
