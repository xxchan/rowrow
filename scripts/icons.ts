// Icons, from their sources. Run after changing src/web/public/icon.svg or upgrading oar:
// node scripts/icons.ts
//
// - src/web/public/icon.svg → the PNG icons iOS and Android want for the web app (192, 512),
//   and the iOS app's icon (1024, square and opaque: iOS rounds the corners itself).
// - oar's runtime marks (assets/brands, see its NOTICE.md) → the iOS app's runtime-<id> image
//   sets: single-color marks as templates (they take the text color), the rest as they are.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "src/web/public");
const assets = path.join(root, "ios/Rowrow/Assets.xcassets");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const browser = await chromium.launch();

async function render(source: string, size: number, file: string, transparent: boolean): Promise<void> {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0">${source.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
}

for (const size of [192, 512]) await render(svg, size, path.join(dir, `icon-${size}.png`), true);
await render(svg.replace(/ rx="\d+"/, ""), 1024, path.join(assets, "AppIcon.appiconset/AppIcon.png"), false);
await browser.close();

// ─── Runtime marks for the iOS app ───────────────────────────────────────────

const brands = path.join(root, "node_modules/@botiverse/oar/assets/brands");

/** runtime id → its files (a dark-appearance variant when the mark needs one), and whether it's one color. */
const RUNTIMES: Readonly<Record<string, { light: string; dark?: string; template?: boolean }>> = {
  claude: { light: "claude.svg" },
  codex: { light: "codex-on-light.svg", template: true },
  cursor: { light: "cursor-on-light.svg", template: true },
  grok: { light: "grok-on-light.svg", template: true },
  kimi: { light: "kimi-on-light.svg", dark: "kimi-on-dark.svg" },
  pi: { light: "pi.svg" },
  antigravity: { light: "antigravity.svg" },
};

/** Xcode's asset compiler wants a pixel size, not LobeHub's `1em`. */
function forXcode(source: string): string {
  const [, width = "24", height = "24"] = /viewBox="0 0 (\d+) (\d+)"/.exec(source) ?? [];
  return source
    .replace(/<\?xml[^>]*\?>\s*/, "")
    .replaceAll(/\s(?:height|width)="1em"/g, "")
    .replace(/\sstyle="[^"]*"/, "")
    .replace("<svg ", `<svg width="${width}" height="${height}" `);
}

/** Contents.json the way Xcode writes it (`"key" : value`), so opening the catalog in Xcode changes nothing. */
function xcodeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replaceAll('": ', '" : ')}\n`;
}

for (const [id, files] of Object.entries(RUNTIMES)) {
  const name = `runtime-${id}`;
  const set = path.join(assets, `${name}.imageset`);
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set, { recursive: true });
  const images: object[] = [];
  for (const [appearance, file] of [
    [null, files.light],
    ["dark", files.dark],
  ] as const) {
    if (file === undefined) continue;
    const out = `${name}${appearance === null ? "" : `-${appearance}`}.svg`;
    fs.writeFileSync(path.join(set, out), forXcode(fs.readFileSync(path.join(brands, file), "utf8")));
    images.push({
      filename: out,
      idiom: "universal",
      ...(appearance === null ? {} : { appearances: [{ appearance: "luminosity", value: appearance }] }),
    });
  }
  fs.writeFileSync(
    path.join(set, "Contents.json"),
    xcodeJson({
      images,
      info: { author: "xcode", version: 1 },
      properties: {
        "preserves-vector-representation": true,
        ...(files.template === true ? { "template-rendering-intent": "template" } : {}),
      },
    }),
  );
}
console.log(
  `wrote icon-192.png, icon-512.png, the iOS app icon, and ${Object.keys(RUNTIMES).length} runtime marks`,
);
