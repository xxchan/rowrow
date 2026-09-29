// Names for new worktree branches: readable enough to say out loud, random enough that
// two agents started in the same second don't collide.
import { randomBytes, randomInt } from "node:crypto";

const ADJECTIVES = words(`
  amber bold brave brisk calm clever cosmic crisp curious daring deft eager early fair fancy fast fierce
  gentle glad golden grand happy hardy honest humble jolly keen kind lively lucky merry mighty misty nimble
  noble patient plucky proud quick quiet rapid sharp shiny silent steady sunny swift tidy vivid witty
`);

const NOUNS = words(`
  anchor badger beacon birch canyon cedar comet coral crane delta ember falcon fern fjord forest garden
  glacier harbor heron island lagoon lantern maple meadow meteor otter owl pebble pine planet prairie quartz
  raven reef ridge river rocket sparrow spruce summit thistle thunder tide tiger valley willow wolf wren
  yarrow zephyr
`);

function words(list: string): string[] {
  return list.trim().split(/\s+/);
}

/** `rowrow/<adjective>-<noun>-<4 hex>`, e.g. `rowrow/brave-river-0a1b`. */
export function randomBranchName(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)] ?? "brave";
  const noun = NOUNS[randomInt(NOUNS.length)] ?? "river";
  return `rowrow/${adjective}-${noun}-${randomBytes(2).toString("hex")}`;
}

/** A branch name as one directory name: lowercase, runs of anything else become `-`. */
export function slugify(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
