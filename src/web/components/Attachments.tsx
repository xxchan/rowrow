// Files in a message: the tiles above the composer (what your next message carries) and the
// ones under a message you sent. Images show as themselves, videos as their first frame; any
// other file as its name and kind. Sent images are fetched back from the server (files.get),
// once per page; a sent video only when you open it, since videos are big and phones metered.
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CircleAlert, LoaderCircle, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Attachment } from "../../shared/entries.ts";
import { useClient, type PendingAttachment } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";

const TILE = "relative size-24 shrink-0 overflow-hidden rounded-xl border bg-background";

/** The image types the server sends back as images (and every runtime takes as image input). */
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const isVideo = (type: string): boolean => type.startsWith("video/");

function PlayBadge() {
  return (
    <span className="pointer-events-none absolute bottom-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-background/85 text-foreground shadow-sm">
      <Play className="size-3 fill-current" />
    </span>
  );
}

/** "MD", "PNG": what a file is, from its name. */
function kindOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name
        .slice(dot + 1)
        .toUpperCase()
        .slice(0, 5)
    : "FILE";
}

/** A file as its name and kind; `inset` puts the name under the remove button in the corner. */
function FileFace({ name, inset = false }: { name: string; inset?: boolean }) {
  return (
    <div className="flex size-full flex-col justify-between p-2 text-left">
      <span className={cn("text-xs leading-snug break-all", inset ? "mt-5 line-clamp-2" : "line-clamp-3")}>
        {name}
      </span>
      <span className="self-start rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        {kindOf(name)}
      </span>
    </div>
  );
}

/** What the next message carries, above the composer's text. */
export function ComposerAttachments({
  items,
  onRemove,
}: {
  items: readonly PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  if (items.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Attachments"
      className="flex gap-2 overflow-x-auto px-3 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(TILE, item.state === "failed" && "border-destructive/60")}
          title={item.error ?? item.name}
        >
          {item.preview !== null && !broken.has(item.id) && isVideo(item.type) ? (
            <>
              {/* #t: Safari shows a blank tile until it has a frame to show. */}
              <video
                src={`${item.preview}#t=0.1`}
                aria-label={item.name}
                muted
                playsInline
                preload="metadata"
                className="size-full object-cover"
                onError={() => setBroken((current) => new Set(current).add(item.id))}
              />
              <PlayBadge />
            </>
          ) : item.preview !== null && !broken.has(item.id) ? (
            <img
              src={item.preview}
              alt={item.name}
              className="size-full object-cover"
              onError={() => setBroken((current) => new Set(current).add(item.id))}
            />
          ) : (
            <FileFace name={item.name} inset />
          )}
          {item.state === "uploading" && (
            <div className="absolute inset-0 grid place-items-center bg-background/60">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-label="Uploading" />
            </div>
          )}
          {item.state === "failed" && (
            <div className="absolute inset-0 grid place-items-center bg-background/70 text-destructive">
              <CircleAlert className="size-5" aria-label={`Upload failed: ${item.error ?? ""}`} />
            </div>
          )}
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            onClick={() => onRemove(item.id)}
            className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-background/85 text-foreground shadow-sm hover:bg-background"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Object URLs of uploads fetched back for display, by server path: shared by every message. */
const fetched = new Map<string, Promise<string>>();

function useUploadUrl(path: string, wanted = true): { url: string | null; failed: boolean } {
  const client = useClient();
  const [result, setResult] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (client === null || !wanted) return;
    let cancelled = false;
    let pending = fetched.get(path);
    if (pending === undefined) {
      pending = client.files.get({ path }).then((file) => URL.createObjectURL(file));
      fetched.set(path, pending);
    }
    const loading = pending;
    void (async () => {
      try {
        const url = await loading;
        if (!cancelled) setResult({ url, failed: false });
      } catch (error) {
        // A failure is not kept: the next render may try again (after a reconnect, say).
        fetched.delete(path);
        if (!cancelled) setResult({ url: null, failed: true });
        report("warn", "attachment.fetch_failed", error, { path });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, path, wanted]);
  return result;
}

function SentVideo({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const { url, failed } = useUploadUrl(attachment.path, open);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" aria-label={`Play ${attachment.name}`} className={TILE} title={attachment.path}>
          <FileFace name={attachment.name} />
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-8 place-items-center rounded-full bg-background/85 shadow-sm">
              <Play className="size-3.5 fill-current" />
            </span>
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] w-auto max-w-[calc(100%-2rem)] p-2 sm:max-w-[90vw]">
        <DialogTitle className="sr-only">{attachment.name}</DialogTitle>
        {failed ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            This video is no longer on the server (uploads are kept for 7 days).
          </p>
        ) : url === null ? (
          <div className="grid min-h-40 min-w-60 place-items-center">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
          </div>
        ) : (
          <video
            src={url}
            aria-label={attachment.name}
            controls
            autoPlay
            playsInline
            className="max-h-[85dvh] max-w-full rounded-md"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SentImage({ attachment }: { attachment: Attachment }) {
  const { url, failed } = useUploadUrl(attachment.path);
  if (failed)
    return (
      <div className={TILE} title={`${attachment.path} (no longer on the server)`}>
        <FileFace name={attachment.name} />
      </div>
    );
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Open ${attachment.name}`}
          disabled={url === null}
          className={cn(TILE, "cursor-zoom-in")}
        >
          {url === null ? (
            <span className="grid size-full place-items-center">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </span>
          ) : (
            <img src={url} alt={attachment.name} className="size-full object-cover" />
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] w-auto max-w-[calc(100%-2rem)] p-2 sm:max-w-[90vw]">
        <DialogTitle className="sr-only">{attachment.name}</DialogTitle>
        {url !== null && (
          <img
            src={url}
            alt={attachment.name}
            className="max-h-[85dvh] max-w-full rounded-md object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The files a sent message carried, under its text. */
export function SentAttachments({ attachments }: { attachments: readonly Attachment[] }) {
  return (
    <div role="group" aria-label="Attached files" className="flex max-w-full flex-wrap justify-end gap-2">
      {attachments.map((attachment) =>
        imageTypes.has(attachment.type) ? (
          <SentImage key={attachment.path} attachment={attachment} />
        ) : isVideo(attachment.type) ? (
          <SentVideo key={attachment.path} attachment={attachment} />
        ) : (
          <div key={attachment.path} className={TILE} title={attachment.path}>
            <FileFace name={attachment.name} />
          </div>
        ),
      )}
    </div>
  );
}
