import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { terminalWsUrl } from "../lib/api";

interface UseTerminalOptions {
  envId: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  session?: string;
}

export function useTerminal({ envId, containerRef, enabled, session }: UseTerminalOptions) {
  const stateRef = useRef<{
    term: Terminal;
    fit: FitAddon;
    ws: WebSocket | null;
    inputDisposable: { dispose: () => void } | null;
    observer: ResizeObserver | null;
    reconnectTimer: ReturnType<typeof setTimeout> | undefined;
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
    };
    stateRef.current = state;

    let disposed = false;
    let retryDelay = 1000;

    function connect() {
      if (disposed) return;

      const url = terminalWsUrl(envId, term.cols, term.rows, session);
      const ws = new WebSocket(url);
      state.ws = ws;

      ws.onopen = () => {
        retryDelay = 1000; // Reset backoff on success
        // Don't clear — tmux will redraw the screen with scrollback
        term.focus();
      };

      ws.onmessage = (event) => {
        term.write(event.data);
      };

      ws.onclose = (event) => {
        if (event.code === 1000 || disposed) return;

        if (event.code === 4005) {
          // VM is waking up — server will auto-restore from snapshot
          term.write("\r\n\x1b[36mEnvironment is waking up...\x1b[0m\r\n");
        } else {
          term.write("\r\n\x1b[33mConnection lost. Reconnecting...\x1b[0m\r\n");
        }

        state.reconnectTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 1.5, 10000); // Backoff up to 10s
      };

      // Single input listener per connection
      state.inputDisposable?.dispose();
      state.inputDisposable = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
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

    connect();

    return () => {
      disposed = true;
      clearTimeout(state.reconnectTimer);
      state.observer?.disconnect();
      state.inputDisposable?.dispose();
      state.ws?.close(1000);
      term.dispose();
      stateRef.current = null;
    };
  }, [envId, enabled, containerRef, session]);
}
