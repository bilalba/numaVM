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
import { registerVMRoutes } from "./routes/vms.js";
import { registerAccessRoutes } from "./routes/access.js";
import { registerTerminalRoutes } from "./routes/terminal.js";
import { registerClaudeRoutes } from "./routes/claude.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerUserRoutes } from "./routes/user.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { destroyAllTerminals } from "./terminal/pty-handler.js";
import { agentManager } from "./agents/manager.js";
import { getHealthStats } from "./services/health.js";
import { destroyAllVMs, reconcileRunningVMs } from "./services/firecracker.js";
import { startIdleMonitor, stopIdleMonitor } from "./services/idle-monitor.js";
import { startSshProxy, stopSshProxy } from "./services/ssh-proxy.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    userEmail: string;
  }
}

const app = Fastify({ logger: true });

// Preserve raw body for Stripe webhook signature verification
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
  const isWebhook = req.url === "/billing/webhook";
  try {
    const parsed = JSON.parse(body.toString());
    if (isWebhook) {
      (req as any).rawBody = body;
    }
    done(null, parsed);
  } catch (err: any) {
    done(err, undefined);
  }
});

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
      if (url.port === "4002" || url.port === "4003") return cb(null, true);
    } catch {}
    cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

// JWT verification for CLI Bearer tokens
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "change-me-to-a-random-string"
);

async function verifyBearerToken(
  authHeader: string
): Promise<{ userId: string; userEmail: string } | null> {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (!payload.sub || !payload.email) return null;
    return { userId: payload.sub, userEmail: payload.email as string };
  } catch {
    return null;
  }
}

// Extract auth headers set by Caddy forward_auth (or Bearer token from CLI)
app.addHook("preHandler", async (request, reply) => {
  // Skip auth for health check, status pages, and Stripe webhook
  if (request.url === "/health" || request.url.endsWith("/status-page") || request.url === "/billing/webhook" || request.url.match(/^\/link-ssh\/[^/]+$/) || request.url.match(/^\/link-ssh\/[^/]+\/status$/)) return;

  const userId = request.headers["x-user-id"] as string | undefined;
  const userEmail = request.headers["x-user-email"] as string | undefined;

  // Try Caddy forward_auth headers first
  if (userId && userEmail) {
    request.userId = userId;
    request.userEmail = userEmail;
    return;
  }

  // Try Authorization: Bearer <jwt> (CLI auth)
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const claims = await verifyBearerToken(authHeader);
    if (claims) {
      request.userId = claims.userId;
      request.userEmail = claims.userEmail;
      return;
    }
    return reply.status(401).send({ error: "Invalid token" });
  }

  // Dev mode: fake auth when no Caddy is running
  if (baseDomain === "localhost" || process.env.DEV_MODE === "true") {
    // Ensure dev user exists in shared DB
    const { db } = await import("./db/client.js");
    db.prepare(
      `INSERT OR IGNORE INTO users (id, email, name) VALUES ('dev-user', 'dev@localhost', 'Dev User')`
    ).run();
    request.userId = "dev-user";
    request.userEmail = "dev@localhost";
    return;
  }

  return reply.status(401).send({ error: "Unauthorized" });
});

// Health check
app.get("/health", async () => {
  const stats = await getHealthStats();
  return { ...stats, version: deployVersion };
});

// Current user (for CLI `numavm auth whoami`)
app.get("/me", async (request) => {
  const { db, getUserPlan } = await import("./db/client.js");
  const user = db
    .prepare("SELECT id, email, name, avatar_url, github_username, github_token FROM users WHERE id = ?")
    .get(request.userId) as { id: string; email: string; name: string; avatar_url: string; github_username: string | null; github_token: string | null } | undefined;
  if (!user) {
    return { id: request.userId, email: request.userEmail, has_github_token: false };
  }
  const { github_token, ...rest } = user;
  const plan = getUserPlan(request.userId);
  return { ...rest, has_github_token: !!github_token, plan: plan.plan, plan_label: plan.label, trial_active: plan.trial_active, trial_expires_at: plan.trial_expires_at };
});

// Register route modules
registerVMRoutes(app);
registerAccessRoutes(app);
registerTerminalRoutes(app);
registerClaudeRoutes(app);
registerAgentRoutes(app);
registerFileRoutes(app);
registerUserRoutes(app);
registerAdminRoutes(app);
registerBillingRoutes(app);

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

// Graceful shutdown — VMs are NOT killed here since they run as independent
// systemd services and should survive CP restarts (reconciled on next startup)
const shutdown = async () => {
  stopIdleMonitor();
  stopSshProxy();
  agentManager.destroyAll();
  destroyAllTerminals();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start
// Reconcile in-memory VM state with any surviving Firecracker processes
await reconcileRunningVMs();

// Start SSH proxy (auth + wake-on-connect for all VMs)
await startSshProxy();

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
