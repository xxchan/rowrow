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
      ? page.getByRole("dialog")
      : page.getByRole("region", { name: "Inspector" });
  await expect(panel.getByText("src/hello.ts")).toBeVisible();
  await panel.getByText("src/hello.ts").click();
  await expect(panel.getByText("export const hello = 1;")).toBeVisible();
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

  // Find a line, open it.
  await inspector.getByRole("tab", { name: "Files" }).click();
  await inspector.getByRole("searchbox", { name: "Search files" }).fill("answer");
  await inspector.getByRole("button", { name: /the answer is 42/ }).click();
  await expect(inspector.getByText("the answer is 42")).toBeVisible();

  // The history has the repository's first commit, and its file.
  await inspector.getByRole("tab", { name: "History" }).click();
  await inspector.getByRole("button", { name: /init/ }).click();
  await expect(inspector.getByRole("button", { name: /README\.md/ })).toBeVisible();
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
  await page.keyboard.type("quiet");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/a/${quiet.agent.id}$`));

  await page.keyboard.press("ControlOrMeta+j");
  await expect(page).toHaveURL(new RegExp(`/a/${loud.id}$`));
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
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: rowrow.url,
    registrationId: await registrationId,
    data: JSON.stringify(message),
  });
  // Starting a stopped worker can take a while on a loaded machine.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          return (await registration.getNotifications()).map((n) => [n.title, n.body, n.tag]);
        }),
      { timeout: 15_000 },
    )
    .toEqual([[message.title, message.body, message.tag]]);
});
