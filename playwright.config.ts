// End-to-end tests: the built web app in Chromium against a real rowrow server with the
// scripted runtime (zero tokens), on desktop and phone viewports. `pnpm test:e2e` builds
// the app first. Screenshots of failures land in test-results/.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    // Full Chromium in headless mode, not the headless shell: closer to real Chrome, and the
    // shell has no notifications.
    channel: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
