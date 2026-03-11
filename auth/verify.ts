import type { FastifyInstance } from "fastify";
import { getSessionFromRequest } from "./session.js";
import { getAuthDatabase } from "./adapters/providers.js";

export function registerVerifyRoute(app: FastifyInstance) {
  app.get("/verify", async (request, reply) => {
    const session = await getSessionFromRequest(request);
    if (!session) {
      return reply.status(401).send("Unauthorized");
    }

    const db = getAuthDatabase();
    const user = await db.findUserById(session.sub);
    if (!user) {
      return reply.status(401).send("Unauthorized");
    }

    // Extract host from forwarded headers (Caddy sets these)
    const forwardedHost =
      (request.headers["x-forwarded-host"] as string) ||
      (request.headers.host as string) ||
      "";

    // Check if this is a VM-specific subdomain.
    // Extract the subdomain (everything before the first dot of the base domain).
    // Skip known system subdomains (app, api, auth, admin, ssh).
    const subdomainMatch = forwardedHost.match(/^([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]+)\./);
    if (subdomainMatch) {
      const subdomain = subdomainMatch[1];
      const systemSubdomains = new Set(["app", "api", "auth", "admin", "ssh", "www"]);
      if (!systemSubdomains.has(subdomain)) {
        // Try by id first (vm-xxx), then by name
        let vmId: string | undefined;
        if (subdomain.startsWith("vm-")) {
          vmId = subdomain; // legacy id-based subdomain
        }
        // Always try name lookup (custom names are the primary path)
        const idByName = await db.findVMIdByName(subdomain);
        if (idByName) vmId = idByName;

        if (vmId) {
          const role = await db.checkVMAccess(vmId, user.id);
          if (!role) {
            return reply.status(403).send("No access to this VM");
          }
        }
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
