import type { FastifyInstance } from "fastify";
import { checkAccess, findAgentSession, findEnvById } from "../db/client.js";
import { agentManager } from "../agents/manager.js";
import { wsHub } from "../agents/ws-hub.js";
import type { AgentCommand, AgentType } from "../agents/types.js";
import { spawnProcessOverVsock } from "../services/vsock-ssh.js";
import { ensureVMRunning } from "../services/wake.js";

const VALID_AGENT_TYPES = new Set(["codex", "opencode"]);

export function registerAgentRoutes(app: FastifyInstance) {
  // POST /envs/:id/agents/:type/sessions — Start new agent session
  app.post("/envs/:id/agents/:type/sessions", async (request, reply) => {
    const { id, type } = request.params as { id: string; type: string };

    if (!VALID_AGENT_TYPES.has(type)) {
      return reply.status(400).send({ error: "Invalid agent type. Must be 'codex' or 'opencode'" });
    }

    const role = checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    // Auto-wake snapshotted VMs before creating agent session
    try {
      await ensureVMRunning(id);
    } catch (err: any) {
      request.log.error({ err, envId: id }, "Failed to wake VM for agent session");
      return reply.status(503).send({ error: "Environment is not available. Please try again." });
    }

    const body = request.body as { model?: string } | undefined;
    const model = body?.model?.trim() || undefined;

    try {
      const session = await agentManager.createSession(id, type as AgentType, model ? { model } : undefined);
      return reply.status(201).send(session);
    } catch (err: any) {
      request.log.error({ err, envId: id, agentType: type }, "Failed to create agent session");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /envs/:id/agents/:type/sessions — List sessions for agent type
  app.get("/envs/:id/agents/:type/sessions", async (request, reply) => {
    const { id, type } = request.params as { id: string; type: string };

    if (!VALID_AGENT_TYPES.has(type)) {
      return reply.status(400).send({ error: "Invalid agent type" });
    }

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this environment" });
    }

    const sessions = agentManager.listSessions(id, type as AgentType);
    return { sessions };
  });

  // GET /envs/:id/sessions/:sid — Get session with message history
  app.get("/envs/:id/sessions/:sid", async (request, reply) => {
    const { id, sid } = request.params as { id: string; sid: string };

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this environment" });
    }

    const result = agentManager.getSessionWithHistory(sid);
    if (!result) {
      return reply.status(404).send({ error: "Session not found" });
    }

    if (result.session.env_id !== id) {
      return reply.status(403).send({ error: "Session does not belong to this environment" });
    }

    return result;
  });

  // POST /envs/:id/sessions/:sid/message — Send message to agent
  app.post("/envs/:id/sessions/:sid/message", async (request, reply) => {
    const { id, sid } = request.params as { id: string; sid: string };
    const body = request.body as { text?: string };

    if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
      return reply.status(400).send({ error: "text is required" });
    }

    const role = checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    const session = findAgentSession(sid);
    if (!session || session.env_id !== id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    // Auto-wake snapshotted VMs before sending message
    try {
      await ensureVMRunning(id);
    } catch (err: any) {
      request.log.error({ err, envId: id }, "Failed to wake VM for agent message");
      return reply.status(503).send({ error: "Environment is not available. Please try again." });
    }

    try {
      await agentManager.sendMessage(sid, body.text.trim());
      return { ok: true };
    } catch (err: any) {
      request.log.error({ err, sessionId: sid }, "Failed to send message");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /envs/:id/sessions/:sid/stop — Interrupt agent
  app.post("/envs/:id/sessions/:sid/stop", async (request, reply) => {
    const { id, sid } = request.params as { id: string; sid: string };

    const role = checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    const session = findAgentSession(sid);
    if (!session || session.env_id !== id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    try {
      await agentManager.interrupt(sid);
      return { ok: true };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // DELETE /envs/:id/sessions/:sid — Archive/delete session
  app.delete("/envs/:id/sessions/:sid", async (request, reply) => {
    const { id, sid } = request.params as { id: string; sid: string };

    const role = checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    const session = findAgentSession(sid);
    if (!session || session.env_id !== id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    await agentManager.archiveSession(sid);
    return { ok: true, message: "Session archived" };
  });

  // POST /envs/:id/sessions/:sid/approval — Respond to approval request
  app.post("/envs/:id/sessions/:sid/approval", async (request, reply) => {
    const { id, sid } = request.params as { id: string; sid: string };
    const body = request.body as { approvalId?: string; decision?: string };

    if (!body.approvalId || !body.decision || !["accept", "decline"].includes(body.decision)) {
      return reply.status(400).send({ error: "approvalId and decision (accept/decline) are required" });
    }

    const role = checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    try {
      await agentManager.respondToApproval(sid, body.approvalId, body.decision as "accept" | "decline");
      return { ok: true };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /envs/:id/codex/auth/status — Check Codex auth via app-server
  // Pass ?refresh=true to destroy and recreate the bridge (use after login to pick up new creds)
  app.get("/envs/:id/codex/auth/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { refresh?: string };
    const role = checkAccess(id, request.userId);
    if (!role) return reply.status(403).send({ error: "No access" });

    try {
      if (query.refresh === "true") {
        await agentManager.destroyAuthBridge(id);
      }
      const bridge = await agentManager.getCodexAuthBridge(id);
      const result = await bridge.readAccount();
      // account/read returns { account: { type, email, planType }, requiresOpenaiAuth }
      const authMode = result?.account?.type || result?.authMode || result?.auth_mode || null;
      return {
        authenticated: !!authMode,
        authMode,
        account: result,
      };
    } catch (err: any) {
      request.log.error({ err, envId: id }, "Failed to read Codex account");
      return { authenticated: false, error: err.message };
    }
  });

  // POST /envs/:id/codex/auth/login — Start login
  app.post("/envs/:id/codex/auth/login", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { mode?: string; apiKey?: string };
    const role = checkAccess(id, request.userId);
    if (!role || role === "viewer") return reply.status(403).send({ error: "Editor or owner access required" });

    try {
      if (body.mode === "apikey" && body.apiKey) {
        // API key login via app-server JSON-RPC
        const bridge = await agentManager.getCodexAuthBridge(id);
        const result = await bridge.loginStart("apikey", { apiKey: body.apiKey });
        return result;
      }

      // ChatGPT login via device code (CLI-based, since app-server OAuth needs localhost redirect)
      const env = findEnvById(id);
      if (!env?.vm_ip) return reply.status(500).send({ error: "VM not available" });

      return new Promise<void>((resolve) => {
        const vsock = spawnProcessOverVsock(env.vm_ip!, "codex login --device-auth");
        const proc = vsock.process;

        let output = "";
        let responded = false;

        (vsock.stdout as NodeJS.ReadableStream).on("data", (data: Buffer) => {
          output += data.toString();
          if (responded) return;

          // Strip ANSI escape sequences before matching
          const clean = output.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
          const urlMatch = clean.match(/(https:\/\/auth\.openai\.com\/[^\s)]+)/);
          const codeMatch = clean.match(/([A-Z0-9]{4,}-[A-Z0-9]{4,})/);

          if (urlMatch && codeMatch) {
            responded = true;
            reply.send({ url: urlMatch[1], code: codeMatch[1] });
            resolve();
          }
        });

        (vsock.stderr as NodeJS.ReadableStream).on("data", (data: Buffer) => { output += data.toString(); });

        proc.on("exit", () => {
          // Destroy auth bridge so next status check creates a fresh one with new creds
          agentManager.destroyAuthBridge(id).catch(() => {});
        });

        setTimeout(() => {
          if (!responded) {
            proc.kill();
            responded = true;
            reply.status(500).send({ error: "Timed out waiting for device code" });
            resolve();
          }
        }, 15000);
      });
    } catch (err: any) {
      request.log.error({ err, envId: id }, "Failed to start Codex login");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /envs/:id/codex/auth/logout — Logout via app-server
  app.post("/envs/:id/codex/auth/logout", async (request, reply) => {
    const { id } = request.params as { id: string };
    const role = checkAccess(id, request.userId);
    if (!role || role === "viewer") return reply.status(403).send({ error: "Editor or owner access required" });

    try {
      const bridge = await agentManager.getCodexAuthBridge(id);
      await bridge.logout();
      return { ok: true };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /envs/:id/ws — WebSocket for agent events
  app.get(
    "/envs/:id/ws",
    { websocket: true },
    async (socket, request) => {
      const { id } = request.params as { id: string };

      const role = checkAccess(id, request.userId);
      if (!role) {
        socket.close(4003, "No access to this environment");
        return;
      }

      wsHub.addConnection(id, socket);

      socket.on("message", async (raw: Buffer | string) => {
        try {
          const cmd: AgentCommand = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          await handleCommand(id, request.userId, cmd);
        } catch (err: any) {
          socket.send(JSON.stringify({ type: "error", message: err.message }));
        }
      });

      socket.on("close", () => {
        wsHub.removeConnection(id, socket);
      });
    }
  );
}

async function handleCommand(envId: string, userId: string, cmd: AgentCommand): Promise<void> {
  switch (cmd.type) {
    case "message.send": {
      // Find the active session for this env — or require sessionId
      // For WebSocket commands, we need a way to identify the session.
      // The dashboard should send session.switch first, then message.send.
      // For now, we'll need the dashboard to use REST for messages.
      break;
    }
    case "turn.interrupt": {
      // Similar — need session context
      break;
    }
    case "approval.respond": {
      // Need session context
      break;
    }
    case "session.create": {
      // Could create via WS but REST is simpler
      break;
    }
    case "session.switch": {
      // Client-side state management
      break;
    }
  }
}
