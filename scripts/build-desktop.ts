// `pnpm build:desktop`: the Mac app's own code in dist/desktop (docs/desktop.md): the main
// process and the preload, each one CommonJS file with its dependencies inside (electron-updater,
// the oRPC client), so the app carries no node_modules; the app's pages (src/desktop/ui) built
// like the web app; its package.json and menu-bar icons. `pnpm package:desktop` puts it in a
// rowrow.app with a server bundle.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { build, type InlineConfig } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist", "desktop");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version: string;
  description: string;
  license: string;
  author: string;
};

/** A Node module for Electron's main world: CommonJS, everything but Electron and Node inside. */
function node(entry: string, file: string): InlineConfig {
  return {
    configFile: false,
    root,
    logLevel: "warn",
    resolve: { conditions: ["node"] },
    ssr: { noExternal: true, external: ["electron"] },
    build: {
      ssr: entry,
      outDir: out,
      emptyOutDir: false,
      target: "node24",
      sourcemap: true,
      minify: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: file } },
    },
  };
}

/** `version`: the package's, unless a test build says otherwise (package:desktop --version). */
export async function buildDesktop(version = pkg.version): Promise<void> {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await build(node("src/desktop/main.ts", "main.cjs"));
  await build(node("src/desktop/preload.ts", "preload.cjs"));
  await build({
    configFile: false,
    root: path.join(root, "src", "desktop", "ui"),
    logLevel: "warn",
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.join(root, "src", "web") } },
    build: { outDir: path.join(out, "ui"), emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 2000 },
  });
  for (const icon of ["trayTemplate.png", "trayTemplate@2x.png"])
    fs.copyFileSync(path.join(root, "desktop", icon), path.join(out, icon));
  fs.writeFileSync(
    path.join(out, "package.json"),
    `${JSON.stringify(
      {
        // Not "rowrow": electron-builder would take it for the root package and pack the server's
        // dependencies. productName names the app (and its data directory).
        name: "rowrow-desktop",
        productName: "rowrow",
        version,
        description: pkg.description,
        license: pkg.license,
        author: pkg.author,
        main: "main.cjs",
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`build:desktop: ${path.relative(root, out)} (rowrow ${version})`);
}

if (import.meta.main) await buildDesktop();
