import { type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { AgentBridge, AgentEvent, AgentType, ApprovalDecision, ApprovalPolicy, SandboxPolicy, ReasoningEffort, CodexModel, CodexThread } from "./types.js";
import { getVMEngine } from "../adapters/providers.js";

/**
 * Codex bridge — JSON-RPC 2.0 over stdio via SSH-over-vsock.
 *
 * Protocol docs: https://developers.openai.com/codex/app-server/
 * Transport: newline-delimited JSON (JSONL) over stdio.
 */
export class CodexBridge implements AgentBridge {
  readonly agentType: AgentType = "codex";

  private proc: ChildProcess | null = null;
  private procStdin: NodeJS.WritableStream | null = null;
  private rl: ReadlineInterface | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private threadId: string | null = null;
  private listeners: ((event: AgentEvent) => void)[] = [];

  onEvent(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  async start(vmId: string, options?: { model?: string; cwd?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }): Promise<string> {
    if (!vmId) {
      throw new Error("CodexBridge.start requires a VM ID");
    }

    const cmd = options?.cwd
      ? `cd '${options.cwd}' && codex app-server`
      : "codex app-server";
    const spawned = getVMEngine().spawnProcess(vmId, cmd);
    this.proc = spawned.process;
    this.procStdin = spawned.stdin;

    this.rl = createInterface({ input: spawned.stdout as NodeJS.ReadableStream });
    this.rl.on("line", (line) => this.handleLine(line));

    (spawned.stderr as NodeJS.ReadableStream).on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        this.emit({ type: "error", message: text, code: "codex_stderr" });
      }
    });

    this.proc.on("exit", (code) => {
      this.emit({ type: "error", message: `Codex process exited with code ${code}`, code: "process_exit" });
      this.cleanup();
    });

    // Initialize handshake (required before any other method)
    await this.rpcCall("initialize", {
      clientInfo: {
        name: "numavm",
        title: "NumaVM",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    // Send initialized notification
    this.rpcNotify("initialized", {});

    // Create a thread — pass model + policies if specified
    const threadParams: Record<string, unknown> = {};
    if (options?.model) threadParams.model = options.model;
    if (options?.effort) threadParams.reasoningEffort = options.effort;
    if (options?.approvalPolicy) threadParams.approvalPolicy = options.approvalPolicy;
    if (options?.sandboxPolicy) threadParams.sandboxPolicy = options.sandboxPolicy;
    const threadResult = await this.rpcCall("thread/start", threadParams);

    this.threadId = threadResult?.thread?.id || null;

    // Emit session.info with model from thread/start response
    const threadModel = threadResult?.thread?.model || options?.model;
    if (threadModel) {
      this.emit({ type: "session.info", model: threadModel });
    }

    return this.threadId || "";
  }

  async sendMessage(text: string, options?: { agent?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }): Promise<void> {
    if (!this.threadId) throw new Error("No active thread");

    // turn/start is a request — sends user input and streams events back
    const turnParams: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      approvalPolicy: options?.approvalPolicy || "on-request",
    };
    if (options?.effort) turnParams.reasoningEffort = options.effort;
    if (options?.sandboxPolicy) turnParams.sandboxPolicy = options.sandboxPolicy;

    this.rpcCall("turn/start", turnParams).catch((err) => {
      this.emit({ type: "error", message: err.message, code: "turn_error" });
    });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId) return;
    this.rpcNotify("turn/interrupt", { threadId: this.threadId });
  }

  async destroy(): Promise<void> {
    this.cleanup();
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    // Approval responses are sent as JSON-RPC responses to the server's request
    // The approvalId is the JSON-RPC request id from the server
    // Codex supports "accept", "acceptForSession", and "decline"
    let result: string;
    if (decision === "decline") {
      result = "decline";
    } else if (decision === "acceptForSession") {
      result = "acceptForSession";
    } else {
      // "accept" or "always" → "accept"
      result = "accept";
    }
    const msg = JSON.stringify({ jsonrpc: "2.0", id: approvalId, result });
    this.procStdin?.write(msg + "\n");
  }

  // --- Protocol discovery methods ---

  async listModels(includeHidden = false): Promise<CodexModel[]> {
    const result = await this.rpcCall("model/list", { includeHidden });
    const models = result?.models || [];
    return models.map((m: any) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      isDefault: !!m.isDefault,
      reasoningEffort: m.reasoningEffort,
      inputModalities: m.inputModalities,
      hidden: !!m.hidden,
    }));
  }

  async listThreads(options?: { cursor?: string; limit?: number }): Promise<{ threads: CodexThread[]; nextCursor?: string }> {
    const params: Record<string, unknown> = {};
    if (options?.cursor) params.cursor = options.cursor;
    if (options?.limit) params.limit = options.limit;
    const result = await this.rpcCall("thread/list", params);
    const threads = (result?.threads || []).map((t: any) => ({
      id: t.id,
      title: t.title,
      model: t.model,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
    return { threads, nextCursor: result?.nextCursor };
  }

  // --- Auth methods via app-server JSON-RPC ---

  async readAccount(): Promise<any> {
    return this.rpcCall("account/read", {});
  }

  async loginStart(mode: "chatgpt" | "apikey" | "chatgptAuthTokens", params?: any): Promise<any> {
    return this.rpcCall("account/login/start", { type: mode, ...params });
  }

  async loginCancel(loginId: string): Promise<void> {
    await this.rpcCall("account/login/cancel", { loginId });
  }

  async logout(): Promise<void> {
    await this.rpcCall("account/logout", {});
  }

  async readRateLimits(): Promise<any> {
    return this.rpcCall("account/rateLimits/read", {});
  }

  private cleanup(): void {
    this.rl?.close();
    this.rl = null;
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
    this.procStdin = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error("Bridge destroyed"));
    }
    this.pending.clear();
  }

  private rpcCall(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.procStdin?.write(msg + "\n");

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, 30000);
    });
  }

  private rpcNotify(method: string, params: any): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.procStdin?.write(msg + "\n");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // skip non-JSON lines
    }

    // JSON-RPC response (has id, has result or error, no method)
    if (parsed.id != null && !parsed.method) {
      if (this.pending.has(parsed.id)) {
        const { resolve, reject } = this.pending.get(parsed.id)!;
        this.pending.delete(parsed.id);
        if (parsed.error) {
          reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
        } else {
          resolve(parsed.result);
        }
      }
      return;
    }

    // JSON-RPC server request (has id AND method) — e.g. approval requests
    if (parsed.id != null && parsed.method) {
      this.handleServerRequest(parsed.id, parsed.method, parsed.params);
      return;
    }

    // JSON-RPC notification (has method, no id)
    if (parsed.method) {
      this.mapCodexEvent(parsed.method, parsed.params);
    }
  }

  private handleServerRequest(id: any, method: string, params: any): void {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.emit({
        type: "approval.requested",
        id: String(id), // Use the server request ID for responding
        action: method,
        detail: params,
      });
    } else {
      // Auto-accept unknown server requests
      const msg = JSON.stringify({ jsonrpc: "2.0", id, result: "accept" });
      this.procStdin?.write(msg + "\n");
    }
  }

  private mapCodexEvent(method: string, params: any): void {
    switch (method) {
      case "turn/started":
        this.emit({ type: "turn.started", turnId: params?.turn?.id || "" });
        break;

      case "turn/completed":
        this.emit({
          type: "turn.completed",
          turnId: params?.turn?.id || "",
          status: params?.turn?.status || "completed",
        });
        break;

      case "item/agentMessage/delta":
        this.emit({ type: "message.delta", text: params?.delta || "" });
        break;

      case "item/completed": {
        const item = params?.item;
        if (!item) break;
        if (item.type === "agentMessage") {
          this.emit({
            type: "message.completed",
            text: item.content || item.text || "",
            role: "assistant",
          });
        } else if (item.type === "commandExecution") {
          this.emit({
            type: "tool.completed",
            tool: "shell",
            input: { command: item.command || "" },
            result: { exitCode: item.exitCode, stdout: item.stdout, stderr: item.stderr },
          });
        } else if (item.type === "fileChange") {
          this.emit({
            type: "file.changed",
            path: item.path || item.file || "",
            diff: item.diff || item.content || "",
          });
        }
        break;
      }

      case "item/started": {
        const item = params?.item;
        if (!item) break;
        if (item.type === "commandExecution") {
          this.emit({
            type: "tool.started",
            tool: "shell",
            input: { command: item.command, cwd: item.cwd },
          });
        } else if (item.type === "fileChange") {
          this.emit({
            type: "tool.started",
            tool: "file_edit",
            input: { path: item.path || item.file },
          });
        }
        break;
      }

      case "item/commandExecution/outputDelta":
        this.emit({ type: "tool.output.delta", text: params?.delta || "" });
        break;

      case "item/fileChange/outputDelta":
        this.emit({ type: "tool.output.delta", text: params?.delta || "" });
        break;

      case "turn/plan/updated":
        if (params?.plan?.steps) {
          this.emit({
            type: "plan.updated",
            steps: params.plan.steps.map((s: any) => ({
              text: s.title || s.text || "",
              done: s.status === "completed",
            })),
          });
        }
        break;

      case "item/reasoning/summaryTextDelta":
        this.emit({ type: "reasoning.delta", text: params?.delta || "" });
        break;

      case "account/updated":
        this.emit({
          type: "session.info",
          model: undefined,
          provider: params?.authMode || undefined,
        });
        break;

      case "account/login/completed":
        // Login flow finished — success or error
        this.emit({
          type: "session.info",
          model: undefined,
          provider: params?.error ? undefined : "chatgpt",
        });
        break;

      case "account/rateLimits/updated":
        // Could surface rate limit info if desired
        break;
    }
  }
}
