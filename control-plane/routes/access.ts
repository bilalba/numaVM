import type { FastifyInstance } from "fastify";
import { getDatabase, getReverseProxy } from "../adapters/providers.js";

export function registerAccessRoutes(app: FastifyInstance) {
  // Grant or revoke access
  app.post("/vms/:id/access", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { email?: string; role?: string | null };

    if (!body.email || typeof body.email !== "string") {
      return reply.status(400).send({ error: "email is required" });
    }

    const vm = getDatabase().findVMById(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const callerRole = getDatabase().checkAccess(id, request.userId);
    if (callerRole !== "owner") {
      return reply.status(403).send({ error: "Only the owner can manage access" });
    }

    const targetUser = getDatabase().findUserByEmail(body.email);
    if (!targetUser) {
      return reply.status(404).send({ error: "User not found. They must sign up first." });
    }

    // Prevent revoking owner access
    const targetRole = getDatabase().checkAccess(id, targetUser.id);
    if (targetRole === "owner" && (body.role === null || body.role === undefined)) {
      return reply.status(400).send({ error: "Cannot revoke owner access" });
    }

    if (body.role === null || body.role === undefined) {
      getDatabase().revokeAccess(id, targetUser.id);
      return { ok: true, message: `Access revoked for ${body.email}` };
    }

    if (body.role !== "editor" && body.role !== "viewer") {
      return reply.status(400).send({ error: "role must be 'editor' or 'viewer'" });
    }

    getDatabase().grantAccess(id, targetUser.id, body.role);
    return { ok: true, message: `${body.role} access granted to ${body.email}` };
  });

  // Toggle public visibility
  app.post("/vms/:id/public", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { is_public?: boolean };

    if (typeof body.is_public !== "boolean") {
      return reply.status(400).send({ error: "is_public (boolean) is required" });
    }

    const vm = getDatabase().findVMById(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const callerRole = getDatabase().checkAccess(id, request.userId);
    if (callerRole !== "owner") {
      return reply.status(403).send({ error: "Only the owner can change public visibility" });
    }

    getDatabase().updateVMPublic(id, body.is_public);

    // Reload Caddy so the forward_auth directive is added/removed
    try {
      await getReverseProxy().reloadConfig();
    } catch (err: any) {
      console.error(`[access] Failed to reload Caddy after toggling public for ${id}:`, err);
    }

    getDatabase().emitAdminEvent("vm.public_changed", id, request.userId, { is_public: body.is_public });

    return { ok: true, is_public: body.is_public };
  });

  // List users with access
  app.get("/vms/:id/access", async (request, reply) => {
    const { id } = request.params as { id: string };

    const vm = getDatabase().findVMById(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const access = getDatabase().getVMAccess(id);
    return { access };
  });
}
