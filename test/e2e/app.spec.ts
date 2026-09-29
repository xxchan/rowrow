// The app as a person uses it, on a desktop and a phone viewport. Each test gets its own
// server and data (fixtures.ts); agents are the scripted runtime, so no tokens are spent.
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures.ts";

test("a signed-out browser is asked to sign in, not shown an error", async ({ page, rowrow }) => {
  await page.goto(rowrow.url);
  await expect(page.getByRole("heading", { name: "Sign in to rowrow" })).toBeVisible();
});

test("sign in with a one-time link, create an agent, and read its answer", async ({ page, rowrow }, info) => {
  test.skip(info.project.name === "phone", "the new-agent dialog is covered on desktop");
  await rowrow.client.workspaces.add({ path: rowrow.repo() });
  await rowrow.open(page);
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New agent" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Agent").click();
  await page.getByRole("option", { name: /Scripted demo/ }).click();
  await dialog.getByLabel("First message").fill("/echo hello from e2e");
  await dialog.getByRole("button", { name: "Create and send" }).click();

  await expect(page).toHaveURL(/\/a\/ag_/);
  await expect(page.getByText("hello from e2e", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "/echo hello from e2e" })).toBeVisible();
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
      ? page.getByRole("dialog", { name: "Changes" })
      : page.getByRole("region", { name: "Changes" });
  await expect(panel.getByText("src/hello.ts")).toBeVisible();
  await panel.getByText("src/hello.ts").click();
  await expect(panel.getByText("export const hello = 1;")).toBeVisible();
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
  await page.keyboard.type("quiet");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/a/${quiet.agent.id}$`));

  await page.keyboard.press("ControlOrMeta+j");
  await expect(page).toHaveURL(new RegExp(`/a/${loud.id}$`));
});
