// How ⌘K matches what you type (cmdk's filter). cmdk's default scores scattered letters across
// every keyword, so "quiet" could match an agent whose id, workspace and runtime happen to spell
// it, and that agent, listed first under Needs you, got the highlight Enter opens. Here every
// word you typed must appear as typed in what the item is known by, and its title (the first
// keyword) counts most.

export function commandFilter(value: string, search: string, keywords: readonly string[] = []): number {
  const words = search
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const first = words[0];
  if (first === undefined) return 1;
  const fields = [...keywords, value].map((field) => field.toLowerCase());
  if (!words.every((word) => fields.some((field) => field.includes(word)))) return 0;
  const title = fields[0] ?? "";
  if (title.startsWith(words.join(" "))) return 1;
  if (title.split(/[\s\-_/.:]+/).some((part) => part.startsWith(first))) return 0.8;
  if (words.every((word) => title.includes(word))) return 0.6;
  return 0.3;
}
