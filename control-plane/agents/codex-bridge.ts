import { type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { AgentBridge, AgentEvent, AgentType } from "./types.js";
import { spawnProcessOverVsock } from "../services/vsock-ssh.js";

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

  async start(vmIp: string | number, options?: { model?: string }): Promise<string> {
    // Accept VM IP string (e.g. "172.16.0.3")
    const ip = typeof vmIp === "number" ? String(vmIp) : vmIp;
    if (!ip) {
      throw new Error("CodexBridge.start requires a VM IP address (string)");
    }

    const vsock = spawnProcessOverVsock(ip, "codex app-server");
    this.proc = vsock.process;
    this.procStdin = vsock.stdin;

    this.rl = createInterface({ input: vsock.stdout as NodeJS.ReadableStream });
    this.rl.on("line", (line) => this.handleLine(line));

    (vsock.stderr as NodeJS.ReadableStream).on("data", (data: Buffer) => {
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
        name: "deploymagi",
        title: "DeployMagi",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    // Send initialized notification
    this.rpcNotify("initialized", {});

    // Create a thread — pass model if specified, otherwise let server pick default
    const threadParams: Record<string, unknown> = {};
    if (options?.model) {
      threadParams.model = options.model;
    }
    const threadResult = await this.rpcCall("thread/start", threadParams);

    this.threadId = threadResult?.thread?.id || null;
    return this.threadId || "";
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.threadId) throw new Error("No active thread");

    // turn/start is a request — sends user input and streams events back
    this.rpcCall("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      approvalPolicy: "on-request",
    }).catch((err) => {
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

  respondToApproval(approvalId: string, decision: "accept" | "always" | "decline"): void {
    // Approval responses are sent as JSON-RPC responses to the server's request
    // The approvalId is the JSON-RPC request id from the server
    // Codex doesn't support "always" — treat it as "accept"
    const result = decision === "decline" ? "decline" : "accept";
    const msg = JSON.stringify({ jsonrpc: "2.0", id: approvalId, result });
    this.procStdin?.write(msg + "\n");
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
        // Could show reasoning if desired
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
