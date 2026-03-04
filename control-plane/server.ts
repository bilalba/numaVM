import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

let deployVersion: Record<string, string> = {};
try {
  deployVersion = JSON.parse(
    readFileSync(join(__dirname, "..", "version.json"), "utf-8")
  );
} catch {}

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { registerEnvRoutes } from "./routes/envs.js";
import { registerAccessRoutes } from "./routes/access.js";
import { registerTerminalRoutes } from "./routes/terminal.js";
import { registerClaudeRoutes } from "./routes/claude.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerFileRoutes } from "./routes/files.js";
import { destroyAllTerminals } from "./terminal/pty-handler.js";
import { agentManager } from "./agents/manager.js";
import { getHealthStats } from "./services/health.js";
import { destroyAllVMs } from "./services/firecracker.js";
import { startIdleMonitor, stopIdleMonitor } from "./services/idle-monitor.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    userEmail: string;
  }
}

const app = Fastify({ logger: true });

const baseDomain = process.env.BASE_DOMAIN || "localhost";
await app.register(websocket);
await app.register(cors, {
  origin: (origin, cb) => {
    // Allow requests with no origin, from localhost, from the configured domain,
    // or from the same host accessed via IP (dashboard port 4002)
    if (!origin || origin.includes("localhost") || origin.includes(baseDomain)) {
      return cb(null, true);
    }
    // Also allow any origin on port 4002 (dashboard) to handle IP-based access
    try {
      const url = new URL(origin);
      if (url.port === "4002") return cb(null, true);
    } catch {}
    cb(null, false);
  },
  credentials: true,
});

// Extract auth headers set by Caddy forward_auth
app.addHook("preHandler", async (request, reply) => {
  // Skip auth for health check and status pages
  if (request.url === "/health" || request.url.endsWith("/status-page")) return;

  const userId = request.headers["x-user-id"] as string | undefined;
  const userEmail = request.headers["x-user-email"] as string | undefined;

  // Dev mode: fake auth when no Caddy is running
  if (!userId && (baseDomain === "localhost" || process.env.DEV_MODE === "true")) {
    // Ensure dev user exists in shared DB
    const { db } = await import("./db/client.js");
    db.prepare(
      `INSERT OR IGNORE INTO users (id, email, name) VALUES ('dev-user', 'dev@localhost', 'Dev User')`
    ).run();
    request.userId = "dev-user";
    request.userEmail = "dev@localhost";
    return;
  }

  if (!userId || !userEmail) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  request.userId = userId;
  request.userEmail = userEmail;
});

// Health check
app.get("/health", async () => {
  const stats = await getHealthStats();
  return { ...stats, version: deployVersion };
});

// Register route modules
registerEnvRoutes(app);
registerAccessRoutes(app);
registerTerminalRoutes(app);
registerClaudeRoutes(app);
registerAgentRoutes(app);
registerFileRoutes(app);

// Global error handler
app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  request.log.error(error);
  reply.status(error.statusCode || 500).send({
    error: error.message || "Internal Server Error",
  });
});

// Log unhandled rejections (aids debugging background promise failures)
process.on("unhandledRejection", (reason, promise) => {
  console.error("[unhandledRejection]", reason);
});

// Graceful shutdown
const shutdown = async () => {
  stopIdleMonitor();
  agentManager.destroyAll();
  destroyAllTerminals();
  await destroyAllVMs();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start
// Start idle monitor (only on non-localhost deployments)
if (baseDomain !== "localhost") {
  startIdleMonitor();
}

// Load Caddy config on startup (non-fatal — Caddy may not be running yet)
if (baseDomain !== "localhost") {
  import("./services/caddy.js").then(({ reloadCaddyConfig }) => {
    reloadCaddyConfig().catch((err) => {
      console.warn(`[caddy] Failed to load initial config: ${err.message}`);
    });
  });
}

const port = parseInt(process.env.CONTROL_PLANE_PORT || "4001", 10);
await app.listen({ port, host: "0.0.0.0" });
console.log(`Control plane listening on http://localhost:${port}`);
if (deployVersion.commit) {
  console.log(`Version: ${deployVersion.commit} (${deployVersion.branch}) deployed ${deployVersion.timestamp}`);
}
