// The Mac app's end-to-end tests (test/e2e-desktop): Electron, one app at a time.
// `pnpm test:desktop` builds dist/desktop first.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e-desktop",
  timeout: 180_000,
  workers: 1,
  retries: process.env["CI"] === undefined ? 0 : 1,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  outputDir: "test-results/desktop",
});
