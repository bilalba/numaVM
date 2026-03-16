import { useEffect, useRef, useState, useCallback } from "react";
import { agentWsUrl, api } from "../lib/api";

export interface AgentEvent {
  sessionId?: string;
  type: string;
  text?: string;
  role?: string;
  turnId?: string;
  status?: string;
  tool?: string;
  partId?: string;
  input?: unknown;
  result?: unknown;
  path?: string;
  diff?: string;
  id?: string;
  action?: string;
  detail?: unknown;
  message?: string;
  code?: string;
  steps?: { text: string; done: boolean }[];
  model?: string;
  provider?: string;
  step?: string;
  // file.read
  lineStart?: number;
  lineEnd?: number;
  symbolName?: string;
  // patch.created
  hash?: string;
  files?: string[];
  // subtask.updated
  description?: string;
  agent?: string;
  // agent.updated
  name?: string;
}

/** Token refresh threshold — refresh when less than this many ms remain. */
const TOKEN_REFRESH_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes before expiry

export function useAgentSocket(vmId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tokenRefreshRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const listenersRef = useRef<((event: AgentEvent) => void)[]>([]);

  const retryDelayRef = useRef(1000);

  // Direct node connection state (multi-node)
  const nodeWsUrlRef = useRef<string | null>(null);
  const connectTokenRef = useRef<string | null>(null);
  const connectTokenExpiresRef = useRef<string | null>(null);

  /** Refresh the connect token periodically so reconnections use a valid token. */
  const scheduleTokenRefresh = useCallback(() => {
    if (tokenRefreshRef.current) clearTimeout(tokenRefreshRef.current);
    if (!connectTokenExpiresRef.current || !nodeWsUrlRef.current) return;

    const expiresAt = new Date(connectTokenExpiresRef.current).getTime();
    const refreshIn = Math.max(0, expiresAt - Date.now() - TOKEN_REFRESH_THRESHOLD_MS);

    tokenRefreshRef.current = setTimeout(async () => {
      try {
        const result = await api.refreshConnectToken(vmId);
        connectTokenRef.current = result.connectToken;
        connectTokenExpiresRef.current = result.expiresAt;
        if (result.agentWsUrl) nodeWsUrlRef.current = result.agentWsUrl;
      } catch {
        connectTokenRef.current = null;
        nodeWsUrlRef.current = null;
      }
    }, refreshIn);
  }, [vmId]);

  const connect = useCallback(() => {
    if (!vmId) return;

    let url: string;

    // If we have a direct node connection, use it
    if (nodeWsUrlRef.current && connectTokenRef.current) {
      const base = nodeWsUrlRef.current.replace(/\/+$/, "");
      url = `${base}/vms/${vmId}/agent-ws?token=${encodeURIComponent(connectTokenRef.current)}`;
    } else {
      // Fall back to CP WebSocket (local VMs)
      url = agentWsUrl(vmId);
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      retryDelayRef.current = 1000;
      setConnected(true);

      if (nodeWsUrlRef.current && connectTokenRef.current) {
        scheduleTokenRefresh();
      }
    };

    ws.onmessage = (msg) => {
      try {
        const event: AgentEvent = JSON.parse(msg.data);
        setEvents((prev) => [...prev, event]);
        for (const l of listenersRef.current) l(event);
      } catch {
        // ignore non-JSON
      }
    };

    ws.onclose = (e) => {
      // Ignore close events from stale WS (e.g. after reconnectToNode replaced it)
      if (ws !== wsRef.current) return;

      setConnected(false);
      // Don't reconnect on normal close or access denied
      if (e.code === 1000 || e.code === 4003) return;

      reconnectRef.current = setTimeout(connect, retryDelayRef.current);
      retryDelayRef.current = Math.min(retryDelayRef.current * 1.5, 10000);
    };

    ws.onerror = () => {
      // Don't clear node refs — reconnect should retry the same node, not fall back to CP.
      // Clearing refs here would cause reconnections to hit CP's WS route, which returns
      // 4010 for remote VMs, creating an infinite reconnect loop.
      ws.close();
    };
  }, [vmId, scheduleTokenRefresh]);

  // Cleanup only — no auto-connect on mount.
  // Connection is initiated by the caller via connectToCP() or reconnectToNode().
  useEffect(() => {
    return () => {
      clearTimeout(reconnectRef.current);
      clearTimeout(tokenRefreshRef.current);
      wsRef.current?.close(1000);
    };
  }, []);

  const sendCommand = useCallback((cmd: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(cmd));
    }
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const addListener = useCallback((fn: (event: AgentEvent) => void) => {
    listenersRef.current.push(fn);
    return () => {
      listenersRef.current = listenersRef.current.filter((l) => l !== fn);
    };
  }, []);

  /** Connect to CP WebSocket (for local VMs without node connection info). */
  const connectToCP = useCallback(() => {
    if (wsRef.current) return; // already connected
    connect();
  }, [connect]);

  /** Connect (or reconnect) to a node agent's WS endpoint. */
  const reconnectToNode = useCallback((nodeWsUrl: string, token: string, expiresAt: string) => {
    // Skip if already connected to this node with this token
    if (
      nodeWsUrlRef.current === nodeWsUrl &&
      connectTokenRef.current === token &&
      wsRef.current?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    nodeWsUrlRef.current = nodeWsUrl;
    connectTokenRef.current = token;
    connectTokenExpiresRef.current = expiresAt;

    // Detach old WS so its onclose/onerror handlers become no-ops (stale check)
    const oldWs = wsRef.current;
    wsRef.current = null;
    oldWs?.close(1000, "switching-to-node");
    // Connect immediately with new node info
    connect();
  }, [connect]);

  /** Get current node connection info (for direct HTTP calls). Returns null for local VMs. */
  const getNodeToken = useCallback((): string | null => {
    return connectTokenRef.current;
  }, []);

  /** Get the current node WS URL (for constructing HTTP URL). */
  const getNodeWsUrl = useCallback((): string | null => {
    return nodeWsUrlRef.current;
  }, []);

  return { connected, events, sendCommand, clearEvents, addListener, connectToCP, reconnectToNode, getNodeToken, getNodeWsUrl };
}
