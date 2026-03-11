import { nanoid } from "nanoid";
import type { AgentBridge, AgentEvent, AgentType, ApprovalDecision, ApprovalPolicy, SandboxPolicy, ReasoningEffort, CodexModel, CodexThread } from "./types.js";
import { CodexBridge } from "./codex-bridge.js";
import { OpenCodeBridge } from "./opencode-bridge.js";
import { wsHub } from "./ws-hub.js";
import { getDatabase } from "../adapters/providers.js";
import type { AgentSession, AgentMessage } from "../adapters/types.js";

interface ActiveSession {
  bridge: AgentBridge;
  vmId: string;
  pendingText: string; // accumulates message.delta text for the current assistant turn
}

class AgentManager {
  private activeSessions = new Map<string, ActiveSession>();
  private authBridges = new Map<string, CodexBridge>(); // VM slug -> codex bridge for auth

  /** Get or create a Codex bridge for auth operations (separate from session bridges) */
  async getCodexAuthBridge(vmId: string): Promise<CodexBridge> {
    const existing = this.authBridges.get(vmId);
    if (existing) return existing;

    const vm = getDatabase().findVMById(vmId);
    if (!vm) throw new Error("VM not found");
    const bridge = new CodexBridge();
    this.authBridges.set(vmId, bridge);

    try {
      await bridge.start(vm.id);
    } catch (err: any) {
      this.authBridges.delete(vmId);
      throw new Error(`Failed to start Codex auth bridge: ${err.message}`);
    }

    return bridge;
  }

  /** Clean up auth bridge when no longer needed */
  async destroyAuthBridge(vmId: string): Promise<void> {
    const bridge = this.authBridges.get(vmId);
    if (bridge) {
      await bridge.destroy();
      this.authBridges.delete(vmId);
    }
  }

  async listCodexModels(vmId: string, includeHidden = false): Promise<CodexModel[]> {
    const bridge = await this.getCodexAuthBridge(vmId);
    return bridge.listModels(includeHidden);
  }

  async listCodexThreads(vmId: string, options?: { cursor?: string; limit?: number }): Promise<{ threads: CodexThread[]; nextCursor?: string }> {
    const bridge = await this.getCodexAuthBridge(vmId);
    return bridge.listThreads(options);
  }

  async createSession(vmId: string, agentType: AgentType, options?: { model?: string; providerID?: string; modelID?: string; cwd?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy; prompt?: string }): Promise<AgentSession> {
    const vm = getDatabase().findVMById(vmId);
    if (!vm) throw new Error("VM not found");
    if (vm.status !== "running") throw new Error("VM is not running");

    const sessionId = nanoid();
    const prompt = options?.prompt?.trim() || undefined;

    // Create the bridge
    let bridge: AgentBridge;
    if (agentType === "codex") {
      bridge = new CodexBridge();
    } else {
      bridge = new OpenCodeBridge(vm.id, vm.opencode_port, vm.opencode_password || "");
    }

    // Insert DB record — return immediately, background task handles bridge startup
    getDatabase().insertAgentSession({
      id: sessionId,
      vm_id: vmId,
      agent_type: agentType,
      thread_id: null,
      title: null,
      cwd: options?.cwd || null,
      status: prompt ? "busy" : "idle",
    });

    // If prompt provided, persist user message immediately so it's visible in the UI
    // (before bridge starts — avoids the gap where the session exists but has no messages)
    if (prompt) {
      getDatabase().insertAgentMessage({
        id: nanoid(),
        session_id: sessionId,
        role: "user",
        content: prompt,
        metadata: null,
      });
    }

    // Notify connected dashboards that a new session was created
    wsHub.broadcast(vmId, sessionId, {
      type: "session.created",
      sessionId,
      agentType,
      cwd: options?.cwd || null,
      prompt: prompt || null,
    } as any);

    // Wire up events
    const active: ActiveSession = { bridge, vmId, pendingText: "" };
    this.activeSessions.set(sessionId, active);

    bridge.onEvent((event: AgentEvent) => {
      this.handleEvent(sessionId, active, event);
    });

    // Background: start bridge, broadcast progress, send prompt
    const startOptions = {
      ...options,
      onProgress: (step: string, message: string) => {
        wsHub.broadcast(vmId, sessionId, {
          type: "session.progress",
          sessionId,
          step,
          message,
        });
      },
    };

    (async () => {
      try {
        const startArg = vm.id;
        const threadId = await bridge.start(startArg, startOptions);
        if (threadId) {
          getDatabase().updateAgentSessionThreadId(sessionId, threadId);
        }
        getDatabase().updateAgentSessionStatus(sessionId, "idle");
        wsHub.broadcast(vmId, sessionId, {
          type: "session.progress",
          sessionId,
          step: "ready",
          message: "Ready",
        });

        // If a prompt was provided, write AGENTS.md and send it to the agent
        // (user message already persisted above — call bridge directly to avoid duplicate)
        if (prompt) {
          if (bridge instanceof OpenCodeBridge) {
            await (bridge as OpenCodeBridge).writeAgentsMd(options?.cwd, vmId).catch(() => {});
          }
          getDatabase().updateAgentSessionStatus(sessionId, "busy");
          active.pendingText = "";
          wsHub.broadcast(vmId, sessionId, {
            type: "message.completed",
            text: prompt,
            role: "system",
          });
          await bridge.sendMessage(prompt, options);
        }
      } catch (err: any) {
        getDatabase().updateAgentSessionStatus(sessionId, "error");
        wsHub.broadcast(vmId, sessionId, {
          type: "error",
          message: `Failed to start ${agentType}: ${err.message}`,
          code: "init_error",
        });
        this.activeSessions.delete(sessionId);
      }
    })();

    return getDatabase().findAgentSession(sessionId)!;
  }

  async sendMessage(sessionId: string, text: string, options?: { agent?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }): Promise<void> {
    let active = this.activeSessions.get(sessionId);
    if (!active) {
      // Try to reconnect if session exists in DB but bridge is gone (e.g. after control plane restart)
      active = await this.tryReconnect(sessionId);
    }

    // Persist user message
    getDatabase().insertAgentMessage({
      id: nanoid(),
      session_id: sessionId,
      role: "user",
      content: text,
      metadata: null,
    });

    getDatabase().updateAgentSessionStatus(sessionId, "busy");
    active.pendingText = "";

    // Broadcast the user message to connected dashboards
    wsHub.broadcast(active.vmId, sessionId, {
      type: "message.completed",
      text,
      role: "system", // using system to distinguish; dashboard will check
    });

    await active.bridge.sendMessage(text, options);
  }

  async interrupt(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error("Session not active");
    await active.bridge.interrupt();
    getDatabase().updateAgentSessionStatus(sessionId, "idle");
  }

  async archiveSession(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (active) {
      await active.bridge.destroy();
      this.activeSessions.delete(sessionId);
    }
    getDatabase().updateAgentSessionStatus(sessionId, "archived");
  }

  async respondToApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error("Session not active");

    const bridge = active.bridge;
    if (bridge instanceof CodexBridge) {
      bridge.respondToApproval(approvalId, decision);
    } else if (bridge instanceof OpenCodeBridge) {
      await bridge.respondToApproval(approvalId, decision);
    }
  }

  async respondToQuestion(sessionId: string, questionId: string, answers: string[][]): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error("Session not active");
    if (!(active.bridge instanceof OpenCodeBridge)) throw new Error("Questions are only supported for OpenCode");
    await (active.bridge as OpenCodeBridge).respondToQuestion(questionId, answers);
  }

  async rejectQuestion(sessionId: string, questionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error("Session not active");
    if (!(active.bridge instanceof OpenCodeBridge)) throw new Error("Questions are only supported for OpenCode");
    await (active.bridge as OpenCodeBridge).rejectQuestion(questionId);
  }

  async revert(sessionId: string, messageId?: string): Promise<any> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error("Session not active");
    if (!(active.bridge instanceof OpenCodeBridge)) throw new Error("Revert is only supported for OpenCode");
    return (active.bridge as OpenCodeBridge).revert(messageId);
  }

  async unrevert(sessionId: string): Promise<any> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error("Session not active");
    if (!(active.bridge instanceof OpenCodeBridge)) throw new Error("Unrevert is only supported for OpenCode");
    return (active.bridge as OpenCodeBridge).unrevert();
  }

  listSessions(vmId: string, agentType: AgentType): AgentSession[] {
    return getDatabase().findAgentSessionsByVM(vmId, agentType);
  }

  getSessionWithHistory(sessionId: string): { session: AgentSession; messages: AgentMessage[] } | null {
    const session = getDatabase().findAgentSession(sessionId);
    if (!session) return null;
    const messages = getDatabase().findMessagesBySession(sessionId);
    return { session, messages };
  }

  async getTodos(sessionId: string): Promise<{ id: string; content: string; status: string; priority: string }[]> {
    const active = this.activeSessions.get(sessionId);
    if (!active || !(active.bridge instanceof OpenCodeBridge)) return [];
    return (active.bridge as OpenCodeBridge).getTodos();
  }

  async getPendingItems(sessionId: string): Promise<{ approvals: any[]; questions: any[] }> {
    const active = this.activeSessions.get(sessionId);
    if (!active || !(active.bridge instanceof OpenCodeBridge)) {
      return { approvals: [], questions: [] };
    }
    const bridge = active.bridge as OpenCodeBridge;
    try {
      const [permissions, questions] = await Promise.all([
        bridge.listPendingPermissions(),
        bridge.listPendingQuestions(),
      ]);
      const approvals = permissions.map((p: any) => ({
        id: p.id,
        action: p.permission || "permission",
        detail: {
          permission: p.permission,
          patterns: p.patterns,
          metadata: p.metadata,
        },
      }));
      const mappedQuestions = questions.map((q: any) => ({
        id: q.id,
        questions: q.questions || [],
      }));
      return { approvals, questions: mappedQuestions };
    } catch {
      return { approvals: [], questions: [] };
    }
  }

  deleteSession(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (active) {
      active.bridge.destroy().catch(() => {});
      this.activeSessions.delete(sessionId);
    }
    getDatabase().deleteAgentSession(sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /** Cleanly tear down all bridges for a VM (e.g. before snapshot) without marking sessions as error */
  destroyBridgesForVM(vmId: string): void {
    for (const [sessionId, active] of this.activeSessions) {
      if (active.vmId === vmId) {
        active.bridge.destroy().catch(() => {});
        this.activeSessions.delete(sessionId);
      }
    }
    // Also clean up auth bridges
    this.destroyAuthBridge(vmId).catch(() => {});
  }

  destroyAll(): void {
    for (const [id, active] of this.activeSessions) {
      active.bridge.destroy().catch(() => {});
    }
    this.activeSessions.clear();
  }

  /** Attempt to reconnect a bridge for a session that exists in DB but lost its in-memory bridge */
  private async tryReconnect(sessionId: string): Promise<ActiveSession> {
    const session = getDatabase().findAgentSession(sessionId);
    if (!session || session.status === "archived") {
      throw new Error("Session not found or archived");
    }
    if (!session.thread_id) {
      throw new Error("Session bridge is not active — create a new session");
    }

    const vm = getDatabase().findVMById(session.vm_id);
    if (!vm) throw new Error("VM not found");

    if (session.agent_type === "opencode") {
      const bridge = new OpenCodeBridge(vm.id, vm.opencode_port, vm.opencode_password || "");
      const active: ActiveSession = { bridge, vmId: session.vm_id, pendingText: "" };
      this.activeSessions.set(sessionId, active);

      bridge.onEvent((event: AgentEvent) => {
        this.handleEvent(sessionId, active, event);
      });

      await bridge.reconnect(session.thread_id, { cwd: session.cwd || undefined });
      return active;
    }

    throw new Error("Session bridge is not active — create a new session");
  }

  private handleEvent(sessionId: string, active: ActiveSession, event: AgentEvent): void {
    // Broadcast to WebSocket clients
    wsHub.broadcast(active.vmId, sessionId, event);

    // Persist completed messages and update session state
    switch (event.type) {
      case "message.delta":
        active.pendingText += event.text;
        break;

      case "message.completed":
        getDatabase().insertAgentMessage({
          id: nanoid(),
          session_id: sessionId,
          role: event.role,
          content: event.text,
          metadata: null,
        });
        active.pendingText = "";
        // Auto-title from first assistant message
        this.maybeSetTitle(sessionId, event.text);
        break;

      case "reasoning.completed":
        if (event.text) {
          getDatabase().insertAgentMessage({
            id: nanoid(),
            session_id: sessionId,
            role: "reasoning",
            content: event.text,
            metadata: null,
          });
        }
        break;

      case "tool.completed":
        getDatabase().insertAgentMessage({
          id: nanoid(),
          session_id: sessionId,
          role: "tool",
          content: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
          metadata: JSON.stringify({ tool: event.tool, input: event.input }),
        });
        break;

      case "turn.completed": {
        // If we have accumulated delta text without a message.completed, persist it
        if (active.pendingText) {
          getDatabase().insertAgentMessage({
            id: nanoid(),
            session_id: sessionId,
            role: "assistant",
            content: active.pendingText,
            metadata: null,
          });
          this.maybeSetTitle(sessionId, active.pendingText);
          active.pendingText = "";
        }
        // Don't overwrite "error" status — a preceding error event may have already
        // marked this session (e.g. model not supported, API failure).
        const curStatus = getDatabase().findAgentSession(sessionId)?.status;
        if (curStatus !== "error") {
          getDatabase().updateAgentSessionStatus(sessionId, "idle");
        }
        break;
      }

      case "session.info": {
        const model = (event as any).model || null;
        const provider = (event as any).provider || null;
        if (model || provider) {
          // Merge with existing — don't overwrite model with null
          const existing = getDatabase().findAgentSession(sessionId);
          getDatabase().updateAgentSessionModel(
            sessionId,
            model || existing?.model || null,
            provider || existing?.provider || null,
          );
        }
        break;
      }

      case "error": {
        // Skip transient errors that the agent recovers from automatically.
        // "retry" = LLM provider retry (OpenCode keeps working after)
        // "sse_error" = SSE reconnect (bridge auto-reconnects in 2s)
        // "codex_stderr" = app-server stderr output (diagnostic, not fatal)
        const code = (event as any).code;
        if (code === "retry" || code === "sse_error" || code === "codex_stderr") break;

        // Only mark as "error" if actively busy — don't corrupt idle sessions
        // (e.g. VM snapshotted after conversation completed)
        const currentStatus = getDatabase().findAgentSession(sessionId)?.status;
        if (currentStatus === "busy") {
          getDatabase().updateAgentSessionStatus(sessionId, "error");
          // Persist the error message so the user sees why
          const errMsg = (event as any).message;
          if (errMsg) {
            getDatabase().insertAgentMessage({
              id: nanoid(),
              session_id: sessionId,
              role: "assistant",
              content: errMsg,
              metadata: JSON.stringify({ error: true, code }),
            });
          }
        }
        break;
      }
    }
  }

  private maybeSetTitle(sessionId: string, text: string): void {
    const session = getDatabase().findAgentSession(sessionId);
    if (session && !session.title && text.length > 0) {
      // Use first 80 chars of first assistant message as title
      const title = text.slice(0, 80).replace(/\n/g, " ").trim();
      if (title) getDatabase().updateAgentSessionTitle(sessionId, title);
    }
  }
}

export const agentManager = new AgentManager();
