import type { FastifyInstance } from "fastify";
import { db, getTrafficHistory, getTrafficSummary } from "../db/client.js";
import { inspectVM } from "../services/firecracker.js";
import { getHealthStats } from "../services/health.js";
import { readFileSync } from "node:fs";

export function registerAdminRoutes(app: FastifyInstance) {
  // Admin auth check — runs before all /admin/* routes
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin")) return;

    // Check header from Caddy forward_auth
    if (request.headers["x-user-admin"] === "true") return;

    // Fallback: check DB directly (dev mode / Bearer token auth)
    const user = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(request.userId) as { is_admin: number } | undefined;
    if (user?.is_admin) return;

    return reply.status(403).send({ error: "Admin access required" });
  });

  // GET /admin/stats — Overview numbers
  app.get("/admin/stats", async () => {
    const vmsByStatus = db.prepare(
      "SELECT status, COUNT(*) as count FROM vms GROUP BY status"
    ).all() as { status: string; count: number }[];

    const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number }).count;

    const sessionCounts = db.prepare(
      "SELECT status, COUNT(*) as count FROM agent_sessions GROUP BY status"
    ).all() as { status: string; count: number }[];

    const messageCount = (db.prepare("SELECT COUNT(*) as count FROM agent_messages").get() as { count: number }).count;

    const recentVMs = db.prepare(
      "SELECT v.id, v.name, v.status, v.created_at, u.email as owner_email FROM vms v LEFT JOIN users u ON u.id = v.owner_id ORDER BY v.created_at DESC LIMIT 10"
    ).all();

    const recentEvents = db.prepare(
      "SELECT * FROM admin_events ORDER BY created_at DESC LIMIT 10"
    ).all();

    return {
      vmsByStatus: Object.fromEntries(vmsByStatus.map(r => [r.status, r.count])),
      totalVMs: vmsByStatus.reduce((sum, r) => sum + r.count, 0),
      userCount,
      sessionCounts: Object.fromEntries(sessionCounts.map(r => [r.status, r.count])),
      totalSessions: sessionCounts.reduce((sum, r) => sum + r.count, 0),
      messageCount,
      recentVMs,
      recentEvents,
    };
  });

  // GET /admin/users — All users
  app.get("/admin/users", async () => {
    const users = db.prepare(`
      SELECT u.id, u.email, u.name, u.github_username, u.avatar_url, u.is_admin, u.created_at,
        CASE WHEN u.github_id IS NOT NULL THEN 'github'
             WHEN u.google_id IS NOT NULL THEN 'google'
             ELSE 'email' END as provider,
        COUNT(va.vm_id) as vm_count
      FROM users u
      LEFT JOIN vm_access va ON va.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `).all();

    return { users };
  });

  // GET /admin/vms — All VMs
  app.get("/admin/vms", async () => {
    const vms = db.prepare(`
      SELECT v.*, u.email as owner_email, u.name as owner_name
      FROM vms v
      LEFT JOIN users u ON u.id = v.owner_id
      ORDER BY v.created_at DESC
    `).all();

    return { vms };
  });

  // GET /admin/vms/:id — Detailed VM info
  app.get("/admin/vms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const vm = db.prepare(`
      SELECT v.*, u.email as owner_email, u.name as owner_name
      FROM vms v
      LEFT JOIN users u ON u.id = v.owner_id
      WHERE v.id = ?
    `).get(id) as any;

    if (!vm) return reply.status(404).send({ error: "VM not found" });

    const access = db.prepare(`
      SELECT va.user_id, va.role, u.email, u.name
      FROM vm_access va
      LEFT JOIN users u ON u.id = va.user_id
      WHERE va.vm_id = ?
    `).all(id);

    const sessions = db.prepare(
      "SELECT * FROM agent_sessions WHERE vm_id = ? ORDER BY updated_at DESC"
    ).all(id);

    const messageCount = (db.prepare(
      "SELECT COUNT(*) as count FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE vm_id = ?)"
    ).get(id) as { count: number }).count;

    let vmStatus = null;
    try {
      vmStatus = await inspectVM(id);
    } catch { /* VM may not exist */ }

    return { vm, access, sessions, messageCount, vmStatus };
  });

  // GET /admin/traffic — TAP traffic for running VMs
  app.get("/admin/traffic", async () => {
    const runningVMs = db.prepare(
      "SELECT id, vm_ip FROM vms WHERE status = 'running'"
    ).all() as { id: string; vm_ip: string }[];

    const traffic = runningVMs.map(vm => {
      const tapDev = `tap-${vm.id}`;
      let rx = 0, tx = 0;
      try {
        rx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/rx_bytes`, "utf-8").trim(), 10);
        tx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/tx_bytes`, "utf-8").trim(), 10);
      } catch { /* TAP device not found */ }
      return { vmId: vm.id, vmIp: vm.vm_ip, rxBytes: rx, txBytes: tx, totalBytes: rx + tx };
    });

    return { traffic };
  });

  // GET /admin/traffic/summary — Traffic totals per VM over a time window
  app.get("/admin/traffic/summary", async (request) => {
    const query = request.query as { hours?: string };
    const hours = Math.min(parseInt(query.hours || "24", 10), 168); // max 7 days
    const summary = getTrafficSummary(hours);
    return { summary, hours };
  });

  // GET /admin/traffic/:id/history — Time-series traffic for a specific VM
  app.get("/admin/traffic/:id/history", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { hours?: string };
    const hours = Math.min(parseInt(query.hours || "24", 10), 168);
    const history = getTrafficHistory(id, hours);
    return { vmId: id, history, hours };
  });

  // GET /admin/sessions — All agent sessions
  app.get("/admin/sessions", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(parseInt(query.limit || "200", 10), 500);

    const sessions = db.prepare(`
      SELECT s.*, v.name as vm_name,
        (SELECT COUNT(*) FROM agent_messages WHERE session_id = s.id) as message_count
      FROM agent_sessions s
      LEFT JOIN vms v ON v.id = s.vm_id
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(limit);

    return { sessions };
  });

  // GET /admin/events — Recent admin events
  app.get("/admin/events", async (request) => {
    const query = request.query as { limit?: string; type?: string };
    const limit = Math.min(parseInt(query.limit || "100", 10), 500);

    let sql = "SELECT * FROM admin_events";
    const params: unknown[] = [];

    if (query.type) {
      sql += " WHERE type = ?";
      params.push(query.type);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const events = db.prepare(sql).all(...params);
    return { events };
  });

  // GET /admin/health — Extended health
  app.get("/admin/health", async () => {
    const stats = await getHealthStats();

    const portInfo = db.prepare(
      "SELECT COUNT(*) as used FROM vms WHERE status != 'error'"
    ).get() as { used: number };

    return {
      ...stats,
      resources: {
        portsUsed: portInfo.used,
        portRange: { app: "10001+", ssh: "20001+", opencode: "30001+" },
      },
    };
  });
}
