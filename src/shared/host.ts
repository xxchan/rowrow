// What `rowrow version`, `rowrow service status` and `rowrow service install` print with
// --json: how the Mac app learns about a host, on this Mac or over SSH (D-032). The app runs
// the CLI of the bundle it put on that host, and parses what it says with these schemas, so
// an older or newer CLI that says something else fails loudly instead of being misread.
import { z } from "zod";

export const InstallKind = z.enum(["npm", "pnpm", "npx", "bundle", "checkout"]);
export type InstallKind = z.infer<typeof InstallKind>;

export const Install = z.object({
  kind: InstallKind.describe("bundle: in ROWROW_HOME/versions, put there by the Mac app."),
  root: z.string().describe("The package's directory."),
  version: z.string().nullable(),
});
export type Install = z.infer<typeof Install>;

/** A profile's running server, from its server.json. */
export const RunningServer = z.object({
  url: z.string(),
  publicUrl: z.string(),
  pid: z.number(),
  version: z.string(),
  startedAt: z.number(),
});
export type RunningServer = z.infer<typeof RunningServer>;

export const ServiceStatus = z.object({
  profile: z.string(),
  manager: z.enum(["launchd", "systemd"]).nullable().describe("null: no service manager rowrow knows."),
  installed: z.boolean(),
  file: z.string().nullable(),
  state: z.string().nullable().describe("What the service manager says, in its own words."),
  command: z.array(z.string()).nullable().describe("What the service runs."),
  install: Install.nullable().describe("Whose rowrow the service runs."),
  server: RunningServer.nullable().describe("The server running now, service or not."),
});
export type ServiceStatus = z.infer<typeof ServiceStatus>;

const Working = z.array(z.object({ id: z.string(), title: z.string().nullable() }));

export const InstallOutcome = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.enum(["installed", "unchanged"]), file: z.string(), server: RunningServer }),
  z.object({
    outcome: z.literal("busy"),
    file: z.string(),
    server: RunningServer.nullable(),
    working: Working.describe("Agents mid-turn: a restart now would cut them off."),
  }),
]);
export type InstallOutcome = z.infer<typeof InstallOutcome>;

export const VersionInfo = z.object({
  version: z.string().nullable(),
  node: z.string(),
  platform: z.string(),
  install: z.object({ kind: InstallKind, root: z.string() }),
});
export type VersionInfo = z.infer<typeof VersionInfo>;
