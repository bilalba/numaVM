import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { terminalWsUrl, api } from "../lib/api";

interface UseTerminalOptions {
  vmId: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  session?: string;
  /** When true, attempt direct node agent connection via connect token. */
  isRemote?: boolean;
}

// Filter mouse escape sequences to prevent flooding when an app exits without
// disabling mouse tracking (e.g., opencode killed mid-session)
const MOUSE_SGR_RE = /\x1b\[<[\d;]+[Mm]/g;
const MOUSE_X10_RE = /\x1b\[M[\s\S]{3}/g;

function stripMouseEvents(data: string): string {
  return data.replace(MOUSE_SGR_RE, "").replace(MOUSE_X10_RE, "");
}

/** Token refresh threshold — refresh when less than this many ms remain. */
const TOKEN_REFRESH_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes before expiry

export function useTerminal({ vmId, containerRef, enabled, session, isRemote }: UseTerminalOptions) {
  const stateRef = useRef<{
    term: Terminal;
    fit: FitAddon;
    ws: WebSocket | null;
    inputDisposable: { dispose: () => void } | null;
    observer: ResizeObserver | null;
    reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    tokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    // Direct node connection state (multi-node)
    nodeTerminalUrl: string | null;
    connectToken: string | null;
    tokenExpires: string | null;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled) return;

    // Create terminal + addons once
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#333",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    fit.fit();

    const state: NonNullable<typeof stateRef.current> = {
      term,
      fit,
      ws: null,
      inputDisposable: null,
      observer: null,
      reconnectTimer: undefined,
      tokenRefreshTimer: undefined,
      nodeTerminalUrl: null,
      connectToken: null,
      tokenExpires: null,
    };
    stateRef.current = state;

    let disposed = false;
    let retryDelay = 1000;

    function scheduleTokenRefresh() {
      if (state.tokenRefreshTimer) clearTimeout(state.tokenRefreshTimer);
      if (!state.tokenExpires || !state.nodeTerminalUrl) return;

      const expiresAt = new Date(state.tokenExpires).getTime();
      const refreshIn = Math.max(0, expiresAt - Date.now() - TOKEN_REFRESH_THRESHOLD_MS);

      state.tokenRefreshTimer = setTimeout(async () => {
        if (disposed) return;
        try {
          const result = await api.getTerminalConnectToken(vmId);
          state.connectToken = result.connectToken;
          state.tokenExpires = result.expiresAt;
          if (result.terminalWsUrl) state.nodeTerminalUrl = result.terminalWsUrl;
          scheduleTokenRefresh();
        } catch {
          // Token refresh failed — clear node refs, will fall back to CP on reconnect
          state.connectToken = null;
          state.nodeTerminalUrl = null;
        }
      }, refreshIn);
    }

    function buildWsUrl(): string {
      // If we have a direct node connection, use it
      if (state.nodeTerminalUrl && state.connectToken) {
        const base = state.nodeTerminalUrl.replace(/\/+$/, "");
        let url = `${base}/vms/${vmId}/terminal?token=${encodeURIComponent(state.connectToken)}&cols=${term.cols}&rows=${term.rows}`;
        if (session) {
          url += `&session=${encodeURIComponent(session)}`;
        }
        return url;
      }
      // Fall back to CP terminal WS
      return terminalWsUrl(vmId, term.cols, term.rows, session);
    }

    function connect() {
      if (disposed) return;

      const url = buildWsUrl();
      const ws = new WebSocket(url);
      state.ws = ws;

      ws.onopen = () => {
        retryDelay = 1000; // Reset backoff on success
        // Clear any stale mouse tracking modes left by a killed process
        term.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
        term.focus();

        // Schedule token refresh if using direct node connection
        if (state.nodeTerminalUrl && state.connectToken) {
          scheduleTokenRefresh();
        }
      };

      ws.onmessage = (event) => {
        term.write(event.data);
      };

      ws.onclose = (event) => {
        if (event.code === 1000 || disposed) return;

        if (event.code === 4005) {
          // VM is waking up — server will auto-restore from snapshot
          term.write("\r\n\x1b[36mVM is waking up...\x1b[0m\r\n");
        } else {
          term.write("\r\n\x1b[33mConnection lost. Reconnecting...\x1b[0m\r\n");
        }

        state.reconnectTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 1.5, 10000); // Backoff up to 10s
      };

      ws.onerror = () => {
        // If direct node connection failed, clear refs to fall back to CP
        if (state.nodeTerminalUrl) {
          state.nodeTerminalUrl = null;
          state.connectToken = null;
        }
      };

      // Single input listener per connection
      state.inputDisposable?.dispose();
      state.inputDisposable = term.onData((data) => {
        const filtered = stripMouseEvents(data);
        if (filtered && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: filtered }));
        }
      });

      // Resize observer
      state.observer?.disconnect();
      const observer = new ResizeObserver(() => {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
          );
        }
      });
      if (el) observer.observe(el);
      state.observer = observer;
    }

    // For remote VMs (multi-node), get a connect token for direct node connection.
    // For local VMs (OSS / single-node), connect directly to CP.
    if (isRemote) {
      api.getTerminalConnectToken(vmId)
        .then((result) => {
          if (disposed) return;
          state.nodeTerminalUrl = result.terminalWsUrl;
          state.connectToken = result.connectToken;
          state.tokenExpires = result.expiresAt;
          connect();
        })
        .catch(() => {
          if (disposed) return;
          connect();
        });
    } else {
      connect();
    }

    return () => {
      disposed = true;
      clearTimeout(state.reconnectTimer);
      clearTimeout(state.tokenRefreshTimer);
      state.observer?.disconnect();
      state.inputDisposable?.dispose();
      state.ws?.close(1000);
      term.dispose();
      stateRef.current = null;
    };
  }, [vmId, enabled, containerRef, session, isRemote]);
}
