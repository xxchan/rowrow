// `pnpm package:desktop [--identity "Developer ID Application: …" | --unsigned] [--pack] [--inspectable] [--version V]`:
// rowrow.app from this checkout (docs/desktop.md, "Building the app"): the app's code
// (build:desktop) and this Mac's server bundle (build:bundle, in Contents/Resources/server),
// put together by electron-builder, unsigned, then signed by desktop/sign.sh (ad hoc unless you
// name an identity, so it runs here). --pack adds the release's files: the zip the app updates
// from, a disk image, their blockmaps and latest-mac.yml (desktop/pack.sh, desktop-metadata.ts).
// --inspectable leaves Node's inspector on, for tests that drive the packaged app; never ship one.
// --version builds this checkout as another version (testing upgrades and updates). A server
// bundle already in dist/bundles gets this checkout's code (--bundle-as-is: as it is, as CI does
// with the release's bundle).
//
// CI runs the same steps in separate jobs, so the one holding the signing certificate installs
// nothing from npm (.github/workflows/release.yml, D-031).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Arch, build, Platform, type Configuration } from "electron-builder";
import { buildDesktop } from "./build-desktop.ts";
import { writeMetadata } from "./desktop-metadata.ts";

const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version: string;
};
const release = path.join(root, "dist", "desktop-release");

/**
 * What electron-builder makes: Electron and the app as `pnpm build:desktop` built it, nothing
 * else (no node_modules: the main process carries its dependencies). The server bundle goes in
 * afterwards (addServer).
 */
export function builderConfig(options: { inspectable?: boolean } = {}): Configuration {
  const electron = JSON.parse(
    fs.readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8"),
  ) as { version: string };
  return {
    // Changing it breaks updates for everyone on the old id (Squirrel checks the signature's
    // requirement, which names it): only before the first release.
    appId: process.env["MAC_BUNDLE_ID"] ?? "io.github.xxchan.rowrow.mac",
    productName: "rowrow",
    copyright: "Copyright © xxchan",
    electronVersion: electron.version,
    directories: { app: "dist/desktop", output: path.relative(root, release), buildResources: "desktop" },
    asar: true,
    files: ["**/*", "!**/node_modules/**", "!**/*.map"],
    npmRebuild: false,
    nodeGypRebuild: false,
    mac: {
      category: "public.app-category.developer-tools",
      icon: "desktop/icon.png",
      // desktop/sign.sh signs it (so CI signs with Apple's tools alone).
      identity: null,
      hardenedRuntime: true,
      minimumSystemVersion: "12.0",
      extendInfo: { NSUserNotificationAlertStyle: "alert" },
    },
    // The app can't be used to run other code with its signature and your permissions.
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      // On only for tests that drive the packaged app (Playwright attaches Node's inspector).
      enableNodeCliInspectArguments: options.inspectable === true,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
      resetAdHocDarwinSignature: true,
    },
    publish: [{ provider: "github", owner: "xxchan", repo: "rowrow" }],
  };
}

export async function packageApp(
  options: { inspectable?: boolean; version?: string; bundleAsIs?: boolean } = {},
): Promise<string> {
  const as = options.version ?? version;
  const bundle = path.join(root, "dist", "bundles", `rowrow-server-${as}-darwin-arm64`);
  if (!fs.existsSync(path.join(bundle, "bin", "rowrow"))) {
    console.log("package:desktop: building this Mac's server bundle");
    execFileSync(
      process.execPath,
      [path.join(root, "scripts", "build-bundle.ts"), "--target", "darwin-arm64", "--version", as],
      { cwd: root, stdio: "inherit" },
    );
  } else if (options.bundleAsIs !== true) refreshBundle(bundle);
  await buildDesktop(as);
  fs.rmSync(path.join(release, "mac-arm64"), { recursive: true, force: true });
  await build({
    targets: Platform.MAC.createTarget(["dir"], Arch.arm64),
    config: builderConfig(options),
    publish: "never",
  });
  const app = path.join(release, "mac-arm64", "rowrow.app");
  if (!fs.existsSync(app)) throw new Error(`package:desktop: no ${app}`);
  addServer(app, bundle);
  writeUpdateConfig(app);
  return app;
}

/**
 * Contents/Resources/app-update.yml: electron-updater reads it for where it keeps downloads
 * (~/Library/Caches/rowrow-updater) even though the app names its feed in code, and fails every
 * download without it. electron-builder writes it only for targets it publishes, not `dir`.
 */
export function writeUpdateConfig(app: string): void {
  fs.writeFileSync(
    path.join(app, "Contents", "Resources", "app-update.yml"),
    ["owner: xxchan", "repo: rowrow", "provider: github", "updaterCacheDirName: rowrow-updater", ""].join(
      "\n",
    ),
  );
}

/**
 * A bundle built earlier, with this checkout's code: lib/, dist/web and dist/kit built again and
 * put in its place (its Node and dependencies stay; `rm -r dist/bundles` rebuilds everything).
 * Without it, an app packaged again would carry the server as it was when the bundle was made.
 */
function refreshBundle(bundle: string): void {
  console.log(`package:desktop: this checkout's code into ${path.relative(root, bundle)}`);
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  for (const dir of ["lib", "dist/web", "dist/kit"]) {
    fs.rmSync(path.join(bundle, dir), { recursive: true, force: true });
    fs.cpSync(path.join(root, dir), path.join(bundle, dir), {
      recursive: true,
      filter: (source) => !source.endsWith(".map"),
    });
  }
}

/**
 * The server bundle, in Contents/Resources/server: the app installs it from there into
 * ROWROW_HOME/versions and never runs it in place (D-032). Copied as it is (ditto keeps
 * symlinks and modes); electron-builder's own copying leaves out node_modules.
 */
export function addServer(app: string, bundle: string): void {
  const target = path.join(app, "Contents", "Resources", "server");
  fs.rmSync(target, { recursive: true, force: true });
  execFileSync("/usr/bin/ditto", [bundle, target]);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      identity: { type: "string" },
      unsigned: { type: "boolean" },
      pack: { type: "boolean" },
      inspectable: { type: "boolean" },
      version: { type: "string" },
      "bundle-as-is": { type: "boolean" },
    },
  });
  const as = values.version ?? version;
  const app = await packageApp({
    inspectable: values.inspectable === true,
    version: as,
    bundleAsIs: values["bundle-as-is"] === true,
  });
  if (values.unsigned !== true)
    execFileSync(path.join(root, "desktop", "sign.sh"), [app, values.identity ?? "-"], { stdio: "inherit" });
  if (values.pack === true) {
    execFileSync(path.join(root, "desktop", "pack.sh"), [app, as, release], { stdio: "inherit" });
    await writeMetadata(release, as);
  }
  console.log(`package:desktop: ${path.relative(root, app)}`);
}
