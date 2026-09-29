// The web app (docs/decisions.md, D-017): React + Tailwind, with components we own in
// src/web/components/ui. `pnpm dev` runs this dev server in front of a rowrow server (see
// scripts/dev.ts); `pnpm build` writes dist/web, which `rowrow serve` serves.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const backend = process.env["ROWROW_DEV_BACKEND"] ?? "http://127.0.0.1:7374";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src/web") },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
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
