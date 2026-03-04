import type { FastifyInstance } from "fastify";
import { customAlphabet } from "nanoid";
import {
  insertEnv,
  findEnvById,
  findEnvsByUser,
  updateEnvStatus,
  updateEnvVmInfo,
  updateEnvSnapshotPath,
  deleteEnv,
  grantAccess,
  revokeAllAccess,
  checkAccess,
  findUserById,
} from "../db/client.js";
import { allocatePorts, allocateCid, cidToVmIp } from "../services/port-allocator.js";
import {
  createAndStartVM,
  stopVM,
  snapshotVM,
  removeVMFull,
  inspectVM,
  getInternalSshPubKey,
} from "../services/firecracker.js";
import { createRepo, fetchSshKeys } from "../services/github.js";
import { addRoute, removeRoute } from "../services/caddy.js";
import { ensureVMRunning } from "../services/wake.js";

const generateSlug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);
const getBaseDomain = () => process.env.BASE_DOMAIN || "localhost";

export function registerEnvRoutes(app: FastifyInstance) {
  // Create environment
  app.post("/envs", async (request, reply) => {
    const body = request.body as { name?: string; gh_repo?: string; private?: boolean };

    if (!body.name || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 64) {
      return reply.status(400).send({ error: "name is required (1-64 chars)" });
    }

    const slug = `env-${generateSlug()}`;
    const { appPort, sshPort, opencodePort } = allocatePorts();
    const vsockCid = allocateCid();
    const vmIp = cidToVmIp(vsockCid);

    // Resolve GitHub repo
    let repoFullName: string;
    if (body.gh_repo) {
      repoFullName = body.gh_repo;
    } else if (!process.env.GH_PAT) {
      return reply.status(400).send({
        error: "GitHub token not configured. Provide an existing repo (owner/repo) or ask the admin to set GH_PAT.",
      });
    } else {
      const repo = await createRepo(slug, body.private !== false);
      repoFullName = repo.fullName;
    }

    // Fetch user's GitHub SSH keys
    const user = findUserById(request.userId);
    let sshKeys = "";
    if (user?.github_username) {
      sshKeys = await fetchSshKeys(user.github_username);
    }

    // Generate per-env OpenCode password
    const opencodePassword = generateSlug() + generateSlug() + generateSlug() + generateSlug();
    const ghToken = process.env.GH_PAT || "";

    // Insert env record early (reserves ports + CID)
    insertEnv({
      id: slug,
      name: body.name,
      owner_id: request.userId,
      gh_repo: repoFullName,
      gh_token: ghToken,
      container_id: null,
      vm_ip: vmIp,
      vsock_cid: vsockCid,
      vm_pid: null,
      snapshot_path: null,
      app_port: appPort,
      ssh_port: sshPort,
      opencode_port: opencodePort,
      opencode_password: opencodePassword,
      status: "creating",
    });

    // Grant owner access (used by auth verify for subdomain gating)
    grantAccess(slug, request.userId, "owner");

    // Create and start Firecracker VM
    try {
      const vmId = await createAndStartVM({
        slug,
        appPort,
        sshPort,
        opencodePort,
        ghRepo: repoFullName,
        ghToken,
        sshKeys,
        opencodePassword,
        openaiApiKey: process.env.OPENAI_API_KEY,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        vsockCid,
        vmIp,
      });
      updateEnvVmInfo(slug, vmId, vmIp, vsockCid, null);
    } catch (err: any) {
      // Roll back DB records so ports/CIDs are freed for retry
      revokeAllAccess(slug);
      deleteEnv(slug);
      request.log.error({ err, slug }, "Failed to create VM");
      return reply.status(500).send({ error: "Failed to create VM", details: err.message });
    }

    // Mark running BEFORE Caddy reload so it generates reverse_proxy (not status-page)
    updateEnvStatus(slug, "running");

    // Register Caddy route (non-fatal)
    try {
      await addRoute(slug, appPort);
    } catch (err) {
      request.log.warn({ err, slug }, "Failed to register Caddy route");
    }

    return reply.status(201).send({
      id: slug,
      name: body.name,
      url: `http://${slug}.${getBaseDomain()}`,
      repo_url: `https://github.com/${repoFullName}`,
      ssh_command: `ssh dev@${getBaseDomain()} -p ${sshPort}`,
      ssh_port: sshPort,
      status: "running",
    });
  });

  // List environments for authenticated user
  app.get("/envs", async (request) => {
    const envs = findEnvsByUser(request.userId);
    return {
      envs: envs.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        role: e.role,
        url: `http://${e.id}.${getBaseDomain()}`,
        repo_url: `https://github.com/${e.gh_repo}`,
        created_at: e.created_at,
      })),
    };
  });

  // Get environment details
  app.get("/envs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const env = findEnvById(id);
    if (!env) {
      return reply.status(404).send({ error: "Environment not found" });
    }

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this environment" });
    }

    // Auto-wake snapshotted VMs in the background when detail page is loaded
    if (env.status === "snapshotted" || env.status === "paused") {
      ensureVMRunning(env.id).catch((err) => {
        console.error(`[wake] Background wake failed for ${id}:`, err);
        request.log.error({ err, envId: id }, "Background wake failed");
      });
    }

    // Live VM status
    let vmStatus: { running: boolean; status: string; startedAt: string | null; vsockCid: number } | null = null;
    try {
      vmStatus = await inspectVM(env.id);
    } catch {
      // VM may have been removed externally
    }

    return {
      id: env.id,
      name: env.name,
      status: env.status,
      url: `http://${env.id}.${getBaseDomain()}`,
      repo_url: `https://github.com/${env.gh_repo}`,
      ssh_command: `ssh dev@${getBaseDomain()} -p ${env.ssh_port}`,
      ssh_port: env.ssh_port,
      app_port: env.app_port,
      opencode_port: env.opencode_port,
      vm_status: vmStatus,
      role,
      created_at: env.created_at,
    };
  });

  // Destroy environment (owner only)
  app.delete("/envs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const env = findEnvById(id);
    if (!env) {
      return reply.status(404).send({ error: "Environment not found" });
    }

    const role = checkAccess(id, request.userId);
    if (role !== "owner") {
      return reply.status(403).send({ error: "Only the owner can delete an environment" });
    }

    // Cleanup VM (best-effort) — includes TAP, iptables DNAT
    try {
      await removeVMFull(
        id,
        env.vm_ip || cidToVmIp(env.vsock_cid || 3),
        env.app_port,
        env.ssh_port,
        env.opencode_port,
      );
    } catch { /* may already be stopped/removed */ }

    // Cleanup Caddy route (best-effort)
    try { await removeRoute(id); } catch { /* may not exist */ }

    // Cleanup DB
    revokeAllAccess(id);
    deleteEnv(id);

    return { ok: true, message: `Environment ${id} destroyed` };
  });

  // Pause (snapshot) environment
  app.post("/envs/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const env = findEnvById(id);
    if (!env) {
      return reply.status(404).send({ error: "Environment not found" });
    }

    const role = checkAccess(id, request.userId);
    if (role !== "owner") {
      return reply.status(403).send({ error: "Only the owner can pause an environment" });
    }

    if (env.status !== "running") {
      return reply.status(400).send({ error: `Cannot pause environment in '${env.status}' state` });
    }

    try {
      await snapshotVM(id);
      const snapshotPath = `${process.env.DATA_DIR || "/data/envs"}/${id}/snapshot`;
      updateEnvSnapshotPath(id, snapshotPath);
      updateEnvStatus(id, "snapshotted");

      try { await removeRoute(id); } catch { /* ok */ }

      return { ok: true, message: `Environment ${id} paused (snapshotted)` };
    } catch (err: any) {
      request.log.error({ err, id }, "Failed to pause VM");
      return reply.status(500).send({ error: "Failed to pause VM", details: err.message });
    }
  });

  // Status page (Caddy fallback for 502/503)
  app.get("/envs/:id/status-page", async (request, reply) => {
    const { id } = request.params as { id: string };
    const env = findEnvById(id);

    const status = env?.status || "unknown";
    const name = env?.name || id;

    const pageStyle = `
    body { font-family: 'SFMono-Regular', Menlo, Monaco, Consolas, 'Courier New', monospace; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #faf7f2; color: #171717; }
    .card { text-align: center; padding: 3rem; border: 1px solid #e5e5e5; max-width: 420px; background: #fcfaf7; }
    h2 { margin: 0 0 0.5rem; font-size: 1.125rem; font-weight: 600; }
    p { color: #737373; margin: 0; font-size: 0.75rem; }
    code { background: #f5f5f5; padding: 2px 6px; border: 1px solid #e5e5e5; font-size: 0.75rem; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #e5e5e5; border-top-color: #171717; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 1rem; }
    @keyframes spin { to { transform: rotate(360deg); } }`;

    // VM is running but the port isn't responding — show "nothing here" page
    if (status === "running") {
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>${name} — Nothing here</title>
  <meta http-equiv="refresh" content="5">
  <style>${pageStyle}</style>
</head>
<body>
  <div class="card">
    <h2>Nothing here yet</h2>
    <p style="margin-top: 0.75rem;">Ask your agent to serve on port <code>3000</code></p>
    <p style="margin-top: 1.5rem; font-size: 0.625rem; color: #a3a3a3;">This page refreshes automatically.</p>
  </div>
</body>
</html>`;
      return reply.type("text/html").send(html);
    }

    let statusMessage: string;
    switch (status) {
      case "creating":
        statusMessage = "starting up";
        break;
      case "snapshotted":
      case "paused":
        statusMessage = "waking up";
        break;
      case "error":
        statusMessage = "experiencing an error";
        break;
      default:
        statusMessage = "loading";
    }

    // If snapshotted, trigger a wake in the background
    if (env && (status === "snapshotted" || status === "paused")) {
      import("../services/wake.js").then(({ ensureVMRunning }) => {
        ensureVMRunning(id).catch((err) => {
          request.log.error({ err, id }, "Failed to wake VM from status page");
        });
      }).catch(() => {});
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${name} — ${statusMessage.charAt(0).toUpperCase() + statusMessage.slice(1)}</title>
  <meta http-equiv="refresh" content="3">
  <style>${pageStyle}</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h2>${name}</h2>
    <p>Environment is ${statusMessage}...</p>
    <p style="margin-top: 1rem;">This page refreshes automatically.</p>
  </div>
</body>
</html>`;

    reply.type("text/html").send(html);
  });
}
