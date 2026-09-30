// End-to-end tests: the built web app in Chromium against a real rowrow server with the
// scripted runtime (zero tokens), on desktop and phone viewports. `pnpm test:e2e` builds
// the app first when it changed (scripts/e2e.ts). Screenshots of failures land in
// test-results/. Locally a dot per test and the failures in full: short enough to read whole.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env["CI"] === undefined ? "dot" : [["list"], ["html", { open: "never" }]],
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
