import { useEffect, useRef, useState, useCallback } from "react";
import { agentWsUrl } from "../lib/api";

export interface AgentEvent {
  sessionId?: string;
  type: string;
  text?: string;
  role?: string;
  turnId?: string;
  status?: string;
  tool?: string;
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
}

export function useAgentSocket(envId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const listenersRef = useRef<((event: AgentEvent) => void)[]>([]);

  const retryDelayRef = useRef(1000);

  const connect = useCallback(() => {
    if (!envId) return;

    const url = agentWsUrl(envId);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      retryDelayRef.current = 1000; // Reset backoff on success
      setConnected(true);
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
      setConnected(false);
      // Don't reconnect on normal close or access denied
      if (e.code === 1000 || e.code === 4003) return;

      reconnectRef.current = setTimeout(connect, retryDelayRef.current);
      retryDelayRef.current = Math.min(retryDelayRef.current * 1.5, 10000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [envId]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close(1000);
    };
  }, [connect]);

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

  return { connected, events, sendCommand, clearEvents, addListener };
}
