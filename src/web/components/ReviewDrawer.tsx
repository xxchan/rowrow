// Review comments waiting to be sent, shown above the composer: on diff lines (Changes) or
// on passages the agent wrote (select text in the transcript). "Add to message" compiles
// them into one "Review feedback" message in this agent's draft; you still press send.
import { Button } from "@astryxdesign/core/Button";
import { ChatComposerDrawer } from "@astryxdesign/core/Chat";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import {
  annotationsFor,
  compileFeedback,
  removeAnnotations,
  useAnnotations,
  type Annotation,
} from "../lib/annotations.ts";
import { setDraft, useDrafts } from "../lib/store.ts";

export function ReviewDrawer({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const items = useAnnotations((s) => s.items);
  const annotations = annotationsFor(items, workspaceId);
  const draft = useDrafts((s) => s.byAgent[agentId] ?? "");
  if (annotations.length === 0) return null;
  const ids = new Set(annotations.map((a) => a.id));
  return (
    <ChatComposerDrawer
      count={annotations.length}
      label={annotations.length === 1 ? "review comment" : "review comments"}
      defaultIsCollapsed
    >
      <VStack gap={1} width="100%">
        {annotations.map((a) => (
          <HStack key={a.id} gap={2} vAlign="start">
            <StackItem size="fill">
              <VStack gap={0}>
                <Text type="supporting" maxLines={1}>
                  {where(a)}
                </Text>
                <Text type="body" maxLines={2}>
                  {a.comment}
                </Text>
              </VStack>
            </StackItem>
            <Button
              label="Remove"
              size="sm"
              variant="ghost"
              onClick={() => removeAnnotations(new Set([a.id]))}
            />
          </HStack>
        ))}
        <HStack gap={2} hAlign="end">
          <Button label="Clear all" size="sm" variant="ghost" onClick={() => removeAnnotations(ids)} />
          <Button
            label="Add to message"
            size="sm"
            variant="primary"
            onClick={() => {
              const feedback = compileFeedback(annotations);
              setDraft(agentId, draft.trim() === "" ? feedback : `${draft.trimEnd()}\n\n${feedback}`);
              removeAnnotations(ids);
            }}
          />
        </HStack>
      </VStack>
    </ChatComposerDrawer>
  );
}

function where(a: Annotation): string {
  if (a.source.kind === "diff") return `${a.source.path}:${a.source.line}`;
  const quote = a.source.quote.replaceAll(/\s+/g, " ").trim();
  return `“${quote.length > 60 ? `${quote.slice(0, 59)}…` : quote}”`;
}
