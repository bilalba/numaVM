import type { FastifyInstance } from "fastify";
import { getSessionFromRequest } from "./session.js";
import { checkEnvAccess, findUserById } from "./db/client.js";

export function registerVerifyRoute(app: FastifyInstance) {
  app.get("/verify", async (request, reply) => {
    const session = await getSessionFromRequest(request);
    if (!session) {
      return reply.status(401).send("Unauthorized");
    }

    const user = findUserById(session.sub);
    if (!user) {
      return reply.status(401).send("Unauthorized");
    }

    // Extract host from forwarded headers (Caddy sets these)
    const forwardedHost =
      (request.headers["x-forwarded-host"] as string) ||
      (request.headers.host as string) ||
      "";

    // Check if this is an env-specific subdomain (matches env-xxx and env-xxx-pages)
    const envMatch = forwardedHost.match(/^(env-[a-z0-9]+)\./)
    if (envMatch) {
      const envId = envMatch[1];
      const role = checkEnvAccess(envId, user.id);
      if (!role) {
        return reply.status(403).send("No access to this environment");
      }
    }

    // Set headers for downstream services
    reply.header("X-User-Id", user.id);
    reply.header("X-User-Email", user.email);
    if (user.is_admin) {
      reply.header("X-User-Admin", "true");
    }

    return reply.status(200).send("OK");
  });
}
