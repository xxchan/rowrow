// Who is looking at what (docs/architecture.md, "Attention and notifications"). Each live
// connection reports its route, the agent it shows, and whether the page is visible and
// focused: a browser's WebSocket, or the iOS app's state.watch stream over HTTP (named by
// the app, D-026). Used to hold back notifications for what you're already looking at, and
// shown in `rowrow status`.

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

  open(id: string, deviceId: string, deviceName: string): ConnectionPresence {
    const connection: ConnectionPresence = {
      id,
      deviceId,
      deviceName,
      since: Date.now(),
      route: null,
      agentId: null,
      visible: false,
      focused: false,
    };
    this.connections.set(id, connection);
    return connection;
  }

  update(
    id: string,
    update: { route: string; agentId: string | null; visible: boolean; focused: boolean },
  ): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    Object.assign(connection, update);
  }

  /** Forget a connection; with `only`, just if it is still that one (a stream that ended late). */
  close(id: string, only?: ConnectionPresence): void {
    if (only === undefined || this.connections.get(id) === only) this.connections.delete(id);
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
