// Who is looking at what (docs/architecture.md, "Attention and notifications"). Each live
// browser connection reports its route, the agent it shows, and whether the page is
// visible and focused. Used to hold back notifications for what you're already looking at,
// and shown in `rowrow status`.

export interface ConnectionPresence {
  readonly id: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly since: number;
  route: string | null;
  agentId: string | null;
  visible: boolean;
  focused: boolean;
}

export class Presence {
  private readonly connections = new Map<string, ConnectionPresence>();

  open(id: string, deviceId: string, deviceName: string): void {
    this.connections.set(id, {
      id,
      deviceId,
      deviceName,
      since: Date.now(),
      route: null,
      agentId: null,
      visible: false,
      focused: false,
    });
  }

  update(
    id: string,
    update: { route: string; agentId: string | null; visible: boolean; focused: boolean },
  ): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    Object.assign(connection, update);
  }

  close(id: string): void {
    this.connections.delete(id);
  }

  /** Someone has this agent on screen, in a focused window. */
  isWatching(agentId: string): boolean {
    for (const c of this.connections.values())
      if (c.agentId === agentId && c.visible && c.focused) return true;
    return false;
  }

  /** Some window of a device is focused: that device doesn't need a push, it will show a toast. */
  deviceActive(deviceId: string): boolean {
    for (const c of this.connections.values())
      if (c.deviceId === deviceId && c.visible && c.focused) return true;
    return false;
  }

  list(): ConnectionPresence[] {
    return [...this.connections.values()];
  }
}
