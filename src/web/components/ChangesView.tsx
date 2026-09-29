// What changed in a workspace (roamgate #37): the last turn (against the snapshot taken
// when it started), uncommitted work, or the whole branch. Files load as a list; a file's
// diff loads when you open it. Refreshes itself when the workspace's git facts change,
// which happens after every turn.
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import * as stylex from "@stylexjs/stylex";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChangedFile, Changes, DiffScope } from "../../shared/schemas.ts";
import { useApp, useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { DiffView } from "./DiffView.tsx";
import { ErrorText } from "./ErrorText.tsx";

const SCOPE_KEY = "rowrow.changesScope";

export function ChangesView({ workspaceId }: { workspaceId: string }) {
  const client = useClient();
  const gitVersion = useApp((s) => s.state?.workspaces[workspaceId]?.git?.updatedAt ?? 0);
  const [scope, setScope] = useState<DiffScope>(() => {
    const saved = localStorage.getItem(SCOPE_KEY);
    return saved === "working" || saved === "branch" || saved === "turn" ? saved : "turn";
  });
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; changes: Changes | null; error: string | null } | null>(
    null,
  );
  const key = `${workspaceId}:${scope}:${gitVersion}:${reload}`;

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const changes = await client.git.changes({ workspaceId, scope });
        if (!cancelled) setResult({ key, changes, error: null });
      } catch (error) {
        if (!cancelled)
          setResult({ key, changes: null, error: error instanceof Error ? error.message : String(error) });
        report("warn", "changes.load_failed", error, { workspaceId, scope });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, scope, key]);

  const current = result?.key === key ? result : null;
  const changes = current?.changes ?? result?.changes ?? null;
  const total = changes?.files.reduce(
    (sum, f) => ({ add: sum.add + (f.additions ?? 0), del: sum.del + (f.deletions ?? 0) }),
    { add: 0, del: 0 },
  );

  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <SegmentedControl
          label="Compare"
          size="sm"
          value={scope}
          onChange={(value) => {
            const next = value as DiffScope;
            setScope(next);
            localStorage.setItem(SCOPE_KEY, next);
          }}
        >
          <SegmentedControlItem value="turn" label="Last turn" />
          <SegmentedControlItem value="working" label="Uncommitted" />
          <SegmentedControlItem value="branch" label="Branch" />
        </SegmentedControl>
        <StackItem size="fill" />
        {current === null && <Spinner size="sm" label="Loading changes" />}
        <Button
          label="Refresh"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<Icon icon={RefreshCw} size="sm" />}
          onClick={() => setReload((n) => n + 1)}
        />
      </HStack>
      {changes !== null && (
        <Text type="supporting">
          {changes.baseLabel === null ? "" : `Against ${changes.baseLabel}. `}
          {changes.files.length === 0
            ? ""
            : `${changes.files.length} file${changes.files.length === 1 ? "" : "s"}, +${total?.add ?? 0} −${total?.del ?? 0}${changes.truncated ? " (first 2000 files)" : ""}`}
        </Text>
      )}
      {current?.error !== null && current?.error !== undefined && <ErrorText>{current.error}</ErrorText>}
      {changes !== null && changes.files.length === 0 && (
        <EmptyState
          isCompact
          title={changes.note === null ? "No changes" : "Nothing to compare"}
          description={
            changes.note ??
            (scope === "turn" ? "The last turn didn't change any files." : "The working tree matches.")
          }
        />
      )}
      {changes !== null && (
        <VStack gap={1}>
          {changes.files.map((file) => (
            <FileRow
              key={`${scope}:${file.path}`}
              workspaceId={workspaceId}
              scope={scope}
              file={file}
              version={key}
            />
          ))}
        </VStack>
      )}
    </VStack>
  );
}

const STATUS: Record<ChangedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  conflicted: "!",
  typechange: "T",
};

function FileRow({
  workspaceId,
  scope,
  file,
  version,
}: {
  workspaceId: string;
  scope: DiffScope;
  file: ChangedFile;
  version: string;
}) {
  const client = useClient();
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<
    { version: string; patch: string; truncated: boolean } | { version: string; error: string } | null
  >(null);

  useEffect(() => {
    if (!open || client === null || diff?.version === version) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.git.diff({ workspaceId, scope, path: file.path });
        if (!cancelled) setDiff({ version, ...result });
      } catch (error) {
        if (!cancelled) setDiff({ version, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, client, workspaceId, scope, file.path, version, diff?.version]);

  return (
    <VStack gap={1}>
      <button
        type="button"
        {...stylex.props(styles.row)}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
        <span {...stylex.props(styles.status, statusColor[file.status])}>{STATUS[file.status]}</span>
        <span {...stylex.props(styles.path)}>
          {file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}
        </span>
        <span {...stylex.props(styles.counts)}>
          {file.additions === null ? (
            "binary"
          ) : (
            <>
              <span {...stylex.props(styles.add)}>{`+${file.additions}`}</span>{" "}
              <span {...stylex.props(styles.del)}>{`−${file.deletions ?? 0}`}</span>
            </>
          )}
        </span>
      </button>
      {open &&
        (diff === null || diff.version !== version ? (
          <Spinner size="sm" label="Loading diff" />
        ) : "error" in diff ? (
          <ErrorText>{diff.error}</ErrorText>
        ) : diff.patch === "" ? (
          <Text type="supporting">No textual diff (binary or too large).</Text>
        ) : (
          <>
            <DiffView patch={diff.patch} />
            {diff.truncated && <Text type="supporting">Cut at 512 KB.</Text>}
          </>
        ))}
    </VStack>
  );
}

const styles = stylex.create({
  row: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    paddingBlock: 6,
    paddingInline: 6,
    borderRadius: "var(--radius-inner)",
    borderWidth: 0,
    backgroundColor: { default: "transparent", ":hover": "var(--color-background-muted)" },
    color: "var(--color-text-primary)",
    cursor: "pointer",
    textAlign: "start",
    font: "inherit",
  },
  status: {
    fontFamily: "var(--font-family-code)",
    fontSize: 12,
    width: 14,
    textAlign: "center",
    fontWeight: 600,
  },
  path: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--font-family-code)",
    fontSize: 13,
  },
  counts: {
    fontFamily: "var(--font-family-code)",
    fontSize: 12,
    whiteSpace: "nowrap",
    color: "var(--color-text-secondary)",
  },
  add: { color: "var(--color-success)" },
  del: { color: "var(--color-error)" },
});

const statusColor = stylex.create({
  added: { color: "var(--color-success)" },
  untracked: { color: "var(--color-success)" },
  modified: { color: "var(--color-warning)" },
  renamed: { color: "var(--color-warning)" },
  copied: { color: "var(--color-warning)" },
  typechange: { color: "var(--color-warning)" },
  deleted: { color: "var(--color-error)" },
  conflicted: { color: "var(--color-error)" },
});
