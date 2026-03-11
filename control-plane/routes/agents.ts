import type { FastifyInstance } from "fastify";
import { getDatabase } from "../adapters/providers.js";
import { agentManager } from "../agents/manager.js";
import { wsHub } from "../agents/ws-hub.js";
import type { AgentCommand, AgentType, ApprovalDecision, ApprovalPolicy, SandboxPolicy, ReasoningEffort } from "../agents/types.js";
import { OpenCodeBridge } from "../agents/opencode-bridge.js";
import { getVMEngine } from "../adapters/providers.js";
import { ensureVMRunning, QuotaExceededError } from "../services/wake.js";

const VALID_AGENT_TYPES = new Set(["codex", "opencode"]);

/** Resolve a VM identifier (id or name) to the internal VM id. */
function resolveVMId(idOrName: string): string {
  const db = getDatabase();
  const vm = db.findVMById(idOrName);
  if (vm) return vm.id;
  const byName = db.findVMByName(idOrName);
  if (byName) return byName.id;
  return idOrName; // fallback — let checkAccess/ensureVMRunning handle not-found
}

export function registerAgentRoutes(app: FastifyInstance) {
  // POST /vms/:id/agents/:type/sessions — Start new agent session
  app.post("/vms/:id/agents/:type/sessions", async (request, reply) => {
    let { id, type } = request.params as { id: string; type: string };
    id = resolveVMId(id);

    if (!VALID_AGENT_TYPES.has(type)) {
      return reply.status(400).send({ error: "Invalid agent type. Must be 'codex' or 'opencode'" });
    }

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    // Auto-wake snapshotted VMs before creating agent session
    try {
      await ensureVMRunning(id);
    } catch (err: any) {
      if (err instanceof QuotaExceededError) {
        return reply.status(403).send({ error: "RAM quota exceeded. Stop another VM or upgrade your plan.", quota_error: true });
      }
      request.log.error({ err, vmId: id }, "Failed to wake VM for agent session");
      return reply.status(503).send({ error: "VM is not available. Please try again." });
    }

    const body = request.body as { model?: string; providerID?: string; modelID?: string; cwd?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy; prompt?: string } | undefined;
    const model = body?.model?.trim() || undefined;
    const providerID = body?.providerID?.trim() || undefined;
    const modelID = body?.modelID?.trim() || undefined;
    const cwd = body?.cwd?.trim() || undefined;
    const effort = body?.effort || undefined;
    const approvalPolicy = body?.approvalPolicy || undefined;
    const sandboxPolicy = body?.sandboxPolicy || undefined;
    const prompt = body?.prompt?.trim() || undefined;

    try {
      const session = await agentManager.createSession(id, type as AgentType, { model, providerID, modelID, cwd, effort, approvalPolicy, sandboxPolicy, prompt });
      getDatabase().emitAdminEvent("agent.session_created", id, request.userId, { agentType: type, sessionId: session.id });
      return reply.status(201).send(session);
    } catch (err: any) {
      request.log.error({ err, vmId: id, agentType: type }, "Failed to create agent session");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /vms/:id/agents/:type/sessions — List sessions for agent type
  app.get("/vms/:id/agents/:type/sessions", async (request, reply) => {
    let { id, type } = request.params as { id: string; type: string };
    id = resolveVMId(id);

    if (!VALID_AGENT_TYPES.has(type)) {
      return reply.status(400).send({ error: "Invalid agent type" });
    }

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const sessions = agentManager.listSessions(id, type as AgentType);
    return { sessions };
  });

  // GET /vms/:id/sessions/:sid — Get session with message history
  app.get("/vms/:id/sessions/:sid", async (request, reply) => {
    let { id, sid } = request.params as { id: string; sid: string };
    id = resolveVMId(id);

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const result = agentManager.getSessionWithHistory(sid);
    if (!result) {
      return reply.status(404).send({ error: "Session not found" });
    }

    if (result.session.vm_id !== id) {
      return reply.status(403).send({ error: "Session does not belong to this VM" });
    }

    // Fetch pending approvals/questions and todos from OpenCode so the dashboard
    // can restore them when navigating back to a busy session.
    const [pending, todos] = await Promise.all([
      agentManager.getPendingItems(sid),
      agentManager.getTodos(sid),
    ]);

    return { ...result, pendingApprovals: pending.approvals, pendingQuestions: pending.questions, todos };
  });

  // POST /vms/:id/sessions/:sid/message — Send message to agent
  app.post("/vms/:id/sessions/:sid/message", async (request, reply) => {
    let { id, sid } = request.params as { id: string; sid: string };
    id = resolveVMId(id);
    const body = request.body as { text?: string; agent?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy };

    if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
      return reply.status(400).send({ error: "text is required" });
    }
    const agent = body.agent?.trim() || undefined;

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    const session = getDatabase().findAgentSession(sid);
    if (!session || session.vm_id !== id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    // Auto-wake snapshotted VMs before sending message
    try {
      await ensureVMRunning(id);
    } catch (err: any) {
      if (err instanceof QuotaExceededError) {
        return reply.status(403).send({ error: "RAM quota exceeded. Stop another VM or upgrade your plan.", quota_error: true });
      }
      request.log.error({ err, vmId: id }, "Failed to wake VM for agent message");
      return reply.status(503).send({ error: "VM is not available. Please try again." });
    }

    try {
      await agentManager.sendMessage(sid, body.text.trim(), {
        ...(agent ? { agent } : {}),
        ...(body.effort ? { effort: body.effort } : {}),
        ...(body.approvalPolicy ? { approvalPolicy: body.approvalPolicy } : {}),
        ...(body.sandboxPolicy ? { sandboxPolicy: body.sandboxPolicy } : {}),
      });
      return { ok: true };
    } catch (err: any) {
      request.log.error({ err, sessionId: sid }, "Failed to send message");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /vms/:id/sessions/:sid/stop — Interrupt agent
  app.post("/vms/:id/sessions/:sid/stop", async (request, reply) => {
    let { id, sid } = request.params as { id: string; sid: string };
    id = resolveVMId(id);

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    const session = getDatabase().findAgentSession(sid);
    if (!session || session.vm_id !== id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    try {
      await agentManager.interrupt(sid);
      return { ok: true };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // DELETE /vms/:id/sessions/:sid — Archive/delete session
  app.delete("/vms/:id/sessions/:sid", async (request, reply) => {
    let { id, sid } = request.params as { id: string; sid: string };
    id = resolveVMId(id);

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    const session = getDatabase().findAgentSession(sid);
    if (!session || session.vm_id !== id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    await agentManager.archiveSession(sid);
    return { ok: true, message: "Session archived" };
  });

  // POST /vms/:id/sessions/:sid/approval — Respond to approval request
  app.post("/vms/:id/sessions/:sid/approval", async (request, reply) => {
    let { id, sid } = request.params as { id: string; sid: string };
    id = resolveVMId(id);
    const body = request.body as { approvalId?: string; decision?: string };

    const validDecisions = ["accept", "acceptForSession", "always", "decline"];
    if (!body.approvalId || !body.decision || !validDecisions.includes(body.decision)) {
      return reply.status(400).send({ error: "approvalId and decision (accept/acceptForSession/always/decline) are required" });
    }

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    try {
      await agentManager.respondToApproval(sid, body.approvalId, body.decision as ApprovalDecision);
      return { ok: true };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /vms/:id/sessions/:sid/question — Respond to a question from OpenCode
  app.post("/vms/:id/sessions/:sid/question", async (request, reply) => {
    let { id, sid } = request.params as { id: string; sid: string };
    id = resolveVMId(id);
    const body = request.body as { questionId?: string; answers?: string[][]; reject?: boolean };

    if (!body.questionId) {
      return reply.status(400).send({ error: "questionId is required" });
    }

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    try {
      if (body.reject) {
        await agentManager.rejectQuestion(sid, body.questionId);
      } else {
        await agentManager.respondToQuestion(sid, body.questionId, body.answers || []);
      }
      return { ok: true };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /vms/:id/sessions/:sid/revert — Revert file changes from a message (OpenCode only)
  app.post("/vms/:id/sessions/:sid/revert", async (request, reply) => {
    let { id, sid } = request.params as { id: string; sid: string };
    id = resolveVMId(id);
    const body = request.body as { messageId?: string } | undefined;

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    const session = getDatabase().findAgentSession(sid);
    if (!session || session.vm_id !== id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    try {
      const result = await agentManager.revert(sid, body?.messageId);
      return { ok: true, session: result };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /vms/:id/sessions/:sid/unrevert — Restore reverted changes (OpenCode only)
  app.post("/vms/:id/sessions/:sid/unrevert", async (request, reply) => {
    let { id, sid } = request.params as { id: string; sid: string };
    id = resolveVMId(id);

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") {
      return reply.status(403).send({ error: "Editor or owner access required" });
    }

    const session = getDatabase().findAgentSession(sid);
    if (!session || session.vm_id !== id) {
      return reply.status(404).send({ error: "Session not found" });
    }

    try {
      const result = await agentManager.unrevert(sid);
      return { ok: true, session: result };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /vms/:id/opencode/providers — List available providers/models from OpenCode
  app.get("/vms/:id/opencode/providers", async (request, reply) => {
    let { id } = request.params as { id: string };
    id = resolveVMId(id);

    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) return reply.status(404).send({ error: "VM not found" });

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }
    try {
      const bridge = new OpenCodeBridge(vm.id, vm.opencode_port, vm.opencode_password || "");
      const raw = await bridge.listProviders();
      const connectedSet = new Set(raw.connected || []);

      // Only return connected providers' models (these actually work)
      const connected = (raw.all || [])
        .filter((p: any) => connectedSet.has(p.id))
        .map((p: any) => ({
          id: p.id,
          name: p.name,
          models: p.models
            ? Object.values(p.models).map((m: any) => ({ id: m.id, name: m.name }))
            : [],
        }));

      // Popular providers (matching OpenCode's UI) — show unconnected ones as "add" hints
      const POPULAR_IDS = ["opencode-zen", "opencode-go", "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"];
      const popular = POPULAR_IDS
        .filter((pid) => !connectedSet.has(pid))
        .map((pid) => {
          const p = (raw.all || []).find((x: any) => x.id === pid);
          return p ? { id: p.id, name: p.name, env: p.env || [] } : null;
        })
        .filter(Boolean);

      return { connected, popular, default: raw.default || {} };
    } catch (err: any) {
      request.log.error({ err, vmId: id }, "Failed to list OpenCode providers");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /vms/:id/codex/models — List available Codex models via app-server
  app.get("/vms/:id/codex/models", async (request, reply) => {
    let { id } = request.params as { id: string };
    id = resolveVMId(id);
    const query = request.query as { includeHidden?: string };
    const role = getDatabase().checkAccess(id, request.userId);
    if (!role) return reply.status(403).send({ error: "No access" });

    try {
      const models = await agentManager.listCodexModels(id, query.includeHidden === "true");
      return { models };
    } catch (err: any) {
      request.log.error({ err, vmId: id }, "Failed to list Codex models");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /vms/:id/codex/threads — List Codex threads via app-server
  app.get("/vms/:id/codex/threads", async (request, reply) => {
    let { id } = request.params as { id: string };
    id = resolveVMId(id);
    const query = request.query as { cursor?: string; limit?: string };
    const role = getDatabase().checkAccess(id, request.userId);
    if (!role) return reply.status(403).send({ error: "No access" });

    try {
      const limit = query.limit ? parseInt(query.limit, 10) : undefined;
      const result = await agentManager.listCodexThreads(id, { cursor: query.cursor, limit });
      return result;
    } catch (err: any) {
      request.log.error({ err, vmId: id }, "Failed to list Codex threads");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /vms/:id/codex/auth/status — Check Codex auth via app-server
  // Pass ?refresh=true to destroy and recreate the bridge (use after login to pick up new creds)
  app.get("/vms/:id/codex/auth/status", async (request, reply) => {
    let { id } = request.params as { id: string };
    id = resolveVMId(id);
    const query = request.query as { refresh?: string };
    const role = getDatabase().checkAccess(id, request.userId);
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
      request.log.error({ err, vmId: id }, "Failed to read Codex account");
      return { authenticated: false, error: err.message };
    }
  });

  // POST /vms/:id/codex/auth/login — Start login
  app.post("/vms/:id/codex/auth/login", async (request, reply) => {
    let { id } = request.params as { id: string };
    id = resolveVMId(id);
    const body = request.body as { mode?: string; apiKey?: string };
    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") return reply.status(403).send({ error: "Editor or owner access required" });

    try {
      if (body.mode === "apikey" && body.apiKey) {
        // API key login via app-server JSON-RPC
        const bridge = await agentManager.getCodexAuthBridge(id);
        const result = await bridge.loginStart("apikey", { apiKey: body.apiKey });
        return result;
      }

      // ChatGPT login via device code (CLI-based, since app-server OAuth needs localhost redirect)
      const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
      if (!vm) return reply.status(500).send({ error: "VM not available" });

      return new Promise<void>((resolve) => {
        const vsock = getVMEngine().spawnProcess(vm.id, "codex login --device-auth");
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
      request.log.error({ err, vmId: id }, "Failed to start Codex login");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /vms/:id/codex/auth/logout — Logout via app-server
  app.post("/vms/:id/codex/auth/logout", async (request, reply) => {
    let { id } = request.params as { id: string };
    id = resolveVMId(id);
    const role = getDatabase().checkAccess(id, request.userId);
    if (!role || role === "viewer") return reply.status(403).send({ error: "Editor or owner access required" });

    try {
      const bridge = await agentManager.getCodexAuthBridge(id);
      await bridge.logout();
      return { ok: true };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /vms/:id/ws — WebSocket for agent events
  app.get(
    "/vms/:id/ws",
    { websocket: true },
    async (socket, request) => {
      let { id } = request.params as { id: string };
    id = resolveVMId(id);

      const role = getDatabase().checkAccess(id, request.userId);
      if (!role) {
        socket.close(4003, "No access to this VM");
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

async function handleCommand(vmId: string, userId: string, cmd: AgentCommand): Promise<void> {
  switch (cmd.type) {
    case "message.send": {
      break;
    }
    case "turn.interrupt": {
      break;
    }
    case "approval.respond": {
      break;
    }
    case "session.create": {
      break;
    }
    case "session.switch": {
      break;
    }
  }
}
