import type { ReactNode } from "react";
import { byProvider, providerName } from "../../shared/models.ts";
import type { ModelInfo } from "../../shared/schemas.ts";
import { CommandGroup } from "@/components/ui/command";

/** What filters to a model in a menu: its id and name, and its provider's name and id. */
export function modelKeywords(model: ModelInfo): string[] {
  return model.provider === null
    ? [model.name]
    : [model.name, providerName(model.provider), model.provider.id];
}

/**
 * A runtime's models in a command menu: `lead` (Default) and every model in one group, or, when
 * the runtime names several providers (pi), a group per provider headed by its name.
 */
export function ModelGroups({
  models,
  heading,
  lead,
  renderItem,
}: {
  models: readonly ModelInfo[];
  heading?: string;
  lead: ReactNode;
  renderItem: (model: ModelInfo) => ReactNode;
}) {
  const groups = byProvider(models);
  const split = groups.length > 1;
  return (
    <>
      <CommandGroup heading={heading}>
        {lead}
        {!split && groups[0]?.models.map(renderItem)}
      </CommandGroup>
      {split &&
        groups.map((group) => (
          <CommandGroup
            key={group.provider?.id ?? ""}
            heading={group.provider === null ? undefined : providerName(group.provider)}
          >
            {group.models.map(renderItem)}
          </CommandGroup>
        ))}
    </>
  );
}
