// Renders src/web/public/icon.svg to the PNG icons iOS and Android want (192, 512).
// Run after changing the SVG: node scripts/icons.ts
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../src/web/public");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log("wrote icon-192.png and icon-512.png");
