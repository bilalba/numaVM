import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBridge, AgentEvent, AgentType, ApprovalDecision } from "./types.js";
import { getVMEngine } from "../adapters/providers.js";

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
  // Track tool part IDs that already emitted tool.started (avoid pending→running duplicates)
  private startedToolParts = new Set<string>();
  private selectedModel: { providerID: string; modelID: string } | null = null;

  private cwd: string | undefined;

  constructor(
    private vmId: string,
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

  /** Build URL with ?directory= query param if cwd is set */
  private urlWithDir(path: string): string {
    if (this.cwd) {
      const sep = path.includes("?") ? "&" : "?";
      return `${this.baseUrl}${path}${sep}directory=${encodeURIComponent(this.cwd)}`;
    }
    return `${this.baseUrl}${path}`;
  }

  /**
   * Ensure the OpenCode server is running inside the VM.
   * Checks via HTTP, starts via SSH if not running, polls until ready.
   */
  async ensureRunning(onProgress?: (step: string, message: string) => void): Promise<void> {
    // Fast path: already running and responding
    let isRunning = false;
    try {
      await this.httpRequest("GET", "/session");
      isRunning = true;
    } catch {
      // Not responding — need to check/start
    }

    if (isRunning) {
      return;
    }

    // Check if process exists but not yet ready
    let processRunning = false;
    try {
      const out = await getVMEngine().exec(this.vmId, ["pgrep", "-f", "opencode serve"], { timeoutMs: 5000 });
      processRunning = !!out.trim();
    } catch {
      // Not running
    }

    if (!processRunning) {
      onProgress?.("starting", "Starting OpenCode server...");

      // Verify opencode is installed
      try {
        const which = await getVMEngine().exec(this.vmId, ["which", "opencode"], { timeoutMs: 5000 });
        if (!which.trim()) throw new Error("not found");
      } catch {
        throw new Error(
          "OpenCode is not installed in this VM. Rebuild the rootfs or create a new VM.",
        );
      }

      // Start OpenCode server (SSH connects as dev by default)
      // Source ~/.env to pick up API keys and NUMAVM_WORK_DIR
      // disown prevents bash from sending SIGHUP when SSH session ends
      await getVMEngine().exec(
        this.vmId,
        [
          "bash", "-c",
          `source ~/.env 2>/dev/null; cd "\${NUMAVM_WORK_DIR:-$HOME}" 2>/dev/null || cd ~; OPENCODE_SERVER_PASSWORD='${this.opencodePassword}' nohup opencode serve --port 5000 --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 & disown`,
        ],
        { timeoutMs: 5000 },
      );
    }

    onProgress?.("polling", "Waiting for server to be ready...");

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
            const out = await getVMEngine().exec(this.vmId, ["pgrep", "-f", "opencode serve"], { timeoutMs: 3000 });
            if (!out.trim()) {
              let log = "";
              try {
                log = await getVMEngine().exec(this.vmId, ["tail", "-20", "/tmp/opencode.log"], { timeoutMs: 3000 });
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

  /** Write AGENTS.md into the project directory if it doesn't already exist */
  async writeAgentsMd(cwd?: string, vmName?: string): Promise<void> {
    if (!cwd) return;
    try {
      // Read the base template from the repo's vm/ directory
      const controlPlaneDir = dirname(dirname(fileURLToPath(import.meta.url)));
      const basePath = join(controlPlaneDir, "..", "vm", "BASE_AGENTS.md");
      let content = readFileSync(basePath, "utf-8");

      // Inject the VM's public URL
      if (vmName) {
        content = content.replace("{{VM_NAME}}", vmName);
      }

      // Write to the VM via SSH exec (only if it doesn't already exist)
      const escaped = content.replace(/'/g, "'\\''");
      await getVMEngine().exec(
        this.vmId,
        ["bash", "-c", `[ -f '${cwd}/AGENTS.md' ] || cat > '${cwd}/AGENTS.md' << 'AGENTSEOF'\n${escaped}\nAGENTSEOF`],
        { timeoutMs: 5000 },
      );
    } catch {
      // Non-fatal — agent will work without it
    }
  }

  private async httpRequest(method: string, path: string, body?: any): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: this.authHeader,
    };
    const url = this.urlWithDir(path);
    const res = await fetch(url, {
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

  async start(vmSlug: string, options?: { model?: string; cwd?: string; providerID?: string; modelID?: string; onProgress?: (step: string, message: string) => void }): Promise<string> {
    this.cwd = options?.cwd;
    const onProgress = options?.onProgress;

    // Ensure server is running before creating a session
    await this.ensureRunning(onProgress);

    // Store model selection for use in sendMessage
    if (options?.providerID && options?.modelID) {
      this.selectedModel = { providerID: options.providerID, modelID: options.modelID };
    }

    onProgress?.("creating_session", "Creating session...");
    const result = await this.httpRequest("POST", "/session", {});
    this.opencodeSessionId = result.id || "";

    // Start SSE event stream
    onProgress?.("connecting_sse", "Connecting to event stream...");
    this.connectSSE();

    return this.opencodeSessionId!;
  }

  /** Reconnect to an existing OpenCode session (e.g. after control plane restart) */
  async reconnect(existingSessionId: string, options?: { cwd?: string }): Promise<void> {
    this.cwd = options?.cwd || undefined;
    await this.ensureRunning();

    // Verify the session still exists in OpenCode
    try {
      await this.httpRequest("GET", `/session/${existingSessionId}`);
    } catch {
      throw new Error("OpenCode session no longer exists");
    }

    this.opencodeSessionId = existingSessionId;
    this.connectSSE();
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
    return Array.isArray(result) ? result : [];
  }

  async getSession(sessionId: string): Promise<any> {
    return this.httpRequest("GET", `/session/${sessionId}`);
  }

  /**
   * Respond to a permission/approval request.
   * OpenCode uses: "once" (allow this time), "always" (allow permanently), "reject" (deny).
   */
  async respondToApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const reply = decision === "always" ? "always" : decision === "accept" ? "once" : "reject";
    await this.httpRequest(
      "POST",
      `/permission/${approvalId}/reply`,
      { reply },
    );
  }

  async respondToQuestion(questionId: string, answers: string[][]): Promise<void> {
    await this.httpRequest(
      "POST",
      `/question/${questionId}/reply`,
      { answers },
    );
  }

  async rejectQuestion(questionId: string): Promise<void> {
    await this.httpRequest("POST", `/question/${questionId}/reject`);
  }

  async listPendingPermissions(): Promise<any[]> {
    const result = await this.httpRequest("GET", "/permission");
    const items = Array.isArray(result) ? result : [];
    // Filter to this session's permissions only
    if (this.opencodeSessionId) {
      return items.filter((p: any) => p.sessionID === this.opencodeSessionId);
    }
    return items;
  }

  async listPendingQuestions(): Promise<any[]> {
    const result = await this.httpRequest("GET", "/question");
    const items = Array.isArray(result) ? result : [];
    if (this.opencodeSessionId) {
      return items.filter((q: any) => q.sessionID === this.opencodeSessionId);
    }
    return items;
  }

  async getTodos(): Promise<{ id: string; content: string; status: string; priority: string }[]> {
    if (!this.opencodeSessionId) return [];
    try {
      const result = await this.httpRequest("GET", `/session/${this.opencodeSessionId}/todo`);
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
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
    const sseUrl = this.urlWithDir("/event");
    const res = await fetch(sseUrl, {
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
          // End of event
          if (eventData) {
            try {
              const parsed = JSON.parse(eventData);
              // Always unwrap: type from parsed.type (or event: line), payload from parsed.properties
              const type = eventType || parsed.type || "";
              const payload = parsed.properties || parsed;
              this.handleSSEEvent(type, payload);
            } catch {
              // ignore parse errors
            }
          }
          eventType = "";
          eventData = "";
        }
      }
    }
  }

  /**
   * Extract sessionID from an SSE event payload.
   * Different event types nest sessionID in different places.
   */
  private extractSessionID(eventType: string, data: any): string | undefined {
    // message.part.updated / message.part.delta: sessionID on part
    if (eventType.startsWith("message.part.")) {
      const part = data.part || data;
      return part.sessionID;
    }
    // message.updated / message.removed: sessionID on info (Message)
    if (eventType.startsWith("message.")) {
      const info = data.info || data;
      return info.sessionID;
    }
    // session.*, permission.*, question.*: sessionID directly on properties
    return data.sessionID;
  }

  private handleSSEEvent(eventType: string, data: any): void {
    // Ignore heartbeats and connection events
    if (eventType === "server.heartbeat" || eventType === "server.connected") {
      return;
    }

    // Filter out events that belong to a different OpenCode session.
    // The /event SSE endpoint is global — it broadcasts events for ALL sessions.
    const eventSessionID = this.extractSessionID(eventType, data);
    if (eventSessionID && this.opencodeSessionId && eventSessionID !== this.opencodeSessionId) {
      return;
    }

    switch (eventType) {
      case "message.part.updated": {
        const part = data.part || data;
        const partType = part.type;
        const delta: string | undefined = data.delta;

        // Skip updates for user messages
        const msgRole = this.messageRoles.get(part.messageID);
        if (msgRole === "user") break;

        // Handle streaming deltas (delivered via message.part.updated with optional delta field)
        if (delta) {
          if (partType === "reasoning" || this.reasoningParts.has(part.id)) {
            this.reasoningParts.add(part.id);
            this.emit({ type: "reasoning.delta", text: delta });
          } else if (partType === "text") {
            this.emit({ type: "message.delta", text: delta });
          }
          // Don't process final state when we just got a delta
          break;
        }

        // Handle completed/finalized parts (no delta — this is the final state)
        if (partType === "reasoning") {
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
        } else if (partType === "tool") {
          // OpenCode ToolPart: type "tool" with state.status (pending/running/completed/error)
          const state = part.state || {};
          const toolName = part.tool || "tool";
          const partId = part.id || part.callID || "";
          if (state.status === "completed") {
            this.startedToolParts.delete(partId);
            this.emit({
              type: "tool.completed",
              tool: toolName,
              partId,
              input: state.input || {},
              result: state.output || "",
            });
          } else if (state.status === "error") {
            this.startedToolParts.delete(partId);
            this.emit({
              type: "tool.completed",
              tool: toolName,
              partId,
              input: state.input || {},
              result: state.error || "Tool error",
            });
          } else {
            // pending or running — only emit tool.started once per part
            if (!this.startedToolParts.has(partId)) {
              this.startedToolParts.add(partId);
              this.emit({
                type: "tool.started",
                tool: state.title || toolName,
                partId,
                input: state.input || {},
              });
            }
          }
        } else if (partType === "step-finish") {
          // Emit cost/token info from step completion
          if (part.tokens || part.cost != null) {
            this.emit({
              type: "session.info",
              model: undefined,
              provider: undefined,
            });
          }
        }
        // Ignore: step-start, subtask, file, snapshot, patch, agent, retry, compaction
        break;
      }

      // Legacy: some OpenCode versions send message.part.delta as a separate event
      case "message.part.delta": {
        if (data.field === "text" && data.delta) {
          const msgRole = this.messageRoles.get(data.messageID);
          if (msgRole === "user") break;

          if (this.reasoningParts.has(data.partID)) {
            this.emit({ type: "reasoning.delta", text: data.delta });
          } else {
            this.emit({ type: "message.delta", text: data.delta });
          }
        }
        break;
      }

      case "message.updated": {
        const info = data.info || data;
        // Track message role for filtering user echoes
        if (info.id && info.role) {
          this.messageRoles.set(info.id, info.role);
        }
        // Emit model info — flat fields on AssistantMessage, nested on UserMessage
        const modelID = info.modelID || info.model?.modelID;
        const providerID = info.providerID || info.model?.providerID;
        if (modelID || providerID) {
          this.emit({
            type: "session.info",
            model: modelID,
            provider: providerID,
          });
        }
        break;
      }

      case "session.status": {
        const status = data.status?.type || data.status;
        if (status === "idle") {
          this.emit({ type: "turn.completed", turnId: "", status: "completed" });
        } else if (status === "busy") {
          this.emit({ type: "turn.started", turnId: "" });
        } else if (status === "retry") {
          // Retry — emit as error so users see it, but don't mark session as failed
          const msg = data.status?.message || data.message || "Retrying...";
          this.emit({ type: "error", message: msg, code: "retry" });
        }
        break;
      }

      case "session.idle":
        this.emit({ type: "turn.completed", turnId: "", status: "completed" });
        break;

      case "session.error": {
        const err = data.error || data;
        const errData = err.data || err;
        this.emit({
          type: "error",
          message: errData.message || err.name || "Unknown OpenCode error",
          code: err.name,
        });
        break;
      }

      case "session.updated":
        // Session metadata update — ignore
        break;

      case "permission.asked":
        this.emit({
          type: "approval.requested",
          id: data.id || "",
          action: data.permission || "permission",
          detail: {
            permission: data.permission,
            patterns: data.patterns,
            metadata: data.metadata,
          },
        });
        break;

      case "question.asked":
        this.emit({
          type: "question.asked",
          id: data.id || "",
          questions: data.questions || [],
        });
        break;

      case "todo.updated":
        this.emit({
          type: "todo.updated",
          items: data.todos || [],
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
