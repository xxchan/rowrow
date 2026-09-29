// How the CLI reaches a server: --url/--token flags, else ROWROW_URL/ROWROW_TOKEN (set for
// agents that rowrow runs), else the profile's server.json (written by the running server,
// mode 0600). Calls go over HTTP with the typed oRPC client; every call carries a trace id
// so `rowrow logs --trace <id>` finds what it caused.
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { contract } from "../shared/contract.ts";
import { profilePaths, rowrowHome } from "../server/config.ts";
import type { ServerFile } from "../server/main.ts";

export type Client = ContractRouterClient<typeof contract>;

export interface Target {
  readonly url: string;
  readonly token: string;
  readonly agentId?: string;
  readonly source: string;
}

export function resolveTarget(flags: {
  url?: string | undefined;
  token?: string | undefined;
  profile?: string | undefined;
}): Target {
  if (flags.url !== undefined) {
    const token = flags.token ?? process.env["ROWROW_TOKEN"];
    if (token === undefined) throw new Error("--url needs --token (or ROWROW_TOKEN)");
    return { url: flags.url, token, source: "--url" };
  }
  const envUrl = process.env["ROWROW_URL"];
  const envToken = process.env["ROWROW_TOKEN"];
  if (flags.profile === undefined && envUrl !== undefined && envToken !== undefined) {
    const agentId = process.env["ROWROW_AGENT_ID"];
    return {
      url: envUrl,
      token: envToken,
      ...(agentId === undefined ? {} : { agentId }),
      source: "ROWROW_URL",
    };
  }
  const profile = flags.profile ?? process.env["ROWROW_PROFILE"] ?? "default";
  const file = profilePaths(rowrowHome(), profile).serverFile;
  if (!fs.existsSync(file)) {
    throw new Error(
      `no rowrow server is running for profile "${profile}" (no ${file}). Start one with: rowrow serve${profile === "default" ? "" : ` --profile ${profile}`}`,
    );
  }
  const info = JSON.parse(fs.readFileSync(file, "utf8")) as ServerFile;
  if (!processAlive(info.pid))
    throw new Error(
      `${file} names pid ${info.pid}, which is not running; start the server again: rowrow serve`,
    );
  return { url: info.url, token: info.token, source: file };
}

export function connect(target: Target): { client: Client; trace: string } {
  const trace = randomBytes(8).toString("hex");
  const link = new RPCLink({
    url: `${target.url}/rpc`,
    headers: {
      authorization: `Bearer ${target.token}`,
      "x-rowrow-trace": trace,
      ...(target.agentId === undefined ? {} : { "x-rowrow-agent": target.agentId }),
    },
  });
  return { client: createORPCClient<Client>(link), trace };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
