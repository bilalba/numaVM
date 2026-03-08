import type { FastifyInstance } from "fastify";
import { getDatabase, getVMEngine } from "../adapters/providers.js";
import { getHealthStats } from "../services/health.js";

export function registerAdminRoutes(app: FastifyInstance) {
  // Admin auth check — runs before all /admin/* routes
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin")) return;

    // Check header from Caddy forward_auth
    if (request.headers["x-user-admin"] === "true") return;

    // Fallback: check DB directly (dev mode / Bearer token auth)
    const user = getDatabase().rawGet<{ is_admin: number }>("SELECT is_admin FROM users WHERE id = ?", request.userId);
    if (user?.is_admin) return;

    return reply.status(403).send({ error: "Admin access required" });
  });

  // GET /admin/stats — Overview numbers
  app.get("/admin/stats", async () => {
    const db = getDatabase();
    const vmsByStatus = db.raw<{ status: string; count: number }>(
      "SELECT status, COUNT(*) as count FROM vms GROUP BY status"
    );

    const userRow = db.rawGet<{ count: number }>("SELECT COUNT(*) as count FROM users");
    const userCount = userRow?.count || 0;

    const recentVMs = db.raw(
      "SELECT v.id, v.name, v.status, v.created_at, u.email as owner_email FROM vms v LEFT JOIN users u ON u.id = v.owner_id ORDER BY v.created_at DESC LIMIT 10"
    );

    const recentEvents = db.raw(
      "SELECT * FROM admin_events ORDER BY created_at DESC LIMIT 10"
    );

    return {
      vmsByStatus: Object.fromEntries(vmsByStatus.map(r => [r.status, r.count])),
      totalVMs: vmsByStatus.reduce((sum, r) => sum + r.count, 0),
      userCount,
      recentVMs,
      recentEvents,
    };
  });

  // GET /admin/users — All users
  app.get("/admin/users", async () => {
    const users = getDatabase().raw(`
      SELECT u.id, u.email, u.name, u.github_username, u.avatar_url, u.is_admin, u.created_at,
        CASE WHEN u.github_id IS NOT NULL THEN 'github'
             WHEN u.google_id IS NOT NULL THEN 'google'
             ELSE 'email' END as provider,
        COUNT(va.vm_id) as vm_count
      FROM users u
      LEFT JOIN vm_access va ON va.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    return { users };
  });

  // GET /admin/vms — All VMs
  app.get("/admin/vms", async () => {
    const vms = getDatabase().raw(`
      SELECT v.*, u.email as owner_email, u.name as owner_name
      FROM vms v
      LEFT JOIN users u ON u.id = v.owner_id
      ORDER BY v.created_at DESC
    `);

    return { vms };
  });

  // GET /admin/vms/:id — Detailed VM info
  app.get("/admin/vms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDatabase();

    const vm = db.rawGet(`
      SELECT v.*, u.email as owner_email, u.name as owner_name
      FROM vms v
      LEFT JOIN users u ON u.id = v.owner_id
      WHERE v.id = ?
    `, id) as any;

    if (!vm) return reply.status(404).send({ error: "VM not found" });

    const access = db.raw(`
      SELECT va.user_id, va.role, u.email, u.name
      FROM vm_access va
      LEFT JOIN users u ON u.id = va.user_id
      WHERE va.vm_id = ?
    `, id);

    let vmStatus = null;
    try {
      vmStatus = await getVMEngine().inspectVM(id);
    } catch { /* VM may not exist */ }

    return { vm, access, vmStatus };
  });

  // GET /admin/traffic — TAP traffic for running VMs
  app.get("/admin/traffic", async () => {
    const runningVMs = getDatabase().raw<{ id: string; vm_ip: string }>(
      "SELECT id, vm_ip FROM vms WHERE status = 'running'"
    );

    const traffic = runningVMs.map(vm => {
      const { rxBytes, txBytes } = getVMEngine().getLiveTraffic(vm.id);
      return { vmId: vm.id, vmIp: vm.vm_ip, rxBytes, txBytes, totalBytes: rxBytes + txBytes };
    });

    return { traffic };
  });

  // GET /admin/traffic/summary — Traffic totals per VM over a time window
  app.get("/admin/traffic/summary", async (request) => {
    const query = request.query as { hours?: string };
    const hours = Math.min(parseInt(query.hours || "24", 10), 168); // max 7 days
    const summary = getDatabase().getTrafficSummary(hours);
    return { summary, hours };
  });

  // GET /admin/traffic/:id/history — Time-series traffic for a specific VM
  app.get("/admin/traffic/:id/history", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { hours?: string };
    const hours = Math.min(parseInt(query.hours || "24", 10), 168);
    const history = getDatabase().getTrafficHistory(id, hours);
    return { vmId: id, history, hours };
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

    const events = getDatabase().raw(sql, ...params);
    return { events };
  });

  // GET /admin/health — Extended health
  app.get("/admin/health", async () => {
    const stats = await getHealthStats();

    const portInfo = getDatabase().rawGet<{ used: number }>(
      "SELECT COUNT(*) as used FROM vms WHERE status != 'error'"
    );

    return {
      ...stats,
      resources: {
        portsUsed: portInfo?.used || 0,
        portRange: { app: "10001+", ssh: "20001+", opencode: "30001+" },
      },
    };
  });
}
