// Add a workspace from any device: browse the server's directories (git repositories are
// marked) or type a path. The folder lives on the machine running rowrow, not this device.
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ArrowUp, Folder, FolderGit2, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useClient } from "../lib/store.ts";
import { ErrorText } from "./ErrorText.tsx";

interface Listing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly { name: string; path: string; repo: boolean }[];
}

export function AddWorkspace({
  onAdded,
  onCancel,
  named = false,
}: {
  onAdded: (workspaceId: string) => void;
  onCancel: () => void;
  /** Offer a name for it (else it's named after the folder). */
  named?: boolean;
}) {
  const client = useClient();
  const [listing, setListing] = useState<Listing | null>(null);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const browse = async (target?: string): Promise<void> => {
    if (client === null) return;
    setError(null);
    try {
      const result = await client.workspaces.browse(target === undefined ? {} : { path: target });
      setListing(result);
      setPath(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void browse();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the client is ready
  }, [client]);

  const add = async (target: string): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await client.workspaces.add({
        path: target,
        ...(label.trim() === "" ? {} : { label: label.trim() }),
      });
      onAdded(ws.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const row = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent/60";
  return (
    <div className="flex flex-col">
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle>Add a workspace</DialogTitle>
        <DialogDescription>
          A folder on the machine running rowrow, usually a git repository.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 px-5 py-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void browse(path);
          }}
        >
          <Input
            aria-label="Path"
            value={path}
            onChange={(event) => setPath(event.currentTarget.value)}
            placeholder="~/code/my-project"
            className="font-mono"
          />
          <Button type="submit" variant="outline">
            Go
          </Button>
        </form>
        {listing === null ? (
          <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Reading folders
          </div>
        ) : (
          <ul className="max-h-[42dvh] divide-y overflow-y-auto rounded-lg border">
            {listing.parent !== null && (
              <li>
                <button
                  type="button"
                  className={row}
                  onClick={() => void browse(listing.parent ?? undefined)}
                >
                  <ArrowUp className="size-4 text-muted-foreground" />
                  <span>..</span>
                  <span className="truncate text-xs text-muted-foreground">{listing.parent}</span>
                </button>
              </li>
            )}
            {listing.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" className={row} onClick={() => void browse(entry.path)}>
                  {entry.repo ? (
                    <FolderGit2 className="size-4 text-primary" />
                  ) : (
                    <Folder className="size-4 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.repo && <span className="text-xs text-muted-foreground">git repository</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {named && (
          <Input
            aria-label="Name (optional)"
            value={label}
            maxLength={200}
            onChange={(event) => setLabel(event.currentTarget.value)}
            placeholder="Name (optional): the folder's name when empty"
          />
        )}
        {error !== null && <ErrorText>{error}</ErrorText>}
      </div>
      <DialogFooter className="border-t px-5 py-3">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy || path.trim() === ""} onClick={() => void add(path)}>
          {busy && <LoaderCircle className="animate-spin" />} Add this folder
        </Button>
      </DialogFooter>
    </div>
  );
}
