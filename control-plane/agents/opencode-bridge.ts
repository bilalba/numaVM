import type { AgentBridge, AgentEvent, AgentType } from "./types.js";

/**
 * OpenCode bridge — HTTP REST + SSE to container's OpenCode server.
 *
 * The OpenCode server runs inside the container on port 5000 (mapped to
 * the host's opencode_port). Auth via HTTP basic auth with the per-env password.
 */
export class OpenCodeBridge implements AgentBridge {
  readonly agentType: AgentType = "opencode";

  private baseUrl = "";
  private authHeader = "";
  private opencodeSessionId: string | null = null;
  private listeners: ((event: AgentEvent) => void)[] = [];
  private abortController: AbortController | null = null;

  constructor(
    private opencodePort: number,
    private opencodePassword: string,
  ) {
    this.baseUrl = `http://localhost:${opencodePort}`;
    this.authHeader = "Basic " + Buffer.from(`opencode:${opencodePassword}`).toString("base64");
  }

  onEvent(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private async httpRequest(method: string, path: string, body?: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`OpenCode API error ${res.status}: ${text}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  async start(envSlug: string, options?: { model?: string }): Promise<string> {
    const result = await this.httpRequest("POST", "/session", {});
    this.opencodeSessionId = result.id || result.sessionId || "";

    // Start SSE event stream
    this.connectSSE();

    return this.opencodeSessionId!;
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.opencodeSessionId) throw new Error("No active session");

    await this.httpRequest("POST", `/session/${this.opencodeSessionId}/message`, {
      parts: [{ type: "text", text }],
    });
  }

  async interrupt(): Promise<void> {
    // OpenCode doesn't have an explicit interrupt endpoint —
    // cancelling the SSE connection and reconnecting is the closest equivalent
    this.abortController?.abort();
    this.connectSSE();
  }

  async destroy(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.opencodeSessionId = null;
  }

  async listSessions(): Promise<any[]> {
    const result = await this.httpRequest("GET", "/session");
    return Array.isArray(result) ? result : result.sessions || [];
  }

  async getSession(sessionId: string): Promise<any> {
    return this.httpRequest("GET", `/session/${sessionId}`);
  }

  private connectSSE(): void {
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Use fetch-based SSE since EventSource doesn't support custom headers
    this.readSSE(signal).catch((err) => {
      if (!signal.aborted) {
        this.emit({ type: "error", message: `SSE error: ${err.message}`, code: "sse_error" });
        // Reconnect after 2s
        setTimeout(() => {
          if (!signal.aborted) this.connectSSE();
        }, 2000);
      }
    });
  }

  private async readSSE(signal: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/event`, {
      headers: { Authorization: this.authHeader },
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`SSE connection failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          eventData += line.slice(5).trim();
        } else if (line === "") {
          // End of event — OpenCode uses data-only SSE (type inside JSON)
          if (eventData) {
            if (!eventType) {
              try {
                const parsed = JSON.parse(eventData);
                eventType = parsed.type || "";
                // OpenCode wraps payload in "properties"
                this.handleSSEEvent(eventType, JSON.stringify(parsed.properties || parsed));
              } catch {
                // ignore parse errors
              }
            } else {
              this.handleSSEEvent(eventType, eventData);
            }
          }
          eventType = "";
          eventData = "";
        }
      }
    }
  }

  private handleSSEEvent(eventType: string, dataStr: string): void {
    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }

    switch (eventType) {
      case "message.part.delta": {
        // Streaming text delta — {delta: "text", field: "text"}
        if (data.field === "text" && data.delta) {
          this.emit({ type: "message.delta", text: data.delta });
        }
        break;
      }

      case "message.part.updated": {
        const partType = data.part?.type || data.type;
        if (partType === "text" && data.part?.text) {
          // Final text part — emit as completed
          this.emit({
            type: "message.completed",
            text: data.part.text,
            role: "assistant",
          });
        } else if (partType === "tool-invocation" || partType === "tool_use") {
          this.emit({
            type: "tool.started",
            tool: data.part?.toolName || data.toolName || "tool",
            input: data.part?.args || data.args || data.input || {},
          });
        } else if (partType === "tool-result" || partType === "tool_result") {
          this.emit({
            type: "tool.completed",
            tool: data.part?.toolName || data.toolName || "tool",
            result: data.part?.result || data.result || "",
          });
        }
        break;
      }

      case "message.updated": {
        const info = data.info || data;
        // Emit model info when we see it
        if (info.modelID || info.providerID) {
          this.emit({
            type: "session.info",
            model: info.modelID,
            provider: info.providerID,
          });
        }
        break;
      }

      case "session.status": {
        const status = data.status?.type || data.status;
        if (status === "idle") {
          this.emit({ type: "turn.completed", turnId: "", status: "completed" });
        } else if (status === "busy" || status === "running") {
          this.emit({ type: "turn.started", turnId: "" });
        }
        break;
      }

      case "session.updated":
        // Session metadata update — ignore for now
        break;

      case "permission.asked":
        this.emit({
          type: "approval.requested",
          id: data.id || data.permissionId || "",
          action: data.action || data.tool || "permission",
          detail: data,
        });
        break;

      case "error":
        this.emit({
          type: "error",
          message: data.message || data.error || "Unknown OpenCode error",
          code: data.code,
        });
        break;
    }
  }
}
