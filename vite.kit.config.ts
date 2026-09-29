// The kit (src/kit/kit.ts, docs/decisions.md D-027): src/shared's folds as one script for
// JavaScriptCore, written to dist/kit/kit.js. `pnpm build` makes it; `rowrow serve` serves it
// at /kit.js; `pnpm dev` rebuilds it on every change.
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(import.meta.dirname, "src/kit/kit.ts"),
      formats: ["iife"],
      name: "rowrowKitBundle",
      fileName: () => "kit.js",
    },
    outDir: "dist/kit",
    emptyOutDir: true,
    // JavaScriptCore on iOS 26 runs all of ES2022; nothing needs polyfills.
    target: "es2022",
    minify: true,
    sourcemap: false,
  },
});
