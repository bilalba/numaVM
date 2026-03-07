import type { WebSocket } from "ws";
import type { AgentEvent } from "./types.js";

class WsHub {
  private connections = new Map<string, Set<WebSocket>>();

  addConnection(vmId: string, ws: WebSocket): void {
    let set = this.connections.get(vmId);
    if (!set) {
      set = new Set();
      this.connections.set(vmId, set);
    }
    set.add(ws);
  }

  removeConnection(vmId: string, ws: WebSocket): void {
    const set = this.connections.get(vmId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.connections.delete(vmId);
    }
  }

  broadcast(vmId: string, sessionId: string, event: AgentEvent): void {
    const set = this.connections.get(vmId);
    if (!set) return;
    const payload = JSON.stringify({ sessionId, ...event });
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  getConnectionCount(vmId: string): number {
    return this.connections.get(vmId)?.size ?? 0;
  }
}

export const wsHub = new WsHub();
