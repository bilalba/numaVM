import type { WebSocket } from "ws";
import type { AgentEvent } from "./types.js";

class WsHub {
  private connections = new Map<string, Set<WebSocket>>();

  addConnection(envId: string, ws: WebSocket): void {
    let set = this.connections.get(envId);
    if (!set) {
      set = new Set();
      this.connections.set(envId, set);
    }
    set.add(ws);
  }

  removeConnection(envId: string, ws: WebSocket): void {
    const set = this.connections.get(envId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.connections.delete(envId);
    }
  }

  broadcast(envId: string, sessionId: string, event: AgentEvent): void {
    const set = this.connections.get(envId);
    if (!set) return;
    const payload = JSON.stringify({ sessionId, ...event });
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  getConnectionCount(envId: string): number {
    return this.connections.get(envId)?.size ?? 0;
  }
}

export const wsHub = new WsHub();
