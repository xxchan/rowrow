// Add a workspace from any device: browse the server's directories (git repositories are
// marked) or type a path. The folder lives on the machine running rowrow, not this device.
import { Button } from "@astryxdesign/core/Button";
import { DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowUp, Folder, FolderGit2 } from "lucide-react";
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
}: {
  onAdded: (workspaceId: string) => void;
  onCancel: () => void;
}) {
  const client = useClient();
  const [listing, setListing] = useState<Listing | null>(null);
  const [path, setPath] = useState("");
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
      const ws = await client.workspaces.add({ path: target });
      onAdded(ws.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout
      header={
        <DialogHeader
          title="Add a workspace"
          subtitle="A folder on the machine running rowrow, usually a git repository."
          onOpenChange={(open) => (open ? undefined : onCancel())}
        />
      }
      content={
        <LayoutContent>
          <VStack gap={3}>
            <HStack gap={2} vAlign="end">
              <TextInput
                label="Path"
                value={path}
                onChange={setPath}
                onEnter={() => void browse(path)}
                placeholder="~/code/my-project"
                width="100%"
              />
              <Button label="Go" variant="secondary" onClick={() => void browse(path)} />
            </HStack>
            {listing === null ? (
              <Spinner label="Reading folders" />
            ) : (
              <List density="compact" hasDividers>
                {listing.parent !== null && (
                  <ListItem
                    label=".."
                    description={listing.parent}
                    startContent={<Icon icon={ArrowUp} size="sm" />}
                    onClick={() => void browse(listing.parent ?? undefined)}
                  />
                )}
                {listing.entries.map((entry) => (
                  <ListItem
                    key={entry.path}
                    label={entry.name}
                    startContent={<Icon icon={entry.repo ? FolderGit2 : Folder} size="sm" />}
                    {...(entry.repo ? { description: "git repository" } : {})}
                    onClick={() => void browse(entry.path)}
                  />
                ))}
              </List>
            )}
            {error !== null && <ErrorText>{error}</ErrorText>}
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="secondary" onClick={onCancel} />
            <Button
              label="Add this folder"
              variant="primary"
              isLoading={busy}
              isDisabled={path.trim() === ""}
              onClick={() => void add(path)}
            />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}
