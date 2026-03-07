import type { AgentBridge, AgentEvent, AgentType, ApprovalDecision } from "./types.js";
import { execInVM } from "../services/vsock-ssh.js";

/**
 * OpenCode bridge — HTTP REST + SSE to VM's OpenCode server.
 *
 * OpenCode is pre-started at VM boot (init.sh). If not running, falls back to
 * on-demand start via SSH exec.
 * Auth via HTTP basic auth with the per-env password.
 *
 * API reference: https://github.com/anomalyco/opencode
 */
export class OpenCodeBridge implements AgentBridge {
  readonly agentType: AgentType = "opencode";

  private baseUrl = "";
  private authHeader = "";
  private opencodeSessionId: string | null = null;
  private listeners: ((event: AgentEvent) => void)[] = [];
  private abortController: AbortController | null = null;
  // Track message roles by messageID to filter out user message echoes
  private messageRoles = new Map<string, "user" | "assistant">();
  // Track reasoning part IDs to route deltas correctly
  private reasoningParts = new Set<string>();
  private selectedModel: { providerID: string; modelID: string } | null = null;

  private cwd: string | undefined;

  constructor(
    private opencodePort: number,
    private opencodePassword: string,
    private vmIp: string,
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

  /**
   * Ensure the OpenCode server is running inside the VM.
   * Checks via HTTP, starts via SSH if not running, polls until ready.
   * CWD is handled per-request via x-opencode-directory header, not here.
   */
  async ensureRunning(): Promise<void> {
    // Fast path: already running and responding
    let isRunning = false;
    try {
      await this.httpRequest("GET", "/session");
      isRunning = true;
    } catch {
      // Not responding — need to check/start
    }

    // CWD is now handled per-request via the x-opencode-directory header,
    // so we don't need to restart the server when the cwd changes.
    if (isRunning) {
      return;
    }

    // Check if process exists but not yet ready
    let processRunning = false;
    try {
      const out = await execInVM(this.vmIp, ["pgrep", "-f", "opencode serve"], { timeoutMs: 5000 });
      processRunning = !!out.trim();
    } catch {
      // Not running
    }

    if (!processRunning) {
      // Verify opencode is installed
      try {
        const which = await execInVM(this.vmIp, ["which", "opencode"], { timeoutMs: 5000 });
        if (!which.trim()) throw new Error("not found");
      } catch {
        throw new Error(
          "OpenCode is not installed in this VM. Rebuild the rootfs or create a new VM.",
        );
      }

      // Start OpenCode server (SSH connects as dev by default)
      // Source ~/.env to pick up API keys and NUMAVM_WORK_DIR
      // disown prevents bash from sending SIGHUP when SSH session ends
      await execInVM(
        this.vmIp,
        [
          "bash", "-c",
          `source ~/.env 2>/dev/null; cd "\${NUMAVM_WORK_DIR:-$HOME}" 2>/dev/null || cd ~; OPENCODE_SERVER_PASSWORD='${this.opencodePassword}' nohup opencode serve --port 5000 --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 & disown`,
        ],
        { timeoutMs: 5000 },
      );
    }

    // Poll until the server is ready (up to 15s)
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        await this.httpRequest("GET", "/session");
        return;
      } catch {
        // Check if process died during startup
        if (!processRunning) {
          try {
            const out = await execInVM(this.vmIp, ["pgrep", "-f", "opencode serve"], { timeoutMs: 3000 });
            if (!out.trim()) {
              let log = "";
              try {
                log = await execInVM(this.vmIp, ["tail", "-20", "/tmp/opencode.log"], { timeoutMs: 3000 });
              } catch { /* ignore */ }
              throw new Error(`OpenCode process exited during startup${log ? `: ${log.trim()}` : ""}`);
            }
            processRunning = true;
          } catch (e: any) {
            if (e.message.includes("OpenCode process exited")) throw e;
          }
        }
      }
    }

    throw new Error("OpenCode server failed to start within 15s");
  }

  private async httpRequest(method: string, path: string, body?: any): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: this.authHeader,
    };
    // Pass working directory via OpenCode's directory header so sessions
    // operate in the user-chosen cwd instead of the server's startup dir
    if (this.cwd) {
      headers["x-opencode-directory"] = this.cwd;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
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

  async listProviders(): Promise<any> {
    await this.ensureRunning();
    return this.httpRequest("GET", "/provider");
  }

  async start(vmSlug: string, options?: { model?: string; cwd?: string; providerID?: string; modelID?: string }): Promise<string> {
    this.cwd = options?.cwd;

    // Ensure server is running before creating a session
    await this.ensureRunning();

    // Store model selection for use in sendMessage
    if (options?.providerID && options?.modelID) {
      this.selectedModel = { providerID: options.providerID, modelID: options.modelID };
    }

    const result = await this.httpRequest("POST", "/session", {});
    this.opencodeSessionId = result.id || result.sessionId || "";

    // Start SSE event stream
    this.connectSSE();

    return this.opencodeSessionId!;
  }

  async sendMessage(text: string, options?: { agent?: string }): Promise<void> {
    if (!this.opencodeSessionId) throw new Error("No active session");

    const body: any = {
      parts: [{ type: "text", text }],
    };
    if (this.selectedModel) {
      body.model = this.selectedModel;
    }
    if (options?.agent) {
      body.agent = options.agent;
    }

    await this.httpRequest("POST", `/session/${this.opencodeSessionId}/message`, body);
  }

  async interrupt(): Promise<void> {
    if (!this.opencodeSessionId) return;

    // Use the proper abort endpoint instead of just killing SSE
    try {
      await this.httpRequest("POST", `/session/${this.opencodeSessionId}/abort`);
    } catch {
      // Fall back to SSE reconnect if abort fails
      this.abortController?.abort();
      this.connectSSE();
    }
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

  /**
   * Respond to a permission/approval request.
   * OpenCode uses: "once" (allow this time), "always" (allow permanently), "reject" (deny).
   */
  async respondToApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.opencodeSessionId) throw new Error("No active session");

    const response = decision === "always" ? "always" : decision === "accept" ? "once" : "reject";
    await this.httpRequest(
      "POST",
      `/session/${this.opencodeSessionId}/permissions/${approvalId}`,
      { response },
    );
  }

  async revert(messageId?: string): Promise<any> {
    if (!this.opencodeSessionId) throw new Error("No active session");

    // If no messageId provided, find the last user message to revert
    if (!messageId) {
      const messages = await this.httpRequest("GET", `/session/${this.opencodeSessionId}/message`);
      const msgs = Array.isArray(messages) ? messages : [];
      // Find the last user message
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i].info || msgs[i];
        if (msg.role === "user") {
          messageId = msg.id;
          break;
        }
      }
      if (!messageId) throw new Error("No user message found to revert");
    }

    return this.httpRequest("POST", `/session/${this.opencodeSessionId}/revert`, { messageID: messageId });
  }

  async unrevert(): Promise<any> {
    if (!this.opencodeSessionId) throw new Error("No active session");
    return this.httpRequest("POST", `/session/${this.opencodeSessionId}/unrevert`);
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
    const headers: Record<string, string> = { Authorization: this.authHeader };
    if (this.cwd) {
      headers["x-opencode-directory"] = this.cwd;
    }
    const res = await fetch(`${this.baseUrl}/event`, {
      headers,
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
    // Ignore heartbeats and connection events
    if (eventType === "server.heartbeat" || eventType === "server.connected") {
      return;
    }

    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }

    switch (eventType) {
      case "message.part.delta": {
        if (data.field === "text" && data.delta) {
          // Skip deltas for user messages
          const msgRole = this.messageRoles.get(data.messageID);
          if (msgRole === "user") break;

          // Route to reasoning or message delta based on part type
          if (this.reasoningParts.has(data.partID)) {
            this.emit({ type: "reasoning.delta", text: data.delta });
          } else {
            this.emit({ type: "message.delta", text: data.delta });
          }
        }
        break;
      }

      case "message.part.updated": {
        const part = data.part || data;
        const partType = part.type;

        // Skip updates for user messages
        const msgRole = this.messageRoles.get(part.messageID);
        if (msgRole === "user") break;

        if (partType === "reasoning") {
          // Track this part ID as reasoning
          this.reasoningParts.add(part.id);
          if (part.text) {
            this.emit({ type: "reasoning.completed", text: part.text });
          }
        } else if (partType === "text" && part.text) {
          this.emit({
            type: "message.completed",
            text: part.text,
            role: "assistant",
          });
        } else if (partType === "tool-invocation" || partType === "tool_use") {
          this.emit({
            type: "tool.started",
            tool: part.toolName || data.toolName || "tool",
            input: part.args || data.args || data.input || {},
          });
        } else if (partType === "tool-result" || partType === "tool_result") {
          this.emit({
            type: "tool.completed",
            tool: part.toolName || data.toolName || "tool",
            result: part.result || data.result || "",
          });
        }
        break;
      }

      case "message.updated": {
        const info = data.info || data;
        // Track message role for filtering user echoes
        if (info.id && info.role) {
          this.messageRoles.set(info.id, info.role);
        }
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
        // Session metadata update — ignore
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
