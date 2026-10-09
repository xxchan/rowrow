// The app as a person uses it, on a desktop and a phone viewport. Each test gets its own
// server and data (fixtures.ts); agents are the scripted runtime, so no tokens are spent.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test, type Rowrow } from "./fixtures.ts";

test("a signed-out browser is asked to sign in, not shown an error", async ({ page, rowrow }) => {
  await page.goto(rowrow.url);
  await expect(page.getByRole("heading", { name: "Sign in to rowrow" })).toBeVisible();
});

test("sign in with a one-time link, create an agent, and read its answer", async ({ page, rowrow }) => {
  await rowrow.client.workspaces.add({ path: rowrow.repo() });
  await rowrow.open(page);
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  // On a phone it's the button at the bottom, and the dialog is a sheet over the keyboard.
  await page.getByRole("button", { name: "New agent" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await expect(dialog.getByLabel("First message")).toBeFocused();
  await dialog.getByRole("button", { name: /^Agent: / }).click();
  await page.getByRole("option", { name: /Scripted demo/ }).click();
  await dialog.getByLabel("First message").fill("/echo hello from e2e");
  await dialog.getByRole("button", { name: "Create and send" }).click();

  await expect(page).toHaveURL(/\/a\/ag_/);
  await expect(page.getByText("hello from e2e", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "/echo hello from e2e" })).toBeVisible();
});

test("C starts another agent set up like the one on screen", async ({ page, rowrow }, info) => {
  test.skip(info.project.name === "phone", "keyboard shortcuts are a desktop affordance");
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "the first one",
  });
  await rowrow.open(page, `/a/${agent.id}`);
  await expect(page.getByRole("heading", { name: "the first one" })).toBeVisible();

  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await expect(dialog.getByRole("button", { name: `Workspace: ${ws.label}` })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Agent: Scripted demo" })).toBeVisible();
  await expect(dialog.getByLabel("First message")).toBeFocused();
  await page.keyboard.type("/echo the second one");

  // Closing keeps what you wrote.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.keyboard.press("c");
  await expect(dialog.getByLabel("First message")).toHaveValue("/echo the second one");

  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).not.toHaveURL(new RegExp(`/a/${agent.id}$`));
  await expect(page.getByText("the second one", { exact: true })).toBeVisible();
  const { state } = await rowrow.client.state.get();
  const second = Object.values(state.agents).find((a) => a.id !== agent.id);
  expect(second?.summary.workspaceId).toBe(ws.id);
});

test("a long menu in the new-agent dialog scrolls", async ({ page, rowrow }) => {
  for (let i = 0; i < 16; i++) await rowrow.client.workspaces.add({ path: rowrow.repo() });
  await rowrow.open(page);
  await page
    .getByRole("button", { name: /^New agent/ })
    .first()
    .click();
  await page.getByRole("button", { name: /^Workspace: / }).click();
  // The dialog blocks scrolling outside itself, and the menu is portaled outside it.
  const list = page.locator("[data-slot=command-list]");
  await expect(list.getByRole("option").nth(15)).toBeAttached();
  await list.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("right-click an agent or a workspace for what you can do to it", async ({
  page,
  context,
  rowrow,
}, info) => {
  test.skip(info.project.name === "phone", "a right-click; a long press opens the same menu");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: rowrow.url });
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  await rowrow.client.agents.create({ workspaceId: ws.id, runtime: "scripted", title: "old name" });
  await rowrow.open(page);
  const main = page.getByRole("main");

  await main.getByRole("link", { name: /old name/ }).click({ button: "right" });
  await page
    .getByRole("menu", { name: "Actions for old name" })
    .getByRole("menuitem", { name: "Rename…" })
    .click();
  const rename = page.getByRole("dialog", { name: "Rename agent" });
  await rename.getByLabel("Title").fill("new name");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(main.getByRole("link", { name: /new name/ })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Agents and workspaces" });
  await nav.getByRole("link", { name: ws.label, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy path" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(ws.path);

  await main.getByRole("link", { name: /new name/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(main.getByRole("link", { name: /new name/ })).toBeHidden();
});

test("double-click an agent's title to rename it", async ({ page, rowrow }, info) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "old name",
  });
  const { agent: other } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "second",
  });
  await rowrow.open(page, `/a/${agent.id}`);

  await page.getByRole("heading", { name: "old name" }).dblclick();
  const rename = page.getByRole("dialog", { name: "Rename agent" });
  await expect(rename.getByLabel("Title")).toBeFocused();
  // The whole title is selected: what you type replaces it.
  await page.keyboard.type("new name");
  await page.keyboard.press("Enter");
  await expect(rename).toBeHidden();
  await expect(page.getByRole("heading", { name: "new name" })).toBeVisible();

  if (info.project.name === "phone") return; // the side nav is a sheet there, and a tap opens the agent
  // A row in the side nav: the first click opens the agent, the double-click renames it.
  const nav = page.getByRole("navigation", { name: "Agents and workspaces" });
  await nav.getByRole("link", { name: /second/ }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/a/${other.id}$`));
  await expect(rename.getByLabel("Title")).toHaveValue("second");
  await page.keyboard.press("Escape");
  await expect(rename).toBeHidden();
  await expect(page.getByRole("heading", { name: "second" })).toBeVisible();
});

test("⌘K: say what a new agent should do, and it starts", async ({ page, rowrow }, info) => {
  test.skip(info.project.name === "phone", "keyboard shortcuts are a desktop affordance");
  await rowrow.client.workspaces.add({ path: rowrow.repo() });
  await rowrow.open(page);
  // Earlier versions remembered only the runtime; that still counts.
  await page.evaluate(() => localStorage.setItem("rowrow.lastRuntime", "scripted"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("/echo from the palette");
  await expect(page.getByRole("option", { name: /Start an agent: “\/echo from the palette”/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/a\/ag_/);
  await expect(page.getByText("from the palette", { exact: true })).toBeVisible();
});

test("the home page starts an agent from the box above the list", async ({ page, rowrow }, info) => {
  test.skip(info.project.name === "phone", "on a phone it's the New agent button");
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  await rowrow.client.agents.create({ workspaceId: ws.id, runtime: "scripted", title: "already here" });
  await rowrow.open(page);
  const composer = page.getByRole("form", { name: "Start an agent" });
  await composer.getByRole("button", { name: /^Agent: / }).click();
  await page.getByRole("option", { name: /Scripted demo/ }).click();
  await composer.getByLabel("What should a new agent do?").fill("/echo from home");
  await composer.getByLabel("What should a new agent do?").press("Enter");
  await expect(page).toHaveURL(/\/a\/ag_/);
  await expect(page.getByText("from home", { exact: true })).toBeVisible();

  // It remembers: the next one in that workspace starts with the same agent runtime.
  await page.keyboard.press("c");
  await expect(
    page.getByRole("dialog", { name: "New agent" }).getByRole("button", { name: "Agent: Scripted demo" }),
  ).toBeVisible();
});

test("send a message from the composer and see the reply stream in", async ({ page, rowrow }) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "composer test",
  });
  await rowrow.open(page, `/a/${agent.id}`);
  await expect(page.getByRole("heading", { name: "composer test" })).toBeVisible();

  await page.getByRole("textbox", { name: "Message input" }).fill("/stream 5");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByText(/chunk 1 .*chunk 5/)).toBeVisible();
  // The composer stays on screen with the conversation above it.
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeInViewport();
});

test("a finished agent is listed under Needs you until you look at it", async ({ page, rowrow }) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "finishes",
    input: { inputId: randomUUID(), text: "/echo done" },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 10_000 });
  await rowrow.open(page);
  await expect(page.getByText("Needs you · 1")).toBeVisible();
  await expect(page.getByText("finishes").first()).toBeVisible();
});

test("an agent's notification pops up where you are, opens the agent, and stays in its transcript", async ({
  page,
  rowrow,
}) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "deploy watcher",
  });
  await rowrow.open(page);
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  // What `rowrow notify` does from inside the agent (the scripted runtime runs no commands).
  await rowrow.client.notify.send({
    agentId: agent.id,
    title: "Deploy failed",
    body: "api-7 is crash-looping",
  });
  const toast = page
    .getByRole("region", { name: /Notifications/ })
    .getByRole("listitem")
    .filter({ hasText: "Deploy failed" });
  await expect(toast).toContainText("deploy watcher · api-7 is crash-looping");
  await toast.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`/a/${agent.id}$`));
  const note = page.getByRole("note").filter({ hasText: "Notified you: Deploy failed" });
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("title", "api-7 is crash-looping");
});

test("the last turn's changes are one click away", async ({ page, rowrow }, info) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "writes a file",
    input: { inputId: randomUUID(), text: "/write src/hello.ts\nexport const hello = 1;" },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 10_000 });
  await rowrow.client.workspaces.refresh({ id: ws.id });
  await rowrow.open(page, `/a/${agent.id}`);
  await page.getByRole("button", { name: /Changes/ }).click();
  const panel =
    info.project.name === "phone"
      ? page.getByRole("dialog")
      : page.getByRole("region", { name: "Inspector" });
  await expect(panel.getByText("src/hello.ts")).toBeVisible();
  await panel.getByText("src/hello.ts").click();
  const line = panel.getByText("export const hello = 1;");
  await expect(line).toBeVisible();

  // Click a line to comment on it: the comment waits under it for the agent's next message.
  await line.click();
  await expect(panel.getByRole("textbox", { name: "Comment" })).toBeFocused();
  // The server re-reads the checkout now and then: the diff stays, and so does the comment.
  const before = (await rowrow.client.state.get()).state.workspaces[ws.id]?.git?.updatedAt;
  await rowrow.client.workspaces.refresh({ id: ws.id });
  await expect
    .poll(async () => (await rowrow.client.state.get()).state.workspaces[ws.id]?.git?.updatedAt)
    .not.toBe(before);
  await page.waitForTimeout(500);
  await expect(panel.getByRole("textbox", { name: "Comment" })).toBeFocused();
  await page.keyboard.type("Name it greeting.");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(panel.getByText("Name it greeting.")).toBeVisible();
  await expect(panel.getByText("1 review comment")).toBeVisible();
});

test("the inspector: stage a change, find a line, read the history", async ({ page, rowrow }, info) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "inspects",
    input: { inputId: randomUUID(), text: "/write notes.txt\nthe answer is 42" },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 10_000 });
  await rowrow.client.workspaces.refresh({ id: ws.id });
  await rowrow.open(page, `/a/${agent.id}`);
  await page.getByRole("button", { name: /Changes/ }).click();
  const inspector =
    info.project.name === "phone"
      ? page.getByRole("dialog")
      : page.getByRole("region", { name: "Inspector" });

  // Stage the new file from the uncommitted list.
  await inspector.getByRole("tab", { name: "Uncommitted" }).click();
  await inspector.getByRole("button", { name: "Actions for notes.txt" }).click();
  await page.getByRole("menuitem", { name: "Stage" }).click();
  await expect(inspector.getByText("staged", { exact: true })).toBeVisible();
  // Right-click the row for the same actions.
  if (info.project.name !== "phone") {
    await inspector.getByRole("button", { name: /^\S notes\.txt/ }).click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Actions for notes.txt" });
    await expect(menu.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Unstage" })).toBeVisible();
    await page.keyboard.press("Escape");
  }

  // Open a file from the tree, then back to the tree.
  await inspector.getByRole("tab", { name: "Files" }).click();
  await inspector.getByRole("treeitem", { name: /notes\.txt/ }).click();
  await expect(inspector.getByText("the answer is 42")).toBeVisible();
  await inspector.getByRole("button", { name: "Back to results" }).click();
  await expect(inspector.getByRole("treeitem", { name: /README\.md/ })).toBeVisible();

  // Find a line, open it.
  await inspector.getByRole("searchbox", { name: "Search files" }).fill("answer");
  await inspector.getByRole("button", { name: /the answer is 42/ }).click();
  // The results stay behind the preview, hidden.
  await expect(inspector.getByText("the answer is 42").filter({ visible: true })).toBeVisible();

  // The history has the repository's first commit, and its file.
  await inspector.getByRole("tab", { name: "History" }).click();
  await inspector.getByRole("button", { name: /init/ }).click();
  await expect(inspector.getByRole("button", { name: /^\S README\.md/ })).toBeVisible();
});

/** Commit everything in `repo` (the e2e fixture's identity, no background maintenance). */
function commit(repo: string, message: string): void {
  for (const args of [
    ["add", "-A"],
    ["commit", "-q", "-m", message],
  ])
    execFileSync(
      "git",
      ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "maintenance.auto=false", ...args],
      {
        cwd: repo,
        stdio: "ignore",
      },
    );
}

/** An agent's page with the inspector open on `tab`; returns the inspector. */
async function inspect(
  page: Page,
  rowrow: Rowrow,
  phone: boolean,
  repo: string,
  tab: string,
  /** Files to add once the agent's turn is over (its snapshots needn't copy them). */
  later?: () => void,
) {
  const ws = await rowrow.client.workspaces.add({ path: repo });
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "inspects",
    input: { inputId: randomUUID(), text: "/echo ready" },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 10_000 });
  later?.();
  await rowrow.client.workspaces.refresh({ id: ws.id });
  await rowrow.open(page, `/a/${agent.id}`);
  await page.getByRole("button", { name: /Changes/ }).click();
  const inspector = phone ? page.getByRole("dialog") : page.getByRole("region", { name: "Inspector" });
  await inspector.getByRole("tab", { name: tab }).click();
  return inspector;
}

test("download a file or a folder from the inspector, and hear why when it can't", async ({
  page,
  rowrow,
}, info) => {
  const repo = rowrow.repo();
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) % 256));
  fs.mkdirSync(path.join(repo, "assets", "img"), { recursive: true });
  fs.writeFileSync(path.join(repo, "assets", "app.bin"), bytes);
  fs.writeFileSync(path.join(repo, "assets", "img", "logo.svg"), "<svg/>\n");
  const phone = info.project.name === "phone";
  const inspector = await inspect(page, rowrow, phone, repo, "Files", () => {
    // Sparse: over the cap without taking the disk.
    fs.writeFileSync(path.join(repo, "huge.iso"), "");
    fs.truncateSync(path.join(repo, "huge.iso"), 256 * 1024 * 1024 + 1);
  });

  // A binary file has no preview, but it downloads, byte for byte, under its own name.
  await inspector.getByRole("treeitem", { name: /assets/ }).click();
  await inspector.getByRole("treeitem", { name: /app\.bin/ }).click();
  await expect(inspector.getByText("app.bin is a binary file: no preview")).toBeVisible();
  let saved = page.waitForEvent("download");
  await inspector.getByRole("button", { name: "Download", exact: true }).first().click();
  let download = await saved;
  expect(download.suggestedFilename()).toBe("app.bin");
  expect(fs.readFileSync(await download.path()).equals(bytes)).toBe(true);
  await expect(page.getByText("Download started")).toBeVisible();
  await inspector.getByRole("button", { name: "Back to results" }).click();

  // A folder, from its row's menu: right-click on a desktop, its ⋯ on a phone.
  const folder = inspector.getByRole("treeitem", { name: /img/ });
  if (phone) {
    await folder.click();
    await inspector.getByRole("button", { name: "Options" }).click();
  } else await folder.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for assets/img" });
  await expect(menu.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
  saved = page.waitForEvent("download");
  await menu.getByRole("menuitem", { name: "Download directory" }).click();
  download = await saved;
  expect(download.suggestedFilename()).toBe("img.tar.gz");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-e2e-untar-"));
  try {
    execFileSync("tar", ["-xzf", await download.path(), "-C", out]);
    expect(fs.readFileSync(path.join(out, "img", "logo.svg"), "utf8")).toBe("<svg/>\n");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }

  // Over the cap: a toast says so, and nothing is saved.
  if (!phone) {
    await inspector.getByRole("treeitem", { name: /huge\.iso/ }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Download file" }).click();
  } else {
    await inspector.getByRole("treeitem", { name: /huge\.iso/ }).click();
    await inspector.getByRole("button", { name: "Download", exact: true }).first().click();
  }
  await expect(page.getByText("Couldn't download huge.iso")).toBeVisible();
  await expect(page.getByText(/huge\.iso is 257 MiB: downloads stop at 256 MiB/)).toBeVisible();
});

test("view a file as it was in a commit from the history, then go back to its diff", async ({
  page,
  rowrow,
}, info) => {
  const repo = rowrow.repo();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const version = 1;\n");
  fs.writeFileSync(path.join(repo, "old.txt"), "the old notes\n");
  commit(repo, "Add the app");
  fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const version = 2;\n");
  commit(repo, "Bump the version");
  fs.rmSync(path.join(repo, "old.txt"));
  commit(repo, "Drop the old notes");
  fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const version = 3; // not committed\n");
  const inspector = await inspect(page, rowrow, info.project.name === "phone", repo, "History");

  await inspector.getByRole("button", { name: /Bump the version/ }).click();
  await inspector.getByRole("button", { name: "Preview src/app.ts at this commit" }).click();
  const preview = inspector.getByRole("region", { name: "Historical file preview" });
  await expect(preview.getByText("export const version = 2;")).toBeVisible();
  await expect(preview.getByText(/^@ [0-9a-f]{7}$/)).toBeVisible();
  await expect(preview.getByText(/As of commit [0-9a-f]{7}: Bump the version\. Read-only\./)).toBeVisible();
  // Read-only: nothing here acts on the checkout.
  await expect(preview.getByRole("button", { name: "Download" })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "Mention" })).toHaveCount(0);

  // Back to the commit, with that file's diff open.
  await preview.getByRole("button", { name: "Back to diff" }).click();
  await expect(inspector.getByRole("button", { name: /src\/app\.ts/, expanded: true })).toBeVisible();
  await expect(inspector.getByText("export const version = 2;").first()).toBeVisible();

  // A file the commit deleted shows as it was just before, and says so.
  await inspector.getByRole("button", { name: "Back to history" }).click();
  await inspector.getByRole("button", { name: /Drop the old notes/ }).click();
  await inspector.getByRole("button", { name: "Preview old.txt at this commit" }).click();
  await expect(
    inspector
      .getByRole("region", { name: "Historical file preview" })
      .getByText("the old notes", { exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByText(/Deleted in commit [0-9a-f]{7}: this is the file as of its parent [0-9a-f]{7}\./),
  ).toBeVisible();
});

test("a quick reply added in Settings is one tap away in the composer", async ({ page, rowrow }) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "quick",
  });
  await rowrow.open(page, "/settings");
  await page.getByRole("textbox", { name: "New quick reply" }).fill("Looks good, merge it.");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Looks good, merge it.")).toBeVisible();

  await page.goto(`${rowrow.url}/a/${agent.id}`);
  await page
    .getByRole("group", { name: "Quick replies" })
    .getByRole("button", { name: "Looks good, merge it." })
    .click();
  await expect(page.getByRole("textbox", { name: "Message input" })).toHaveValue("Looks good, merge it.");
});

test("a title suffix set in Settings names this server's pages and installed app", async ({
  page,
  rowrow,
}, info) => {
  await rowrow.open(page, "/settings");
  await expect(page).toHaveTitle("rowrow");
  const server = page.getByRole("region", { name: "Server" });
  await server.getByRole("textbox", { name: "App and webpage title suffix" }).fill("  Work  ");
  await expect(server.getByText("rowrow · Work", { exact: true })).toBeVisible(); // the preview
  await server.getByRole("button", { name: "Save", exact: true }).click();
  await expect(server.getByText("Saved for this rowrow server.")).toBeVisible();
  await expect(page).toHaveTitle("rowrow · Work");
  if (info.project.name === "phone") await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation").getByText("rowrow · Work")).toBeVisible();

  // A page loaded now is named from the start, and so is the app you'd install from it.
  await page.goto(`${rowrow.url}/`);
  await expect(page).toHaveTitle("rowrow · Work");
  const served = await page.evaluate(async () => ({
    page: await (await fetch("/")).text(),
    manifest: (await (await fetch("/manifest.webmanifest")).json()) as { name: string; short_name: string },
  }));
  expect(served.page).toContain("<title>rowrow · Work</title>");
  expect(served.page).toContain('<meta name="apple-mobile-web-app-title" content="rowrow · Work"');
  expect(served.manifest).toMatchObject({ name: "rowrow · Work", short_name: "rowrow · Work" });

  await page.goto(`${rowrow.url}/settings`);
  await page
    .getByRole("region", { name: "Server" })
    .getByRole("button", { name: "Reset to default" })
    .click();
  await expect(page).toHaveTitle("rowrow");
});

test("a theme picked in one tab applies in the app's other tabs at once", async ({
  page,
  context,
  rowrow,
}) => {
  await rowrow.open(page, "/settings");
  const other = await context.newPage();
  await other.goto(`${rowrow.url}/settings`);
  const html = other.locator("html");
  await expect(html).toHaveClass(/\bdark\b/);

  await page.getByRole("tablist", { name: "Theme" }).getByRole("tab", { name: "Light" }).click();
  await expect(html).not.toHaveClass(/\bdark\b/);
  await expect(other.getByRole("tab", { name: "Light" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("tablist", { name: "Theme" }).getByRole("tab", { name: "Dark" }).click();
  await expect(html).toHaveClass(/\bdark\b/);
});

test("sign a runtime in from Settings, pasting the code its sign-in page shows, then out", async ({
  page,
  rowrow,
}) => {
  await rowrow.open(page, "/settings");
  const row = page
    .getByRole("region", { name: "Agent runtimes" })
    .getByRole("listitem")
    .filter({ hasText: "Scripted demo" });
  await expect(row).toContainText("Not signed in");
  await row.getByRole("button", { name: "Sign in" }).click();
  const signIn = row.getByLabel("Signing Scripted demo in");
  await expect(signIn.getByRole("link", { name: "Open the sign-in page" })).toHaveAttribute(
    "href",
    "https://example.com/scripted-sign-in",
  );
  await signIn.getByLabel("Code from the sign-in page").fill("wrong");
  await signIn.getByRole("button", { name: "Continue" }).click();
  await expect(row).toContainText("Sign-in failed: That code didn't work.");

  await row.getByRole("button", { name: "Sign in" }).click();
  await signIn.getByLabel("Code from the sign-in page").fill("rowrow");
  await signIn.getByRole("button", { name: "Continue" }).click();
  await expect(row).toContainText("Signed in as demo@example.com (demo)");
  await expect(signIn).toBeHidden();
  await expect(row.getByRole("button", { name: "Sign in again" })).toBeVisible();

  await row.getByRole("button", { name: "Sign out" }).click();
  const question = page.getByRole("alertdialog", { name: "Sign Scripted demo out?" });
  await expect(question).toContainText("signed out there for everything, not just rowrow");
  await question.getByRole("button", { name: "Sign out" }).click();
  await expect(row).toContainText("Not signed in");
  await expect(row.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("Settings shows how much of each subscription window is left", async ({ page, rowrow }) => {
  // The scripted runtime reports made-up windows once it's signed in.
  await rowrow.open(page, "/settings");
  const usage = page.getByRole("region", { name: "Subscription usage" });
  const row = page
    .getByRole("region", { name: "Agent runtimes" })
    .getByRole("listitem")
    .filter({ hasText: "Scripted demo" });
  await row.getByRole("button", { name: "Sign in" }).click();
  await row.getByLabel("Code from the sign-in page").fill("rowrow");
  await row.getByRole("button", { name: "Continue" }).click();
  await expect(row).toContainText("Signed in as demo@example.com");
  await usage.getByRole("button", { name: "Check now" }).click();
  const card = page.getByRole("region", { name: "Scripted demo usage" });
  await expect(card).toContainText("demo@example.com");
  await expect(card.getByRole("meter", { name: "5-hour left" })).toBeVisible();
  await expect(card.getByRole("meter", { name: "Weekly left" })).toBeVisible();
  // It burns the 5-hour window a little faster than evenly, the weekly one slower.
  await expect(card).toContainText(/Deficit \d+%|On pace/);
  await expect(card).toContainText(/Reserve \d+%|On pace/);
  const chart = card.getByRole("img", { name: /Percent left over the last two days/ });
  const box = await chart.boundingBox();
  await chart.hover({ position: { x: (box?.width ?? 2) - 1, y: 10 } });
  await expect(card.getByText(/^\d+%$/).first()).toBeVisible();
});

test("type / to pick one of the agent's commands", async ({ page, rowrow }) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "commands",
  });
  await rowrow.open(page, `/a/${agent.id}`);
  const composer = page.getByRole("textbox", { name: "Message input" });
  await composer.fill("/str");
  await expect(page.getByRole("option", { name: /\/stream/ })).toBeVisible();
  await composer.press("Enter");
  // Picking fills the draft; it doesn't send.
  await expect(composer).toHaveValue("/stream ");
  await composer.pressSequentially("3");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/chunk 1 .*chunk 3/)).toBeVisible();
});

test("the model and context sit by the composer, the rest of the session one tap away", async ({
  page,
  rowrow,
}) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "session",
    input: { inputId: randomUUID(), text: "/echo hi" },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 10_000 });
  await rowrow.open(page, `/a/${agent.id}`);
  const details = page.getByRole("button", { name: "Session details" });
  await expect(details).toContainText("script-1");
  await details.click();
  const popover = page.getByRole("dialog");
  await expect(popover.getByText("Default model and effort")).toBeVisible();
  await expect(popover.getByText(/ of 200k/)).toBeVisible();
  await expect(popover.getByRole("meter", { name: "Context used" })).toBeAttached();
  await popover.getByRole("button", { name: "Change model and effort" }).click();
  await expect(page.getByRole("dialog", { name: "Model and effort" })).toBeVisible();
});

test("on a phone, the header folds away while you type", async ({ page, rowrow }, info) => {
  test.skip(info.project.name !== "phone", "a phone's keyboard takes half its screen; a desktop's doesn't");
  await page.setViewportSize({ width: 375, height: 667 });
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "typing",
  });
  await rowrow.open(page, `/a/${agent.id}`);
  const heading = page.getByRole("heading", { name: "typing" });
  const header = page.locator("main header").first();
  await expect(heading).toBeVisible();

  const input = page.getByRole("textbox", { name: "Message input" });
  await input.tap();
  await expect(input).toBeFocused();
  await expect(heading).toBeHidden();
  await expect(header).toHaveJSProperty("offsetHeight", 0);

  await input.blur();
  await expect(heading).toBeVisible();
  await expect(page.getByRole("button", { name: /Open navigation/ })).toBeVisible();
});

test("comment on a passage the agent wrote, then send it as review feedback", async ({ page, rowrow }) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "writes notes",
    input: { inputId: randomUUID(), text: "/echo The cache is flushed hourly." },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 10_000 });
  await rowrow.open(page, `/a/${agent.id}`);

  // Your own message isn't something to review.
  const mine = page.locator('[data-author="you"]').getByText("/echo The cache is flushed hourly.");
  await mine.selectText();
  await mine.dispatchEvent("mouseup");
  await expect(page.getByRole("button", { name: "Comment" })).toHaveCount(0);

  const reply = page.locator('[data-author="agent"]').getByText("The cache is flushed hourly.");
  await reply.selectText();
  await reply.dispatchEvent("mouseup");
  await page.getByRole("button", { name: "Comment" }).click();
  await page.getByRole("textbox", { name: "Comment" }).fill("Say which cache.");
  await page.getByRole("button", { name: "Comment" }).click();

  await page.getByRole("button", { name: /review comment/ }).click();
  await page.getByRole("button", { name: "Add to message" }).click();
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toContainText("About what you wrote:");
  await expect(composer).toContainText("> The cache is flushed hourly.");
  await expect(composer).toContainText("Say which cache.");
  await expect(page.getByRole("button", { name: /review comment/ })).toHaveCount(0);
});

test("⌘K jumps to an agent by name; ⌘J goes to the next one that needs you", async ({
  page,
  rowrow,
}, info) => {
  test.skip(info.project.name === "phone", "keyboard shortcuts are a desktop affordance");
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const quiet = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "quiet one",
  });
  const { agent: loud, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "finished one",
    input: { inputId: randomUUID(), text: "/echo hi" },
  });
  await rowrow.client.agents.wait({ agentId: loud.id, afterSeq: sent?.seq ?? -1, timeoutMs: 10_000 });
  await rowrow.open(page);
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("quiet");
  // Enter opens the highlighted one: wait until the filter has moved the highlight.
  await expect(page.getByRole("option", { name: /quiet one/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/a/${quiet.agent.id}$`));

  await page.keyboard.press("ControlOrMeta+j");
  await expect(page).toHaveURL(new RegExp(`/a/${loud.id}$`));
});

test("? lists every keyboard shortcut, and so does the button beside Settings", async ({
  page,
  rowrow,
}, info) => {
  test.skip(info.project.name === "phone", "keyboard shortcuts are a desktop affordance");
  await rowrow.open(page);
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await page.keyboard.press("?");
  await expect(sheet.getByText("Next agent that needs you")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+,");
  await expect(page).toHaveURL(/\/settings$/);
});

test("the service worker shows what the server pushes", async ({ page, context, rowrow }, info) => {
  test.skip(info.project.name === "phone", "one run is enough: it's the same Chromium");
  await context.grantPermissions(["notifications"], { origin: rowrow.url });
  await rowrow.open(page, "/");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(`${rowrow.url}/`);

  // Deliver a push the way the browser's push service would, with the server's payload shape.
  const cdp = await context.newCDPSession(page);
  const registrationId = new Promise<string>((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const ours = registrations.find((r) => r.scopeURL === scope && !r.isDeleted);
      if (ours !== undefined) resolve(ours.registrationId);
    });
  });
  await cdp.send("ServiceWorker.enable");
  const message = { title: "Fix the flaky test", body: "Done · acme", url: "/a/ag_x", tag: "ag_x" };
  const id = await registrationId;
  // A push that reaches a worker that isn't running yet can be dropped (seen on CI), so deliver
  // until it shows; the tag makes a repeat replace the notification, not add another.
  await expect
    .poll(
      async () => {
        await cdp.send("ServiceWorker.deliverPushMessage", {
          origin: rowrow.url,
          registrationId: id,
          data: JSON.stringify(message),
        });
        await page.waitForTimeout(500);
        return page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          return (await registration.getNotifications()).map((n) => [n.title, n.body, n.tag]);
        });
      },
      { timeout: 20_000, intervals: [500] },
    )
    .toEqual([[message.title, message.body, message.tag]]);
});

test("paste an image and pick a file: they wait as tiles, go with the message, and show on it", async ({
  page,
  rowrow,
}) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "files",
  });
  await rowrow.open(page, `/a/${agent.id}`);
  const input = page.getByLabel("Message input");
  await expect(input).toBeEnabled();

  // A 1×1 PNG, pasted the way a screenshot is.
  const png = [...Buffer.from(ONE_PIXEL_PNG, "base64")];
  await input.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, png);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files" }).click();
  await (
    await chooser
  ).setFiles([
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# notes") },
    { name: "extra.txt", mimeType: "text/plain", buffer: Buffer.from("not this one") },
  ]);

  const tiles = page.getByRole("group", { name: "Attachments" });
  await expect(tiles.getByRole("img", { name: "shot.png" })).toBeVisible();
  await expect(tiles.getByText("notes.md")).toBeVisible();
  await tiles.getByRole("button", { name: "Remove extra.txt" }).click();
  await expect(tiles.getByText("extra.txt")).toBeHidden();
  await expect(tiles.getByLabel("Uploading")).toHaveCount(0);

  await input.fill("/echo got them");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(tiles).toBeHidden();
  await expect(page.getByText("got them", { exact: true })).toBeVisible();
  const message = page.getByRole("article", { name: "Your message" });
  await expect(message.getByText("/echo got them")).toBeVisible();
  await expect(message.getByText("notes.md")).toBeVisible();
  await expect(message.getByText("extra.txt")).toBeHidden();
  await message.getByRole("button", { name: "Open shot.png" }).click();
  await expect(
    page.getByRole("dialog", { name: "shot.png" }).getByRole("img", { name: "shot.png" }),
  ).toBeVisible();

  // The agent got its own text: the files listed first, the image as image input.
  const { entries } = await rowrow.client.agents.entries({ agentId: agent.id, after: -1 });
  const request = entries.find(
    (e) => e.kind === "oar" && e.record.kind === "request" && e.record.body.kind === "prompt",
  );
  expect(request?.kind === "oar" && request.record.kind === "request" && request.record.body).toMatchObject({
    input: expect.stringMatching(
      /^# Files mentioned by the user:\n\n## shot\.png: .+\nImage attachment: true\n\n## notes\.md: /,
    ),
    images: [{ mediaType: "image/png" }],
  });
});

test("a new agent's first message can carry files", async ({ page, rowrow }) => {
  await rowrow.client.workspaces.add({ path: rowrow.repo() });
  await rowrow.open(page);
  await page.getByRole("button", { name: "New agent" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await dialog.getByRole("button", { name: /^Agent: / }).click();
  await page.getByRole("option", { name: /Scripted demo/ }).click();

  const prompt = dialog.getByLabel("First message");
  await prompt.evaluate(
    (element, bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    [...Buffer.from(ONE_PIXEL_PNG, "base64")],
  );
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Attach files" }).click();
  await (
    await chooser
  ).setFiles([{ name: "plan.md", mimeType: "text/markdown", buffer: Buffer.from("# plan") }]);
  const tiles = dialog.getByRole("group", { name: "Attachments" });
  await expect(tiles.getByRole("img", { name: "shot.png" })).toBeVisible();
  await expect(tiles.getByText("plan.md")).toBeVisible();
  await expect(tiles.getByLabel("Uploading")).toHaveCount(0);

  await prompt.fill("/echo started with files");
  await dialog.getByRole("button", { name: "Create and send" }).click();
  await expect(page).toHaveURL(/\/a\/ag_/);
  await expect(page.getByText("started with files", { exact: true })).toBeVisible();
  const message = page.getByRole("article", { name: "Your message" });
  await expect(message.getByRole("button", { name: "Open shot.png" })).toBeVisible();
  await expect(message.getByText("plan.md")).toBeVisible();
});

test("a video waits as its first frame and plays from the message", async ({ page, rowrow }) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "video",
  });
  await rowrow.open(page, `/a/${agent.id}`);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files" }).click();
  // A real (tiny) video: the page must be allowed to decode it (media-src in the CSP).
  const clip = fs.readFileSync(path.join(import.meta.dirname, "clip.webm"));
  await (await chooser).setFiles([{ name: "repro.webm", mimeType: "video/webm", buffer: clip }]);
  const tiles = page.getByRole("group", { name: "Attachments" });
  const frame = tiles.getByLabel("repro.webm", { exact: true });
  await expect
    .poll(async () => frame.evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThan(1);
  await expect(tiles.getByLabel("Uploading")).toHaveCount(0);

  await page.getByLabel("Message input").fill("/echo see the video");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("see the video", { exact: true })).toBeVisible();
  await page
    .getByRole("article", { name: "Your message" })
    .getByRole("button", { name: "Play repro.webm" })
    .click();
  const player = page.getByRole("dialog", { name: "repro.webm" }).getByLabel("repro.webm", { exact: true });
  await expect
    .poll(async () => player.evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThan(1);
});

test("while an agent works, a message queues above the composer: edit it, delete it, stop and send", async ({
  page,
  rowrow,
}, info) => {
  const phone = info.project.name === "phone";
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "queues",
    input: { inputId: randomUUID(), text: "/sleep 60000" },
  });
  await rowrow.open(page, `/a/${agent.id}`);
  const input = page.getByRole("textbox", { name: "Message input" });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  for (const text of ["/echo first", "/echo second"]) {
    await input.fill(text);
    await page.getByRole("button", { name: "Queue", exact: true }).click();
  }
  const tray = page.getByRole("region", { name: "Up next" });
  await expect(tray).toContainText("2 queued");
  await expect(input).toHaveValue("");

  // Edit takes it back into the composer; Delete drops it, and Undo puts it after your draft.
  await trayAction(page, tray.getByRole("listitem").filter({ hasText: "/echo second" }), "Edit", phone);
  await expect(input).toHaveValue("/echo second");
  await expect(tray).toContainText("1 queued");
  await trayAction(page, tray.getByRole("listitem").filter({ hasText: "/echo first" }), "Delete", phone);
  await expect(tray).toBeHidden();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(input).toHaveValue("/echo second\n\n/echo first");

  await input.fill("/echo right away");
  await page.getByRole("button", { name: "More ways to send" }).click();
  await page.getByRole("menuitem", { name: /Stop and send/ }).click();
  await expect(page.getByText("right away", { exact: true })).toBeVisible();
});

test("⌘↵ steers into the turn, ↑ takes a queued message back, and a stopped turn pauses the queue", async ({
  page,
  rowrow,
}, info) => {
  test.skip(info.project.name === "phone", "keyboard shortcuts are a desktop affordance");
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "steers",
    input: { inputId: randomUUID(), text: "/sleep 60000" },
  });
  await rowrow.open(page, `/a/${agent.id}`);
  const input = page.getByRole("textbox", { name: "Message input" });
  const tray = page.getByRole("region", { name: "Up next" });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await input.fill("/echo later");
  await input.press("Enter");
  await expect(tray).toContainText("1 queued");
  // The sidebar says so too.
  await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
  await input.press("ArrowUp");
  await expect(input).toHaveValue("/echo later");
  await expect(tray).toBeHidden();
  await input.press("Enter");
  await expect(tray).toContainText("1 queued");

  await input.fill("steer this way");
  await input.press("ControlOrMeta+Enter");
  await expect(
    page.getByRole("article", { name: "Your message" }).filter({ hasText: "steer this way" }),
  ).toContainText("Steered in");

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(tray).toContainText("Queue paused · you stopped the turn");
  // Your stop was accepted in that turn: it's yours, not the agent's.
  await expect(page.getByText("You stopped the turn.")).toBeVisible();
  await tray.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("later", { exact: true })).toBeVisible();
  await expect(tray).toBeHidden();
});

test("work an agent runs in the background shows beside it until it stops", async ({ page, rowrow }) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "backgrounds",
    input: { inputId: randomUUID(), text: "/background 600000 npm test" },
  });
  await rowrow.open(page, `/a/${agent.id}`);
  // The turn is over; the command isn't.
  await expect(page.getByText("Started npm test in the background.")).toBeVisible();
  const tasks = page.getByRole("button", { name: "1 in background" });
  await tasks.click();
  await expect(page.getByRole("dialog").getByText("npm test", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // Its processes end with the agent's.
  await rowrow.client.agents.stop({ agentId: agent.id });
  await expect(tasks).toBeHidden();
});

test("a tool call says how long it took", async ({ page, rowrow }) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "runs",
    input: { inputId: randomUUID(), text: "/run 2200 npm test" },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 15_000 });
  await rowrow.open(page, `/a/${agent.id}`);
  await expect(page.getByText("Ran npm test.")).toBeVisible();
  await expect(page.getByTitle("How long it took")).toHaveText(/^[23]s$/);
});

test("a run of tool calls folds into one line", async ({ page, rowrow }) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "several runs",
    input: { inputId: randomUUID(), text: "/run 10 ls\nfalse\ngit status" },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 15_000 });
  await rowrow.open(page, `/a/${agent.id}`);
  // oar classifies tools per runtime; the scripted runtime's Bash is just "a tool".
  const summary = page.getByRole("button", { name: "Used 3 tools · 1 failed" });
  await expect(summary).toBeVisible();
  await expect(page.getByLabel("Failed")).toBeHidden();
  await summary.click();
  await expect(page.getByLabel("Done")).toHaveCount(2);
  await expect(page.getByLabel("Failed")).toBeVisible();
  await expect(page.getByText("exit code 1")).toBeVisible();
});

test("Coach: allow a workspace, ask, and read its answer and the work it did", async ({
  page,
  rowrow,
}, info) => {
  const phone = info.project.name === "phone";
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  await rowrow.client.agents.create({ workspaceId: ws.id, runtime: "scripted", title: "the helper" });
  await rowrow.client.settings.update({
    coach: { workspaces: [], runtime: "scripted", model: null, effort: null },
  });
  await rowrow.open(page);
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  const coach = page.getByRole("complementary", { name: "Coach" });
  if (phone) await page.getByRole("button", { name: "Open Coach" }).click();
  else await page.keyboard.press("ControlOrMeta+Alt+Shift+KeyA");
  await expect(coach).toBeVisible();
  await expect(coach.getByText("What would you like to work on?")).toBeVisible();
  if (phone) {
    // Full screen on a phone.
    const box = await coach.boundingBox();
    expect(box?.width).toBe(page.viewportSize()?.width);
    expect(box?.height).toBe(page.viewportSize()?.height);
  }

  // It reads nothing until you allow a workspace.
  await expect(coach.getByText("Allow workspaces in Coach's settings to send messages.")).toBeVisible();
  await coach.getByRole("button", { name: "Coach settings" }).last().click();
  await expect(coach.getByText(/may be sent to your model provider/)).toBeVisible();
  await coach.getByRole("checkbox", { name: ws.label }).check();
  await coach.getByRole("button", { name: "Save" }).click();

  const message = coach.getByLabel("Message Coach");
  await expect(message).toBeFocused();
  await message.fill("/echo hi from Coach");
  await message.press("Enter");
  await expect(coach.getByText("hi from Coach", { exact: true })).toBeVisible();
  await expect(coach.getByText("Idle", { exact: true })).toBeVisible();

  // Its tools' calls fold under its answer, with what they read.
  await message.fill("/mcp agents_status\nOne agent: the helper, idle.");
  await message.press("Enter");
  await expect(coach.getByText("One agent: the helper, idle.", { exact: true })).toBeVisible();
  const work = coach.getByRole("button", { name: "Work performed (2)" });
  await expect(work).toBeVisible();
  await work.click();
  await expect(coach.getByRole("button", { name: /^Agent status/ })).toBeVisible();
  await expect(
    coach.getByRole("button", { name: new RegExp(`${ws.label}.*Agent status · Read`) }),
  ).toBeVisible();

  // A Coach chat is not one of the agents.
  if (!phone)
    await expect(page.getByRole("navigation", { name: "Agents and workspaces" })).not.toContainText(
      "hi from Coach",
    );

  if (!phone) {
    await coach.getByRole("button", { name: "Pin Coach" }).click();
    await expect(coach.getByRole("button", { name: "Float Coach" })).toBeVisible();
    await coach.getByRole("button", { name: "Maximize Coach" }).click();
    await expect(coach.getByRole("button", { name: "Float Coach" })).toBeHidden();
    // Escape restores the window, then closes it.
    await page.keyboard.press("Escape");
    await expect(coach.getByRole("button", { name: "Maximize Coach" })).toBeVisible();
    await coach.getByRole("button", { name: "Maximize Coach" }).focus();
    await page.keyboard.press("Escape");
    await expect(coach).toBeHidden();
    // Pinned stays pinned in this browser.
    await page.reload();
    // The shortcut is heard once the app is up.
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Alt+Shift+KeyA");
    await expect(coach.getByRole("button", { name: "Float Coach" })).toBeVisible();
    await expect(coach.getByText("hi from Coach", { exact: true })).toBeVisible();
  } else {
    await coach.getByRole("button", { name: "Close Coach" }).click();
    await expect(coach).toBeHidden();
  }
});

test("Coach: confirm the message it proposes and read rowrow's receipt; Full access only through its dialog", async ({
  page,
  rowrow,
}) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "the helper",
  });
  await rowrow.client.settings.update({
    coach: { workspaces: [ws.id], runtime: "scripted", model: null, effort: null },
  });
  const inputs = async () =>
    (await rowrow.client.agents.entries({ agentId: agent.id })).entries.flatMap((entry) =>
      entry.kind === "input" ? [entry.text] : [],
    );
  await rowrow.open(page);
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  const coach = page.getByRole("complementary", { name: "Coach" });
  await page.getByRole("button", { name: "Open Coach" }).click();

  // Coach proposes; nothing happens until you confirm.
  const message = coach.getByLabel("Message Coach");
  await message.fill(
    `/mcp propose_agent_prompt {"agentId":"${agent.id}","prompt":"/echo hello from Coach"}\nI proposed a message for the helper.`,
  );
  await message.press("Enter");
  await expect(coach.getByText("I proposed a message for the helper.", { exact: true })).toBeVisible();
  const card = coach.getByRole("region", { name: "Send prompt action" });
  await expect(card.getByText("Needs confirmation")).toBeVisible();
  await expect(card.getByText("Waiting for your confirmation. Nothing has been executed.")).toBeVisible();
  await expect(card.getByText("Prompt — 22 characters")).toBeVisible();
  await expect(card.getByLabel("Exact prompt")).toHaveText("/echo hello from Coach");
  await expect(card.getByText(agent.id, { exact: true })).toBeVisible();
  expect(await inputs()).toEqual([]);

  await card.getByRole("button", { name: "Confirm action" }).click();
  await expect(card.getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(
    card.getByText(`the helper (${agent.id}) took the exact prompt and started a turn.`),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Confirm action" })).toBeHidden();
  expect(await inputs()).toEqual(["/echo hello from Coach"]);

  // Full access needs your consent in a dialog, and the header says so while it lasts.
  await coach.getByRole("button", { name: "Coach settings" }).first().click();
  const marker = coach.getByLabel("Full access: all workspaces");
  const dialog = page.getByRole("alertdialog", { name: "Turn on Full access?" });
  await coach.getByRole("button", { name: "Turn on Full access" }).click();
  await expect(dialog.getByText(/without asking/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(marker).toBeHidden();
  await coach.getByRole("button", { name: "Turn on Full access" }).click();
  await dialog.getByRole("button", { name: "Turn on Full access" }).click();
  await expect(marker).toBeVisible();
  await expect(coach.getByRole("checkbox", { name: ws.label })).toBeDisabled();
  await expect(coach.getByRole("checkbox", { name: ws.label })).toBeChecked();
  await coach.getByRole("button", { name: "Turn off Full access" }).click();
  await expect(marker).toBeHidden();
  expect((await rowrow.client.state.get()).state.settings.coach.fullAccess).toBe(false);
});

/** A queued message's action: its button on a desktop, its ⋯ menu on a phone. */
async function trayAction(page: Page, row: Locator, name: string, phone: boolean): Promise<void> {
  if (!phone) return row.getByRole("button", { name }).click();
  await row.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name }).click();
}

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a Mermaid diagram in a reply draws, follows the theme, zooms, and goes fullscreen until Escape", async ({
  page,
  context,
  rowrow,
}) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const diagram = [
    "```mermaid",
    // What a diagram may not do: restyle itself, load a picture, link off the page.
    '%%{init: {"themeCSS": ".node rect { fill: url(https://example.com/pixel.png) }"}}%%',
    "flowchart LR",
    '  plan["Plan changes <img src=https://example.com/pixel.png>"] --> build[Implement] --> check[Verify]',
    '  click plan href "https://example.com/tracked"',
    "```",
  ];
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "draws a plan",
    input: { inputId: randomUUID(), text: ["/echo Here is the plan:", ...diagram].join("\n") },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 10_000 });
  await rowrow.open(page, `/a/${agent.id}`);

  const figure = page.getByRole("region", { name: "Mermaid diagram", exact: true });
  await expect(figure.locator("svg").first()).toBeVisible();
  await expect(figure.getByText("Implement")).toBeVisible();
  // Sanitized: nothing in it reaches off the page.
  const external = await figure
    .locator("svg")
    .first()
    .evaluate((svg) => ({
      links: [...svg.querySelectorAll("*")].flatMap((element) =>
        [...element.attributes]
          .filter((a) => /href$/i.test(a.name) && !a.value.startsWith("#"))
          .map((a) => a.value),
      ),
      css: [...svg.querySelectorAll("style")].some((style) =>
        /url\(\s*["']?https?:/i.test(style.textContent ?? ""),
      ),
      pictures: svg.querySelectorAll("img, image").length,
    }));
  expect(external).toEqual({ links: [], css: false, pictures: 0 });

  // It's drawn in the app's colors: pick Light (in another tab, to stay here) and it redraws.
  const fill = (): Promise<string> =>
    figure
      .locator("g.node :is(rect, path, polygon)")
      .first()
      .evaluate((shape) => getComputedStyle(shape).fill);
  const dark = await fill();
  const settings = await context.newPage();
  await settings.goto(`${rowrow.url}/settings`);
  await settings.getByRole("tablist", { name: "Theme" }).getByRole("tab", { name: "Light" }).click();
  await settings.close();
  await expect.poll(fill).not.toBe(dark);

  // It fits its width at first; zoom in and back to Fit.
  const level = figure.getByLabel("Zoom level");
  const fitted = await level.textContent();
  await figure.getByRole("button", { name: "Zoom in" }).click();
  await expect(level).not.toHaveText(fitted ?? "");
  await expect(figure.getByRole("button", { name: "Fit" })).toHaveAttribute("aria-pressed", "false");
  await figure.getByRole("button", { name: "Fit" }).click();
  await expect(level).toHaveText(fitted ?? "");

  // Fullscreen moves it into a dialog; Escape brings it back, with focus where it was.
  await figure.getByRole("button", { name: "Fullscreen" }).click();
  const full = page.getByRole("dialog", { name: "Mermaid diagram fullscreen" });
  await expect(full.locator("svg").first()).toBeVisible();
  await expect(full.getByRole("button", { name: "Exit fullscreen" })).toBeFocused();
  await expect(page.locator("[data-mermaid] > svg")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(full).toBeHidden();
  await expect(figure.getByRole("button", { name: "Fullscreen" })).toBeFocused();
  await expect(figure.locator("svg").first()).toBeVisible();
});

test("a .mmd file previews as a diagram, its source a tab away", async ({ page, rowrow }, info) => {
  const ws = await rowrow.client.workspaces.add({ path: rowrow.repo() });
  const { agent, sent } = await rowrow.client.agents.create({
    workspaceId: ws.id,
    runtime: "scripted",
    title: "writes a diagram",
    input: { inputId: randomUUID(), text: "/write flow.mmd\nsequenceDiagram\n  Agent->>You: Review this" },
  });
  await rowrow.client.agents.wait({ agentId: agent.id, afterSeq: sent?.seq ?? -1, timeoutMs: 10_000 });
  await rowrow.open(page, `/a/${agent.id}`);
  await page.getByRole("button", { name: /Changes/ }).click();
  const inspector =
    info.project.name === "phone"
      ? page.getByRole("dialog")
      : page.getByRole("region", { name: "Inspector" });
  await inspector.getByRole("tab", { name: "Files" }).click();
  await inspector.getByRole("treeitem", { name: /flow\.mmd/ }).click();

  const figure = inspector.getByRole("region", { name: "Mermaid diagram", exact: true });
  await expect(figure.locator("svg").first()).toBeVisible();
  await expect(figure.getByText("Review this")).toBeVisible();
  // Escape leaves fullscreen, not the inspector around it.
  await figure.getByRole("button", { name: "Fullscreen" }).click();
  await expect(page.getByRole("dialog", { name: "Mermaid diagram fullscreen" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Mermaid diagram fullscreen" })).toBeHidden();
  await expect(figure).toBeVisible();

  await inspector.getByRole("tab", { name: "Source" }).click();
  await expect(inspector.getByText("Agent->>You: Review this")).toBeVisible();
  await expect(figure).toBeHidden();
});
