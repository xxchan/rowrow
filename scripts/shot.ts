// Screenshot the real UI of a running rowrow server, signed in: what an agent looks at to
// check its UI work without a person (PRINCIPLES.md, engineering 4).
//
//   pnpm shot [route] [--profile dev] [--mobile] [--dark] [--click "Button name"] [--wait 800] [--out file.png]
//
// Signs a throwaway browser in with a one-time link from the server (through the CLI's
// credential in <profile>/server.json), opens the route, waits for the app to connect,
// and writes a PNG (default .dev/shots/<route>-<viewport>.png). Prints the path.
import { chromium, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { connect, resolveTarget } from "../src/cli/client.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string" },
    mobile: { type: "boolean" },
    dark: { type: "boolean" },
    wait: { type: "string" },
    click: { type: "string", multiple: true },
    out: { type: "string" },
  },
});
const route = positionals[0] ?? "/";
const target = resolveTarget({ profile: values.profile ?? process.env["ROWROW_PROFILE"] ?? "dev" });
const { client } = connect(target);
const link = await client.devices.pair({ name: "screenshot" });
// The link names the public URL; the server itself is at target.url.
const base = new URL(link.url).origin;

const browser = await chromium.launch();
const context = await browser.newContext({
  ...(values.mobile === true ? devices["iPhone 15"] : { viewport: { width: 1280, height: 800 } }),
  colorScheme: values.dark === true ? "dark" : "light",
});
const page = await context.newPage();
const problems: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning")
    problems.push(`${message.type()}: ${message.text()}`);
});
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
await page.goto(link.url);
await page.goto(new URL(route, base).href);
// (A string: this file is typechecked for Node, where `document` doesn't exist.)
await page.waitForFunction(
  "document.querySelector('[aria-label=\"Connecting to rowrow\"]') === null",
  undefined,
  { timeout: 15_000 },
);
await page.waitForTimeout(Number(values.wait ?? 800));
// Open panels or menus first: each --click presses the button with that accessible name.
for (const name of values.click ?? []) {
  await page.getByRole("button", { name }).first().click();
  await page.waitForTimeout(Number(values.wait ?? 800));
}
const name = route === "/" ? "home" : route.replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "");
const out = path.resolve(
  values.out ??
    `.dev/shots/${name}-${values.mobile === true ? "mobile" : "desktop"}${values.dark === true ? "-dark" : ""}.png`,
);
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, fullPage: false });
await browser.close();
console.log(out);
if (problems.length > 0) console.log(`browser console:\n  ${problems.join("\n  ")}`);
