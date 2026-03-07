import type { WebSocket } from "ws";
import { spawnPtyOverVsock } from "../services/vsock-ssh.js";
import type { IPty } from "node-pty";

interface TerminalSession {
  pty: IPty;
  ws: WebSocket;
  vmId: string;
}

const sessions = new Map<string, TerminalSession>();
let sessionCounter = 0;

export interface CreateTerminalParams {
  vmIp: string;
  ws: WebSocket;
  vmId: string;
  cols?: number;
  rows?: number;
  sessionName?: string;
}

export function createTerminal(params: CreateTerminalParams): string {
  const { vmIp, ws, vmId, cols = 80, rows = 24, sessionName = "main" } = params;
  const sessionId = `term-${++sessionCounter}`;

  const remoteCmd = `tmux new-session -A -s ${sessionName} -x ${cols} -y ${rows}`;
  const shell = spawnPtyOverVsock(vmIp, remoteCmd, cols, rows);

  // PTY output -> WebSocket (raw text)
  shell.onData((data: string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  // PTY exit -> close WebSocket
  shell.onExit(({ exitCode }) => {
    sessions.delete(sessionId);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, `Process exited with code ${exitCode}`);
    }
  });

  // WebSocket messages -> PTY
  ws.on("message", (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.type === "input" && typeof msg.data === "string") {
        shell.write(msg.data);
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        shell.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
      }
    } catch {
      // Not valid JSON — treat as raw input
      shell.write(typeof raw === "string" ? raw : raw.toString());
    }
  });

  // WebSocket close -> kill PTY (tmux session persists inside VM)
  ws.on("close", () => {
    const session = sessions.get(sessionId);
    if (session) {
      session.pty.kill();
      sessions.delete(sessionId);
    }
  });

  sessions.set(sessionId, { pty: shell, ws, vmId });
  return sessionId;
}

export function destroyAllTerminals(): void {
  for (const [id, session] of sessions) {
    try {
      session.pty.kill();
    } catch {
      /* ignore */
    }
    try {
      session.ws.close(1001, "Server shutting down");
    } catch {
      /* ignore */
    }
    sessions.delete(id);
  }
}

export function getActiveTerminalCount(): number {
  return sessions.size;
}
