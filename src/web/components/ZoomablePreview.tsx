// A picture you can zoom and pan (roamgate #159, #346): zoom out, the zoom level, zoom in, Fit,
// 100% and fullscreen above it; scroll to pan, Ctrl/⌘ + wheel to zoom. Fullscreen fits the whole
// picture to the screen, keeps the zoom controls, and Escape comes back to where you were.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Expand, Maximize, Minus, Plus, Shrink } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fitScale, type Size } from "../lib/diagram.ts";

const MIN = 0.01;
const MAX = 8;

interface Zoom {
  /** null: fit. */
  readonly value: number | null;
  /** The middle of what was in view, as a fraction of the whole: it stays in the middle. */
  readonly center?: { readonly x: number; readonly y: number };
}

function zoomAbout(viewport: HTMLElement | null, value: number | null): Zoom {
  const zoom = { value: value === null ? null : Math.min(MAX, Math.max(MIN, value)) };
  if (viewport === null) return zoom;
  return {
    ...zoom,
    center: {
      x: (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth,
      y: (viewport.scrollTop + viewport.clientHeight / 2) / viewport.scrollHeight,
    },
  };
}

export function ZoomablePreview({
  size,
  label,
  fill = false,
  className,
  children,
}: {
  /** The picture's own size, at 100%. */
  size: Size;
  label: string;
  /** Fill the space it's given (a file preview) instead of fitting the width and growing to the picture's height. */
  fill?: boolean;
  className?: string | undefined;
  children: ReactNode;
}) {
  /** While fullscreen: the height it left behind, held so the page doesn't move. */
  const [fullscreen, setFullscreen] = useState<number | null>(null);
  const open = fullscreen !== null;
  // A state, not a ref: fullscreen moves the picture to a new viewport, and the effects follow it.
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState<Size>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<Zoom>({ value: null });
  const fitted = fitScale(size, room, !fill && !open);
  const scale = zoom.value ?? fitted;
  const previewRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (viewport === null) return;
    const measure = (): void => setRoom({ width: viewport.clientWidth, height: viewport.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);

  useLayoutEffect(() => {
    const center = zoom.center;
    if (viewport === null || center === undefined) return;
    viewport.scrollTo({
      left: center.x * viewport.scrollWidth - viewport.clientWidth / 2,
      top: center.y * viewport.scrollHeight - viewport.clientHeight / 2,
    });
  }, [viewport, zoom]);

  useEffect(() => {
    if (viewport === null) return;
    // A trackpad pinch arrives as Ctrl + wheel: zoom the picture, not the page.
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      setZoom(zoomAbout(viewport, scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [viewport, scale]);

  const control = "h-7 min-w-7 px-1.5 text-xs font-normal";
  const preview = (
    <div
      ref={previewRef}
      role="region"
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden bg-code",
        fill || open ? "min-h-0 flex-1" : "rounded-lg border",
        !open && className,
      )}
    >
      <div
        role="toolbar"
        aria-label={`${label} zoom controls`}
        className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b bg-card px-2 py-1 select-none"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className={control}
          aria-label="Zoom out"
          title="Zoom out"
          disabled={scale <= MIN}
          onClick={() => setZoom(zoomAbout(viewport, scale / 1.25))}
        >
          <Minus />
        </Button>
        <output
          aria-live="polite"
          aria-label="Zoom level"
          className="min-w-10 text-center text-xs text-muted-foreground tabular-nums"
        >
          {Math.round(scale * 100)}%
        </output>
        <Button
          variant="ghost"
          size="icon-sm"
          className={control}
          aria-label="Zoom in"
          title="Zoom in"
          disabled={scale >= MAX}
          onClick={() => setZoom(zoomAbout(viewport, scale * 1.25))}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(control, "aria-pressed:bg-accent aria-pressed:text-accent-foreground")}
          title="Fit preview"
          aria-pressed={zoom.value === null}
          onClick={() => setZoom(zoomAbout(viewport, null))}
        >
          <Maximize className="size-3.5" /> Fit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={control}
          title="Actual size"
          onClick={() => setZoom(zoomAbout(viewport, 1))}
        >
          100%
        </Button>
        <Button
          ref={toggleRef}
          variant="ghost"
          size="icon-sm"
          className={cn(control, "ml-auto")}
          aria-label={open ? "Exit fullscreen" : "Fullscreen"}
          title={open ? "Exit fullscreen (Esc)" : "Fullscreen"}
          onClick={() => setFullscreen(open ? null : (previewRef.current?.offsetHeight ?? 0))}
        >
          {open ? <Shrink /> : <Expand />}
        </Button>
      </div>
      <div
        ref={setViewport}
        tabIndex={0}
        role="region"
        aria-label={`${label} viewport`}
        title="Scroll to pan. Ctrl/Cmd + wheel to zoom."
        className={cn(
          "relative min-h-0 min-w-0 touch-pan-x touch-pan-y overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
          (fill || open) && "flex-1",
        )}
        // Inline, the picture fits the width and the viewport grows to its height at that zoom.
        style={fill || open ? undefined : { height: size.height * fitted + 32 }}
      >
        <div className="box-border grid min-h-full w-max min-w-full place-items-center p-4">
          <div className="shrink-0" style={{ width: size.width * scale, height: size.height * scale }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Fullscreen moves the picture (one copy, so its ids stay unique) and holds its place here. */}
      {open ? <div aria-hidden="true" className={className} style={{ height: fullscreen }} /> : preview}
      <Dialog open={open} onOpenChange={(next) => !next && setFullscreen(null)}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-code p-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] data-[state=closed]:animate-none data-[state=open]:animate-none sm:max-w-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            toggleRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            toggleRef.current?.focus();
          }}
          // The app's own shortcuts wait until you leave fullscreen.
          onKeyDown={(event) => event.stopPropagation()}
        >
          <DialogTitle className="sr-only">{`${label} fullscreen`}</DialogTitle>
          {open && preview}
        </DialogContent>
      </Dialog>
    </>
  );
}
