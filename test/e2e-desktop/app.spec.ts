// The Mac app, driven like a person would (docs/desktop.md): the development build (dist/desktop)
// in Electron, on a throwaway home, with this checkout's server as the app's own child process
// (no launchd) and the scripted runtime. `pnpm test:desktop` builds it and runs this.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { electronBinary } from "../../scripts/electron.ts";

const root = path.resolve(import.meta.dirname, "../..");

async function launch(tmp: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronBinary(),
    args: [path.join(root, "dist", "desktop")],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ROWROW_"))),
      ROWROW_HOME: path.join(tmp, "home"),
      ROWROW_DESKTOP_USER_DATA: path.join(tmp, "app"),
      ROWROW_DESKTOP_SUPERVISOR: "child",
      ROWROW_DESKTOP_SERVER: root,
      ROWROW_DESKTOP_NODE: process.execPath,
      ROWROW_DESKTOP_TEST_RUNTIME: "1",
      ROWROW_DESKTOP_PLAIN_TOKENS: "1",
    },
  });
}

/**
 * Pictures for a person to look at (CI keeps them as the desktop-shots artifact): the page, and
 * the whole screen, which has what the page can't show, the window buttons over it (D-057).
 */
async function shoot(page: Page, name: string): Promise<void> {
  const dir = path.join(root, "test-results", "desktop", "shots");
  fs.mkdirSync(dir, { recursive: true });
  await page.bringToFront();
  await page.screenshot({ path: path.join(dir, `${name}-page.png`) });
  if (process.platform !== "darwin") return;
  try {
    execFileSync("screencapture", ["-x", path.join(dir, `${name}-screen.png`)]);
  } catch {
    // No screen to capture (or no permission to): the page's picture will do.
  }
}

/** The checkout's CLI, against the app's server. */
function rowrow(tmp: string, ...args: string[]): string {
  return execFileSync(
    process.execPath,
    [path.join(root, "src", "cli", "main.ts"), ...args, "--profile", "default"],
    {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ROWROW_"))),
        ROWROW_HOME: path.join(tmp, "home"),
      },
      encoding: "utf8",
    },
  );
}

test("sets this Mac up, opens its server signed in, and counts what needs you", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-desktop-e2e-")));
  const app = await launch(tmp);
  try {
    const home = await app.firstWindow();
    await expect(home.getByRole("heading", { name: "Where do your agents run?" })).toBeVisible();
    await shoot(home, "welcome");
    await home.getByRole("button", { name: "Set up this Mac" }).click();

    // The server's own web app, signed in with the app's credential (no sign-in page).
    const server = await app.waitForEvent("window", { timeout: 60_000 });
    await expect(server.getByRole("button", { name: /New agent/ }).first()).toBeVisible({ timeout: 30_000 });
    const devices = JSON.parse(rowrow(tmp, "call", "devices.list")) as { name: string; kind: string }[];
    expect(devices.some((d) => d.kind === "app" && d.name.startsWith("rowrow for Mac"))).toBe(true);

    const card = home.getByRole("article", { name: "This Mac" });
    await expect(card).toContainText("Connected");

    // An agent finishes while no window shows it: the app hears it (notify.watch) and counts it.
    await server.close();
    const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
      {
        cwd: repo,
      },
    );
    rowrow(tmp, "agent", "new", repo, "--runtime", "scripted", "--title", "Echo", "/echo done", "--wait");
    await expect(card).toContainText("1 needs you", { timeout: 15_000 });

    // Open brings the server's window back.
    await card.getByRole("button", { name: "Open" }).click();
    const again = await app.waitForEvent("window");
    await expect(again.getByRole("button", { name: /New agent/ }).first()).toBeVisible({ timeout: 30_000 });

    // No title bar (D-057): the server's page knows it's in the app and leaves the buttons room.
    await expect(again.locator("html")).toHaveAttribute("data-chrome", "mac");
    await shoot(again, "server");
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("adds a server by its sign-in link", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-desktop-e2e-")));
  // A server of its own, not the app's: started here, in the background.
  const serve = await import("node:child_process").then(({ spawn }) =>
    spawn(
      process.execPath,
      [
        path.join(root, "src", "cli", "main.ts"),
        "serve",
        "--profile",
        "other",
        "--port",
        "0",
        "--test-runtime",
      ],
      {
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ROWROW_"))),
          ROWROW_HOME: path.join(tmp, "elsewhere"),
        },
        stdio: "ignore",
      },
    ),
  );
  const app = await launch(tmp);
  try {
    const serverFile = path.join(tmp, "elsewhere", "other", "server.json");
    await expect.poll(() => fs.existsSync(serverFile), { timeout: 30_000 }).toBe(true);
    const link = (
      JSON.parse(
        execFileSync(
          process.execPath,
          [path.join(root, "src", "cli", "main.ts"), "pair", "--json", "--profile", "other"],
          {
            env: { ...process.env, ROWROW_HOME: path.join(tmp, "elsewhere") },
            encoding: "utf8",
          },
        ),
      ) as { url: string }
    ).url;

    const home = await app.firstWindow();
    await home.getByRole("button", { name: "Paste a sign-in link" }).click();
    await home.getByLabel("Sign-in link").fill(link);
    await home.getByLabel("Name (optional)").fill("Elsewhere");
    await home.getByRole("button", { name: "Sign in" }).click();
    const server = await app.waitForEvent("window", { timeout: 30_000 });
    await expect(server.getByRole("button", { name: /New agent/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(home.getByRole("article", { name: "Elsewhere" })).toContainText("Connected");
  } finally {
    await app.close();
    serve.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
