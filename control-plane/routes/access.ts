import type { FastifyInstance } from "fastify";
import { getDatabase, getReverseProxy, getPlanRegistry } from "../adapters/providers.js";

export function registerAccessRoutes(app: FastifyInstance) {
  // Grant or revoke access
  app.post("/vms/:id/access", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { email?: string; role?: string | null };

    if (!body.email || typeof body.email !== "string") {
      return reply.status(400).send({ error: "email is required" });
    }

    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const callerRole = getDatabase().checkAccess(vm.id, request.userId);
    if (callerRole !== "owner") {
      return reply.status(403).send({ error: "Only the owner can manage access" });
    }

    const targetUser = getDatabase().findUserByEmail(body.email);
    if (!targetUser) {
      return reply.status(404).send({ error: "User not found. They must sign up first." });
    }

    // Prevent revoking owner access
    const targetRole = getDatabase().checkAccess(vm.id, targetUser.id);
    if (targetRole === "owner" && (body.role === null || body.role === undefined)) {
      return reply.status(400).send({ error: "Cannot revoke owner access" });
    }

    if (body.role === null || body.role === undefined) {
      getDatabase().revokeAccess(vm.id, targetUser.id);
      return { ok: true, message: `Access revoked for ${body.email}` };
    }

    if (body.role !== "editor" && body.role !== "viewer") {
      return reply.status(400).send({ error: "role must be 'editor' or 'viewer'" });
    }

    getDatabase().grantAccess(vm.id, targetUser.id, body.role);
    return { ok: true, message: `${body.role} access granted to ${body.email}` };
  });

  // Toggle public visibility
  app.post("/vms/:id/public", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { is_public?: boolean };

    if (typeof body.is_public !== "boolean") {
      return reply.status(400).send({ error: "is_public (boolean) is required" });
    }

    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const callerRole = getDatabase().checkAccess(vm.id, request.userId);
    if (callerRole !== "owner") {
      return reply.status(403).send({ error: "Only the owner can change public visibility" });
    }

    getDatabase().updateVMPublic(vm.id, body.is_public);

    // Reload Caddy so the forward_auth directive is added/removed
    try {
      await getReverseProxy().reloadConfig();
    } catch (err: any) {
      console.error(`[access] Failed to reload Caddy after toggling public for ${vm.id}:`, err);
    }

    // Update route status (KV, node Caddy) if proxy supports it
    const proxy = getReverseProxy();
    if (proxy.updateRouteStatus) {
      try { await proxy.updateRouteStatus(vm.id, vm.status, body.is_public); } catch { /* best-effort */ }
    }

    getDatabase().emitAdminEvent("vm.public_changed", vm.id, request.userId, { is_public: body.is_public });

    return { ok: true, is_public: body.is_public };
  });

  // Toggle keep-alive (disable auto-snapshot)
  app.post("/vms/:id/keep-alive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { keep_alive?: boolean };

    if (typeof body.keep_alive !== "boolean") {
      return reply.status(400).send({ error: "keep_alive (boolean) is required" });
    }

    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const callerRole = getDatabase().checkAccess(vm.id, request.userId);
    if (callerRole !== "owner") {
      return reply.status(403).send({ error: "Only the owner can toggle keep-alive" });
    }

    // Plan gate: deny on free plan when commercial mode is active
    const registry = getPlanRegistry();
    const userPlan = getDatabase().getUserPlan(request.userId);
    if (body.keep_alive && registry.getTrialConfig() !== null && userPlan.plan === registry.getDefaultPlan()) {
      return reply.status(403).send({ error: "Keep-alive is not available on the free plan. Upgrade to enable it." });
    }

    // RAM cap: keep-alive VMs can use up to 100% of user's total RAM quota
    if (body.keep_alive) {
      const currentKeepAliveRam = getDatabase().getUserKeepAliveRam(request.userId);
      const maxKeepAliveRam = userPlan.max_ram_mib;
      if (currentKeepAliveRam + vm.mem_size_mib > maxKeepAliveRam) {
        return reply.status(400).send({
          error: `Keep-alive RAM limit reached. ${currentKeepAliveRam} / ${maxKeepAliveRam} MiB in use. This VM needs ${vm.mem_size_mib} MiB.`,
        });
      }
    }

    getDatabase().updateVMKeepAlive(vm.id, body.keep_alive);
    getDatabase().emitAdminEvent("vm.keep_alive_changed", vm.id, request.userId, { keep_alive: body.keep_alive });

    return { ok: true, keep_alive: body.keep_alive };
  });

  // List users with access
  app.get("/vms/:id/access", async (request, reply) => {
    const { id } = request.params as { id: string };

    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const access = getDatabase().getVMAccess(vm.id);
    return { access };
  });
}
