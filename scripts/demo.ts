// Seeds a running rowrow server with a demo: a small repository and a few scripted agents
// in every state (finished, working, failed, idle), one of them in a worktree. No tokens.
// For screenshots and for trying the UI:
//
//   pnpm rowrow serve --profile demo --test-runtime
//   node scripts/demo.ts --profile demo [--dir <where to create the repo>]
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { connect, resolveTarget } from "../src/cli/client.ts";

const { values } = parseArgs({ options: { profile: { type: "string" }, dir: { type: "string" } } });
const { client } = connect(resolveTarget({ profile: values.profile ?? "demo" }));

const base = values.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-demo-"));
const repo = path.join(base, "acme-shop");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
const git = (...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], {
    cwd: repo,
    stdio: "ignore",
  });
};
fs.writeFileSync(path.join(repo, "README.md"), "# Acme Shop\n\nA tiny storefront.\n");
fs.writeFileSync(
  path.join(repo, "src/cart.ts"),
  "export function total(prices: number[]): number {\n  return prices.reduce((sum, p) => sum + p, 0);\n}\n",
);
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "Initial storefront");

const ws = await client.workspaces.add({ path: repo });
const say = (text: string) => ({ inputId: randomUUID(), text });

async function agent(title: string, text: string, workspaceId = ws.id): Promise<string> {
  const { agent: created, sent } = await client.agents.create({
    workspaceId,
    runtime: "scripted",
    title,
    input: say(text),
  });
  if (!text.startsWith("/sleep"))
    await client.agents.wait({ agentId: created.id, afterSeq: sent?.seq ?? -1, timeoutMs: 15_000 });
  return created.id;
}

await agent(
  "Fix rounding in cart totals",
  "/write src/cart.ts\nexport function total(prices: number[]): number {\n  const cents = prices.reduce((sum, p) => sum + Math.round(p * 100), 0);\n  return cents / 100;\n}",
);
const notes = await agent(
  "Draft the release notes",
  "/echo ## 1.4.0\n\n- Cart totals are exact to the cent\n- Faster product search",
);
await agent(
  "Upgrade dependencies",
  "/fail npm ERR! network request to https://registry.npmjs.org failed: ETIMEDOUT",
);
const { workspace: worktree } = await client.workspaces.createWorktree({
  id: ws.id,
  branch: "feature/dark-mode",
});
await agent("Add dark mode to settings", "/sleep 3600000", worktree.id);
// You already read the release notes.
const seen = (await client.state.get()).state.agents[notes];
if (seen !== undefined) await client.agents.markSeen({ agentId: notes, seq: seen.summary.headSeq });

console.log(`demo ready: ${repo}`);
