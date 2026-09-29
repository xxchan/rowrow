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
import {
  addAnnotation,
  annotationsFor,
  compileFeedback,
  removeAnnotations,
  useAnnotations,
  type Annotation,
} from "../lib/annotations.ts";
import { setDraft, useApp, useClient, useDrafts } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { DiffView } from "./DiffView.tsx";
import { ErrorText } from "./ErrorText.tsx";

const SCOPE_KEY = "rowrow.changesScope";

/**
 * `agentId`: whose composer review feedback goes to ("Add to message"); without it the
 * feedback can only be copied. `onDelivered` runs after it was added (to close a sheet).
 */
export function ChangesView({
  workspaceId,
  agentId,
  onDelivered,
}: {
  workspaceId: string;
  agentId?: string;
  onDelivered?: () => void;
}) {
  const client = useClient();
  const gitVersion = useApp((s) => s.state?.workspaces[workspaceId]?.git?.updatedAt ?? 0);
  const [scope, setScope] = useState<DiffScope>(() => {
    const saved = localStorage.getItem(SCOPE_KEY);
    return saved === "working" || saved === "branch" || saved === "turn" ? saved : "turn";
  });
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    scope: DiffScope;
    changes: Changes | null;
    error: string | null;
  } | null>(null);
  const key = `${workspaceId}:${scope}:${gitVersion}:${reload}`;

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const changes = await client.git.changes({
          workspaceId,
          scope,
          ...(agentId === undefined ? {} : { agentId }),
        });
        if (!cancelled) setResult({ key, scope, changes, error: null });
      } catch (error) {
        if (!cancelled)
          setResult({
            key,
            scope,
            changes: null,
            error: error instanceof Error ? error.message : String(error),
          });
        report("warn", "changes.load_failed", error, { workspaceId, scope });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, scope, key, agentId]);

  const allAnnotations = useAnnotations((s) => s.items);
  const annotations = annotationsFor(allAnnotations, workspaceId);
  const current = result?.key === key ? result : null;
  // While a refresh loads, keep showing the previous result of the same scope (never another scope's).
  const changes = current?.changes ?? (result?.scope === scope ? result.changes : null);
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
        {current === null && <Spinner size="sm" aria-label="Loading changes" />}
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
          {changes.baseLabel === null ? "" : `${scope === "turn" ? "In" : "Against"} ${changes.baseLabel}. `}
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
      {annotations.length > 0 && (
        <ReviewBar
          annotations={annotations}
          {...(agentId === undefined ? {} : { agentId })}
          {...(onDelivered === undefined ? {} : { onDelivered })}
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
              {...(agentId === undefined ? {} : { agentId })}
              annotations={annotations.filter(
                (a) => a.source.kind === "diff" && a.source.path === file.path && a.source.scope === scope,
              )}
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

/** Your review comments on this workspace: add them to the agent's message, copy, or clear. */
function ReviewBar({
  annotations,
  agentId,
  onDelivered,
}: {
  annotations: readonly Annotation[];
  agentId?: string;
  onDelivered?: () => void;
}) {
  const draft = useDrafts((s) => (agentId === undefined ? "" : (s.byAgent[agentId] ?? "")));
  const [copied, setCopied] = useState(false);
  const feedback = compileFeedback(annotations);
  const ids = new Set(annotations.map((a) => a.id));
  return (
    <div {...stylex.props(styles.review)}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="label">{`${annotations.length} review comment${annotations.length === 1 ? "" : "s"}`}</Text>
        <StackItem size="fill" />
        {agentId !== undefined && (
          <Button
            label="Add to message"
            size="sm"
            variant="primary"
            onClick={() => {
              setDraft(agentId, draft.trim() === "" ? feedback : `${draft.trimEnd()}\n\n${feedback}`);
              removeAnnotations(ids);
              onDelivered?.();
            }}
          />
        )}
        <Button
          label={copied ? "Copied" : "Copy"}
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(feedback).then(() => setCopied(true));
          }}
        />
        <Button label="Clear" size="sm" variant="ghost" onClick={() => removeAnnotations(ids)} />
      </HStack>
    </div>
  );
}

function FileRow({
  workspaceId,
  scope,
  file,
  version,
  annotations,
  agentId,
}: {
  workspaceId: string;
  scope: DiffScope;
  file: ChangedFile;
  version: string;
  annotations: readonly Annotation[];
  agentId?: string;
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
        const result = await client.git.diff({
          workspaceId,
          scope,
          path: file.path,
          ...(agentId === undefined ? {} : { agentId }),
        });
        if (!cancelled) setDiff({ version, ...result });
      } catch (error) {
        if (!cancelled) setDiff({ version, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, client, workspaceId, scope, file.path, version, diff?.version, agentId]);

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
        {annotations.length > 0 && (
          <span
            {...stylex.props(styles.counts)}
          >{`${annotations.length} comment${annotations.length === 1 ? "" : "s"}`}</span>
        )}
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
            <DiffView
              patch={diff.patch}
              annotations={annotations}
              onComment={(ref, comment) =>
                addAnnotation(workspaceId, { kind: "diff", path: file.path, scope, ...ref }, comment)
              }
              onRemove={(id) => removeAnnotations(new Set([id]))}
            />
            {diff.truncated && <Text type="supporting">Cut at 512 KB.</Text>}
          </>
        ))}
    </VStack>
  );
}

const styles = stylex.create({
  review: {
    paddingBlock: 8,
    paddingInline: 10,
    borderRadius: "var(--radius-inner)",
    backgroundColor: "var(--color-background-muted)",
  },
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
