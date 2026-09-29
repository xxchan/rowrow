import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // Tests never touch the user's rowrow: every server test uses a throwaway ROWROW_HOME.
    env: { ROWROW_HOME: "/nonexistent-set-per-test" },
  },
});
