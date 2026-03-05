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
  emitAdminEvent,
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
import { fetchSshKeys } from "../services/github.js";
import { execInVM } from "../services/vsock-ssh.js";
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

    // GitHub repo is optional — if provided, VM will clone it
    const repoFullName = body.gh_repo || null;

    // Fetch user's SSH keys (GitHub + custom)
    const user = findUserById(request.userId);
    const keyParts: string[] = [];
    if (user?.github_username) {
      const ghKeys = await fetchSshKeys(user.github_username);
      if (ghKeys) keyParts.push(ghKeys);
    }
    if (user?.ssh_public_keys) {
      keyParts.push(user.ssh_public_keys);
    }
    const sshKeys = keyParts.join("\n");

    // Generate per-env OpenCode password
    const opencodePassword = generateSlug() + generateSlug() + generateSlug() + generateSlug();
    const ghToken = repoFullName ? (process.env.GH_PAT || "") : null;

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
        name: body.name,
        appPort,
        sshPort,
        opencodePort,
        ghRepo: repoFullName || undefined,
        ghToken: ghToken || undefined,
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

    emitAdminEvent("vm.created", slug, request.userId, { name: body.name, ...(repoFullName ? { repo: repoFullName } : {}) });

    return reply.status(201).send({
      id: slug,
      name: body.name,
      url: `http://${slug}.${getBaseDomain()}`,
      ...(repoFullName ? { repo_url: `https://github.com/${repoFullName}` } : {}),
      ssh_command: `ssh ${slug}@ssh.${getBaseDomain()}`,
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
        ...(e.gh_repo ? { repo_url: `https://github.com/${e.gh_repo}` } : {}),
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
      ...(env.gh_repo ? { repo_url: `https://github.com/${env.gh_repo}` } : {}),
      ssh_command: `ssh ${env.id}@ssh.${getBaseDomain()}`,
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

    emitAdminEvent("vm.deleted", id, request.userId);

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

      emitAdminEvent("vm.paused", id, request.userId);

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
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'%3E%3Crect width='32' height='32' fill='%23000'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-family='monospace' font-weight='700' font-size='16' fill='%23f8f4ee'%3EN%3C/text%3E%3C/svg%3E" />
  <title>${name} — Nothing here</title>
  <style>${pageStyle}</style>
</head>
<body>
  <div class="card">
    <h2>Nothing here yet</h2>
    <p style="margin-top: 0.75rem;">Ask your agent to serve on port <code>3000</code></p>
    <p style="margin-top: 1.5rem; font-size: 0.625rem; color: #a3a3a3;">Refresh this page after your app is running.</p>
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

    // Only auto-refresh for states that will resolve (waking/creating), not for errors
    const shouldAutoRefresh = status === "snapshotted" || status === "paused" || status === "creating";

    const html = `<!DOCTYPE html>
<html>
<head>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'%3E%3Crect width='32' height='32' fill='%23000'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-family='monospace' font-weight='700' font-size='16' fill='%23f8f4ee'%3EN%3C/text%3E%3C/svg%3E" />
  <title>${name} — ${statusMessage.charAt(0).toUpperCase() + statusMessage.slice(1)}</title>
  ${shouldAutoRefresh ? '<meta http-equiv="refresh" content="3">' : ''}
  <style>${pageStyle}</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h2>${name}</h2>
    <p>Environment is ${statusMessage}...</p>
  </div>
</body>
</html>`;

    reply.type("text/html").send(html);
  });

  /** Deduplicate SSH keys by their key data (type + base64 blob), ignoring comments. */
  function dedupeKeys(rawKeys: string): string {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const line of rawKeys.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Key identity is "type base64data" (first two fields)
      const parts = trimmed.split(/\s+/);
      const identity = parts.length >= 2 ? `${parts[0]} ${parts[1]}` : trimmed;
      if (!seen.has(identity)) {
        seen.add(identity);
        unique.push(trimmed);
      }
    }
    return unique.join("\n");
  }

  /** Gather all desired keys for a user (GitHub + custom + internal), deduped. */
  async function gatherUserKeys(userId: string): Promise<string> {
    const user = findUserById(userId);
    const parts: string[] = [];

    if (user?.github_username) {
      const ghKeys = await fetchSshKeys(user.github_username);
      if (ghKeys) parts.push(ghKeys);
    }
    if (user?.ssh_public_keys) {
      parts.push(user.ssh_public_keys);
    }

    // Always include the internal key
    parts.push(getInternalSshPubKey());

    return dedupeKeys(parts.join("\n"));
  }

  // Check if SSH keys are already synced to the VM
  app.get("/envs/:id/ssh-keys-status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const env = findEnvById(id);
    if (!env) {
      return reply.status(404).send({ error: "Environment not found" });
    }

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this environment" });
    }

    if (env.status !== "running" || !env.vm_ip) {
      return { synced: false, reason: "not_running" };
    }

    try {
      const desiredKeys = await gatherUserKeys(request.userId);
      const currentRaw = await execInVM(env.vm_ip, [
        "cat", "/home/dev/.ssh/authorized_keys",
      ]);
      const currentKeys = dedupeKeys(currentRaw);
      return { synced: currentKeys === desiredKeys };
    } catch {
      return { synced: false, reason: "check_failed" };
    }
  });

  // Sync SSH keys to a running VM
  app.post("/envs/:id/sync-ssh-keys", async (request, reply) => {
    const { id } = request.params as { id: string };
    const env = findEnvById(id);
    if (!env) {
      return reply.status(404).send({ error: "Environment not found" });
    }

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this environment" });
    }

    if (env.status !== "running" || !env.vm_ip) {
      return reply.status(400).send({ error: "Environment is not running" });
    }

    const allKeys = await gatherUserKeys(request.userId);
    const keysB64 = Buffer.from(allKeys).toString("base64");

    try {
      await execInVM(env.vm_ip, [
        "sh", "-c",
        `echo '${keysB64}' | base64 -d > /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys`,
      ]);
      return { ok: true, message: "SSH keys synced to environment" };
    } catch (err: any) {
      request.log.error({ err, id }, "Failed to sync SSH keys");
      return reply.status(500).send({ error: "Failed to sync SSH keys", details: err.message });
    }
  });
}
