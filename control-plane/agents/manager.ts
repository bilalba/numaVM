import { nanoid } from "nanoid";
import type { AgentBridge, AgentEvent, AgentType } from "./types.js";
import { CodexBridge } from "./codex-bridge.js";
import { OpenCodeBridge } from "./opencode-bridge.js";
import { wsHub } from "./ws-hub.js";
import {
  findEnvById,
  insertAgentSession,
  findAgentSession,
  findAgentSessionsByEnv,
  updateAgentSessionStatus,
  updateAgentSessionTitle,
  updateAgentSessionThreadId,
  insertAgentMessage,
  findMessagesBySession,
  deleteAgentSession as dbDeleteAgentSession,
  type AgentSession,
  type AgentMessage,
} from "../db/client.js";

interface ActiveSession {
  bridge: AgentBridge;
  envId: string;
  pendingText: string; // accumulates message.delta text for the current assistant turn
}

class AgentManager {
  private activeSessions = new Map<string, ActiveSession>();
  private authBridges = new Map<string, CodexBridge>(); // env slug -> codex bridge for auth

  /** Get or create a Codex bridge for auth operations (separate from session bridges) */
  async getCodexAuthBridge(envId: string): Promise<CodexBridge> {
    const existing = this.authBridges.get(envId);
    if (existing) return existing;

    const env = findEnvById(envId);
    if (!env) throw new Error("Environment not found");
    if (!env.vm_ip) throw new Error("Environment has no VM IP");

    const bridge = new CodexBridge();
    this.authBridges.set(envId, bridge);

    try {
      await bridge.start(env.vm_ip);
    } catch (err: any) {
      this.authBridges.delete(envId);
      throw new Error(`Failed to start Codex auth bridge: ${err.message}`);
    }

    return bridge;
  }

  /** Clean up auth bridge when no longer needed */
  async destroyAuthBridge(envId: string): Promise<void> {
    const bridge = this.authBridges.get(envId);
    if (bridge) {
      await bridge.destroy();
      this.authBridges.delete(envId);
    }
  }

  async createSession(envId: string, agentType: AgentType, options?: { model?: string }): Promise<AgentSession> {
    const env = findEnvById(envId);
    if (!env) throw new Error("Environment not found");
    if (env.status !== "running") throw new Error("Environment is not running");
    if (!env.vm_ip) throw new Error("Environment has no VM IP");

    const sessionId = nanoid();

    // Create the bridge
    let bridge: AgentBridge;
    if (agentType === "codex") {
      bridge = new CodexBridge();
    } else {
      bridge = new OpenCodeBridge(env.opencode_port, env.opencode_password || "");
    }

    // Insert DB record early
    insertAgentSession({
      id: sessionId,
      env_id: envId,
      agent_type: agentType,
      thread_id: null,
      title: null,
      status: "idle",
    });

    // Wire up events
    const active: ActiveSession = { bridge, envId, pendingText: "" };
    this.activeSessions.set(sessionId, active);

    bridge.onEvent((event: AgentEvent) => {
      this.handleEvent(sessionId, active, event);
    });

    // Start the bridge (spawns process / connects SSE)
    // Codex bridge needs VM IP, OpenCode bridge uses its own HTTP port
    try {
      const startArg = agentType === "codex" ? env.vm_ip! : env.id;
      const threadId = await bridge.start(startArg, options);
      if (threadId) {
        updateAgentSessionThreadId(sessionId, threadId);
      }
    } catch (err: any) {
      updateAgentSessionStatus(sessionId, "error");
      this.activeSessions.delete(sessionId);
      throw new Error(`Failed to start ${agentType}: ${err.message}`);
    }

    return findAgentSession(sessionId)!;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      // Try to reconnect if session exists in DB but bridge is gone
      const session = findAgentSession(sessionId);
      if (!session || session.status === "archived") {
        throw new Error("Session not found or archived");
      }
      throw new Error("Session bridge is not active — create a new session");
    }

    // Persist user message
    insertAgentMessage({
      id: nanoid(),
      session_id: sessionId,
      role: "user",
      content: text,
      metadata: null,
    });

    updateAgentSessionStatus(sessionId, "busy");
    active.pendingText = "";

    // Broadcast the user message to connected dashboards
    wsHub.broadcast(active.envId, sessionId, {
      type: "message.completed",
      text,
      role: "system", // using system to distinguish; dashboard will check
    });

    await active.bridge.sendMessage(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error("Session not active");
    await active.bridge.interrupt();
    updateAgentSessionStatus(sessionId, "idle");
  }

  async archiveSession(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (active) {
      await active.bridge.destroy();
      this.activeSessions.delete(sessionId);
    }
    updateAgentSessionStatus(sessionId, "archived");
  }

  async respondToApproval(sessionId: string, approvalId: string, decision: "accept" | "decline"): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error("Session not active");

    const bridge = active.bridge;
    if (bridge instanceof CodexBridge) {
      bridge.respondToApproval(approvalId, decision);
    }
    // OpenCode approval responses would go through HTTP if supported
  }

  listSessions(envId: string, agentType: AgentType): AgentSession[] {
    return findAgentSessionsByEnv(envId, agentType);
  }

  getSessionWithHistory(sessionId: string): { session: AgentSession; messages: AgentMessage[] } | null {
    const session = findAgentSession(sessionId);
    if (!session) return null;
    const messages = findMessagesBySession(sessionId);
    return { session, messages };
  }

  deleteSession(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (active) {
      active.bridge.destroy().catch(() => {});
      this.activeSessions.delete(sessionId);
    }
    dbDeleteAgentSession(sessionId);
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
    wsHub.broadcast(active.envId, sessionId, event);

    // Persist completed messages and update session state
    switch (event.type) {
      case "message.delta":
        active.pendingText += event.text;
        break;

      case "message.completed":
        insertAgentMessage({
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
        insertAgentMessage({
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
          insertAgentMessage({
            id: nanoid(),
            session_id: sessionId,
            role: "assistant",
            content: active.pendingText,
            metadata: null,
          });
          this.maybeSetTitle(sessionId, active.pendingText);
          active.pendingText = "";
        }
        updateAgentSessionStatus(sessionId, "idle");
        break;
      }

      case "error":
        updateAgentSessionStatus(sessionId, "error");
        break;
    }
  }

  private maybeSetTitle(sessionId: string, text: string): void {
    const session = findAgentSession(sessionId);
    if (session && !session.title && text.length > 0) {
      // Use first 80 chars of first assistant message as title
      const title = text.slice(0, 80).replace(/\n/g, " ").trim();
      if (title) updateAgentSessionTitle(sessionId, title);
    }
  }
}

export const agentManager = new AgentManager();
