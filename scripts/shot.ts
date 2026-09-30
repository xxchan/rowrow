// Screenshot the real UI of a running rowrow server, signed in: what an agent looks at to
// check its UI work without a person (PRINCIPLES.md, engineering 4).
//
//   pnpm shot [route] [--profile dev] [--mobile] [--dark] [--click "Name"]… [--element "Name"]
//             [--wait 800] [--out file.png]
//
// Signs a throwaway browser in with a one-time link from the server (through the CLI's
// credential in <profile>/server.json), opens the route, waits for the app to connect,
// and writes a PNG (default .dev/shots/<route>-<viewport>.png). Prints the path.
// --element shoots only the dialog, region or other landmark with that accessible name: a
// smaller picture of just what changed.
import { chromium, devices, type Locator, type Page } from "@playwright/test";
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
    element: { type: "string" },
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
type Role = Parameters<Page["getByRole"]>[0];
/** The first visible element with one of `roles` named exactly `name`, else one whose name
 * contains it ("Changes" finds the button named "Changes · 2"). */
async function byName(roles: readonly Role[], name: string): Promise<Locator> {
  const find = (exact: boolean): Locator =>
    roles
      .map((role) => page.getByRole(role, { name, exact }))
      .reduce((all, one) => all.or(one))
      .filter({ visible: true })
      .first();
  return (await find(true).count()) > 0 ? find(true) : find(false);
}
const clickable: Role[] = [
  "button",
  "tab",
  "treeitem",
  "menuitem",
  "link",
  "option",
  "checkbox",
  "switch",
  "radio",
];
const landmarks: Role[] = [
  "dialog",
  "region",
  "tabpanel",
  "navigation",
  "main",
  "complementary",
  "form",
  "tree",
];
// Open panels, menus or folders first: each --click presses what has that accessible name.
for (const name of values.click ?? []) {
  await (await byName(clickable, name)).click();
  await page.waitForTimeout(Number(values.wait ?? 800));
}
const name = route === "/" ? "home" : route.replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "");
const out = path.resolve(
  values.out ??
    `.dev/shots/${name}-${values.mobile === true ? "mobile" : "desktop"}${values.dark === true ? "-dark" : ""}.png`,
);
fs.mkdirSync(path.dirname(out), { recursive: true });
if (values.element === undefined) await page.screenshot({ path: out, fullPage: false });
else await (await byName(landmarks, values.element)).screenshot({ path: out });
await browser.close();
console.log(out);
if (problems.length > 0) console.log(`browser console:\n  ${problems.join("\n  ")}`);
