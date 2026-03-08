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

  async createSession(vmId: string, agentType: AgentType, options?: { model?: string; providerID?: string; modelID?: string; cwd?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }): Promise<AgentSession> {
    const vm = getDatabase().findVMById(vmId);
    if (!vm) throw new Error("VM not found");
    if (vm.status !== "running") throw new Error("VM is not running");

    const sessionId = nanoid();

    // Create the bridge
    let bridge: AgentBridge;
    if (agentType === "codex") {
      bridge = new CodexBridge();
    } else {
      bridge = new OpenCodeBridge(vm.id, vm.opencode_port, vm.opencode_password || "");
    }

    // Insert DB record early
    getDatabase().insertAgentSession({
      id: sessionId,
      vm_id: vmId,
      agent_type: agentType,
      thread_id: null,
      title: null,
      cwd: options?.cwd || null,
      status: "idle",
    });

    // Wire up events
    const active: ActiveSession = { bridge, vmId, pendingText: "" };
    this.activeSessions.set(sessionId, active);

    bridge.onEvent((event: AgentEvent) => {
      this.handleEvent(sessionId, active, event);
    });

    // Start the bridge (spawns process / connects SSE)
    // Codex bridge needs VM IP, OpenCode bridge uses its own HTTP port
    try {
      const startArg = vm.id;
      const threadId = await bridge.start(startArg, options);
      if (threadId) {
        getDatabase().updateAgentSessionThreadId(sessionId, threadId);
      }
    } catch (err: any) {
      getDatabase().updateAgentSessionStatus(sessionId, "error");
      this.activeSessions.delete(sessionId);
      throw new Error(`Failed to start ${agentType}: ${err.message}`);
    }

    return getDatabase().findAgentSession(sessionId)!;
  }

  async sendMessage(sessionId: string, text: string, options?: { agent?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      // Try to reconnect if session exists in DB but bridge is gone
      const session = getDatabase().findAgentSession(sessionId);
      if (!session || session.status === "archived") {
        throw new Error("Session not found or archived");
      }
      throw new Error("Session bridge is not active — create a new session");
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

  destroyAll(): void {
    for (const [id, active] of this.activeSessions) {
      active.bridge.destroy().catch(() => {});
    }
    this.activeSessions.clear();
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

      case "tool.completed":
        getDatabase().insertAgentMessage({
          id: nanoid(),
          session_id: sessionId,
          role: "tool",
          content: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
          metadata: JSON.stringify({ tool: event.tool }),
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
        getDatabase().updateAgentSessionStatus(sessionId, "idle");
        break;
      }

      case "error":
        getDatabase().updateAgentSessionStatus(sessionId, "error");
        break;
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
