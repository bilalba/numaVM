import type { FastifyInstance } from "fastify";
import {
  findEnvById,
  checkAccess,
  grantAccess,
  revokeAccess,
  getEnvAccess,
  findUserByEmail,
} from "../db/client.js";

export function registerAccessRoutes(app: FastifyInstance) {
  // Grant or revoke access
  app.post("/envs/:id/access", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { email?: string; role?: string | null };

    if (!body.email || typeof body.email !== "string") {
      return reply.status(400).send({ error: "email is required" });
    }

    const env = findEnvById(id);
    if (!env) {
      return reply.status(404).send({ error: "Environment not found" });
    }

    const callerRole = checkAccess(id, request.userId);
    if (callerRole !== "owner") {
      return reply.status(403).send({ error: "Only the owner can manage access" });
    }

    const targetUser = findUserByEmail(body.email);
    if (!targetUser) {
      return reply.status(404).send({ error: "User not found. They must sign up first." });
    }

    // Prevent revoking owner access
    const targetRole = checkAccess(id, targetUser.id);
    if (targetRole === "owner" && (body.role === null || body.role === undefined)) {
      return reply.status(400).send({ error: "Cannot revoke owner access" });
    }

    if (body.role === null || body.role === undefined) {
      revokeAccess(id, targetUser.id);
      return { ok: true, message: `Access revoked for ${body.email}` };
    }

    if (body.role !== "editor" && body.role !== "viewer") {
      return reply.status(400).send({ error: "role must be 'editor' or 'viewer'" });
    }

    grantAccess(id, targetUser.id, body.role);
    return { ok: true, message: `${body.role} access granted to ${body.email}` };
  });

  // List users with access
  app.get("/envs/:id/access", async (request, reply) => {
    const { id } = request.params as { id: string };

    const env = findEnvById(id);
    if (!env) {
      return reply.status(404).send({ error: "Environment not found" });
    }

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this environment" });
    }

    const access = getEnvAccess(id);
    return { access };
  });
}
