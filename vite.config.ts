// The web app (docs/decisions.md, D-014): React + Astryx's pre-built CSS, with StyleX for
// our own styles. `pnpm dev` runs this dev server in front of a rowrow server (see
// scripts/dev.ts); `pnpm build` writes dist/web, which `rowrow serve` serves.
import { unplugin as stylex } from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Keep native CSS light-dark() (Astryx's dark mode) instead of Lightning CSS's polyfill.
const CSS_TARGET = ["chrome123", "edge123", "firefox120", "safari17.5"];
const backend = process.env["ROWROW_DEV_BACKEND"] ?? "http://127.0.0.1:7374";

export default defineConfig({
  root: "src/web",
  plugins: [
    stylex.vite({
      classNamePrefix: "rr",
      useCSSLayers: { before: ["reset", "astryx-base", "astryx-theme"] },
      lightningcssOptions: {
        targets: { chrome: 123 << 16, firefox: 120 << 16, safari: (17 << 16) | (5 << 8) },
      },
    }),
    react(),
  ],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    cssTarget: CSS_TARGET,
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: Number(process.env["ROWROW_WEB_PORT"] ?? 5173),
    strictPort: true,
    proxy: {
      "/rpc": { target: backend, ws: true },
      "/api": backend,
      "/auth": backend,
      "/healthz": backend,
    },
  },
});
