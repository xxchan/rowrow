// Coach's credentials (D-044): one per run of a Coach chat, given only to the MCP server that
// run starts, and gone when the run ends. They live in memory (a run doesn't outlive the
// server) and say whose turn a call is for; the router lets them call Coach's reads and
// nothing else, and the reads check that turn's workspaces.
import { createHash, randomBytes } from "node:crypto";

export interface CoachGrant {
  /** The Coach chat (an agent with role coach). */
  readonly chatId: string;
  readonly runId: string;
}

/** Tokens start like this, so they are never mistaken for a device's (rr_…). */
const PREFIX = "rrc_";

export class CoachTokens {
  private readonly grants = new Map<string, CoachGrant>();

  mint(chatId: string, runId: string): string {
    const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
    this.grants.set(hash(token), { chatId, runId });
    return token;
  }

  authenticate(token: string | undefined): CoachGrant | null {
    if (token === undefined || !token.startsWith(PREFIX)) return null;
    return this.grants.get(hash(token)) ?? null;
  }

  /** The run ended: its token stops working. */
  revoke(runId: string): void {
    for (const [key, grant] of this.grants) if (grant.runId === runId) this.grants.delete(key);
  }
}

function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
