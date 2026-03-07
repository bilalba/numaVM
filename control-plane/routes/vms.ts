import type { FastifyInstance } from "fastify";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { customAlphabet } from "nanoid";
import {
  insertVM,
  findVMById,
  findVMsByUser,
  updateVMStatus,
  updateVMStatusDetail,
  updateVMInfo,
  updateVMSnapshotPath,
  deleteVM,
  grantAccess,
  revokeAllAccess,
  checkAccess,
  findUserById,
  emitAdminEvent,
  getUserProvisionedRam,
  getUserPlan,
} from "../db/client.js";
import { allocatePorts, allocateCid, cidToVmIp } from "../services/port-allocator.js";
import {
  createAndStartVM,
  stopVM,
  snapshotVM,
  pauseVM,
  resumeVM,
  removeVMFull,
  inspectVM,
  getInternalSshPubKey,
} from "../services/firecracker.js";
import { fetchSshKeys } from "../services/github.js";
import { execInVM } from "../services/vsock-ssh.js";
import { addRoute, removeRoute } from "../services/caddy.js";
import { ensureVMRunning, QuotaExceededError } from "../services/wake.js";

const generateSlug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);
const getBaseDomain = () => process.env.BASE_DOMAIN || "localhost";

const DEFAULT_MEM_SIZE = 512;

export function registerVMRoutes(app: FastifyInstance) {
  // Create VM
  app.post("/vms", async (request, reply) => {
    const body = request.body as { name?: string; gh_repo?: string; private?: boolean; mem_size_mib?: number };

    if (!body.name || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 64) {
      return reply.status(400).send({ error: "name is required (1-64 chars)" });
    }

    const userPlan = getUserPlan(request.userId);
    const memSizeMib = body.mem_size_mib ?? DEFAULT_MEM_SIZE;
    if (!userPlan.valid_mem_sizes.includes(memSizeMib)) {
      return reply.status(400).send({ error: `mem_size_mib must be one of: ${userPlan.valid_mem_sizes.join(", ")}` });
    }

    // Check RAM quota (only running/creating VMs count)
    const currentRam = getUserProvisionedRam(request.userId);
    if (currentRam + memSizeMib > userPlan.max_ram_mib) {
      return reply.status(400).send({
        error: "RAM quota exceeded",
        current_ram_mib: currentRam,
        requested_ram_mib: memSizeMib,
        max_ram_mib: userPlan.max_ram_mib,
        plan: userPlan.plan,
      });
    }

    const slug = `vm-${generateSlug()}`;
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

    // Generate per-VM OpenCode password
    const opencodePassword = generateSlug() + generateSlug() + generateSlug() + generateSlug();

    // Always pass user's GitHub token to VM (for git push), fall back to platform GH_PAT
    const ghToken = user?.github_token || process.env.GH_PAT || null;
    // Token-less is OK — VM will attempt a public clone via plain HTTPS.
    // git push won't work without a token, but the repo will still be cloned.

    // Insert VM record early (reserves ports + CID)
    insertVM({
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
      mem_size_mib: memSizeMib,
    });

    // Grant owner access (used by auth verify for subdomain gating)
    grantAccess(slug, request.userId, "owner");

    // Return immediately — VM creation happens in the background.
    // Dashboard polls GET /vms/:id for status + status_detail.
    reply.status(201).send({
      id: slug,
      name: body.name,
      url: `http://${slug}.${getBaseDomain()}`,
      ...(repoFullName ? { repo_url: `https://github.com/${repoFullName}` } : {}),
      ssh_command: `ssh ${slug}@ssh.${getBaseDomain()}`,
      ssh_port: sshPort,
      status: "creating",
    });

    // Background VM creation with real progress updates
    const userId = request.userId;
    (async () => {
      try {
        const vmId = await createAndStartVM({
          slug,
          name: body.name,
          appPort,
          sshPort,
          opencodePort,
          ghRepo: repoFullName || undefined,
          ghToken: ghToken || undefined,
          githubUsername: user?.github_username || undefined,
          sshKeys,
          opencodePassword,
          openaiApiKey: process.env.OPENAI_API_KEY,
          anthropicApiKey: process.env.ANTHROPIC_API_KEY,
          vsockCid,
          vmIp,
          memSizeMib: memSizeMib,
          onProgress: (detail: string) => {
            updateVMStatusDetail(slug, detail);
          },
        });
        updateVMInfo(slug, vmId, vmIp, vsockCid, null);

        // Poll VM init progress (cloning → installing → building → starting → ready)
        const progressLabels: Record<string, string> = {
          cloning: "Cloning repository",
          installing: "Installing dependencies",
          building: "Building project",
          starting: "Starting server",
          ready: "Ready",
        };
        let lastProgress = "";
        const maxWait = 5 * 60 * 1000; // 5 min timeout for init
        const start = Date.now();

        while (Date.now() - start < maxWait) {
          try {
            const raw = await execInVM(vmIp, ["cat", "/tmp/init-progress"]);
            const progress = raw.trim();
            if (progress && progress !== lastProgress) {
              lastProgress = progress;
              if (progress.startsWith("error:")) {
                updateVMStatusDetail(slug, `Error: ${progress.slice(6)}`);
                // Don't fail the whole VM — it's still SSH-accessible
                break;
              }
              updateVMStatusDetail(slug, progressLabels[progress] || progress);
              if (progress === "ready") break;
            }
          } catch {
            // SSH may not be ready yet or file doesn't exist yet
          }
          await new Promise((r) => setTimeout(r, 2000));
        }

        updateVMStatus(slug, "running");
        // Keep status_detail so the dashboard can show what happened
        if (lastProgress === "ready") {
          updateVMStatusDetail(slug, null);
        }

        // Register Caddy route AFTER status is "running" so it gets the proxy route
        try {
          await addRoute(slug, appPort);
        } catch (err) {
          console.error(`[vm] Failed to register Caddy route for ${slug}:`, err);
        }

        emitAdminEvent("vm.created", slug, userId, { name: body.name, mem_size_mib: memSizeMib, ...(repoFullName ? { repo: repoFullName } : {}) });
      } catch (err: any) {
        console.error(`[vm] Background VM creation failed for ${slug}:`, err);
        updateVMStatusDetail(slug, `Error: ${err.message}`);
        updateVMStatus(slug, "error");
        // Roll back DB records so ports/CIDs are freed for retry
        revokeAllAccess(slug);
        deleteVM(slug);
        const dataDir = process.env.DATA_DIR || "/data/envs";
        try { rmSync(join(dataDir, slug), { recursive: true, force: true }); } catch { /* ok */ }
      }
    })();
  });

  // List VMs for authenticated user
  app.get("/vms", async (request) => {
    const vms = findVMsByUser(request.userId);
    return {
      vms: vms.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        role: e.role,
        url: `http://${e.id}.${getBaseDomain()}`,
        ...(e.gh_repo ? { repo_url: `https://github.com/${e.gh_repo}` } : {}),
        created_at: e.created_at,
        mem_size_mib: e.mem_size_mib,
      })),
    };
  });

  // Get user's RAM quota usage
  app.get("/vms/quota", async (request) => {
    const userPlan = getUserPlan(request.userId);
    const currentRam = getUserProvisionedRam(request.userId);
    return {
      used_mib: currentRam,
      max_mib: userPlan.max_ram_mib,
      available_mib: userPlan.max_ram_mib - currentRam,
      plan: userPlan.plan,
      plan_label: userPlan.label,
      valid_mem_sizes: userPlan.valid_mem_sizes,
      trial_active: userPlan.trial_active,
      trial_expires_at: userPlan.trial_expires_at,
    };
  });

  // Get VM details
  app.get("/vms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = findVMById(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    // Auto-wake snapshotted VMs when detail page is loaded
    let quotaError: { message: string; current_ram_mib: number; vm_ram_mib: number; max_ram_mib: number; plan: string } | undefined;
    if (vm.status === "snapshotted" || vm.status === "paused") {
      try {
        await ensureVMRunning(vm.id);
      } catch (err: any) {
        if (err instanceof QuotaExceededError) {
          quotaError = { message: err.message, current_ram_mib: err.current_ram_mib, vm_ram_mib: err.vm_ram_mib, max_ram_mib: err.max_ram_mib, plan: err.plan };
        } else {
          console.error(`[wake] Background wake failed for ${id}:`, err);
          request.log.error({ err, vmId: id }, "Background wake failed");
        }
      }
    }

    // Live VM status
    let vmStatus: { running: boolean; status: string; startedAt: string | null; vsockCid: number } | null = null;
    try {
      vmStatus = await inspectVM(vm.id);
    } catch {
      // VM may have been removed externally
    }

    return {
      id: vm.id,
      name: vm.name,
      status: vm.status,
      status_detail: vm.status_detail,
      url: `http://${vm.id}.${getBaseDomain()}`,
      ...(vm.gh_repo ? { repo_url: `https://github.com/${vm.gh_repo}` } : {}),
      ssh_command: `ssh ${vm.id}@ssh.${getBaseDomain()}`,
      ssh_port: vm.ssh_port,
      app_port: vm.app_port,
      opencode_port: vm.opencode_port,
      vm_status: vmStatus,
      role,
      created_at: vm.created_at,
      mem_size_mib: vm.mem_size_mib,
      ...(quotaError ? { quota_error: quotaError } : {}),
    };
  });

  // Destroy VM (owner only)
  app.delete("/vms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = findVMById(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = checkAccess(id, request.userId);
    if (role !== "owner") {
      return reply.status(403).send({ error: "Only the owner can delete a VM" });
    }

    // Cleanup VM (best-effort) — includes TAP, iptables DNAT
    try {
      await removeVMFull(
        id,
        vm.vm_ip || cidToVmIp(vm.vsock_cid || 3),
        vm.app_port,
        vm.ssh_port,
        vm.opencode_port,
      );
    } catch { /* may already be stopped/removed */ }

    // Cleanup Caddy route (best-effort)
    try { await removeRoute(id); } catch { /* may not exist */ }

    // Cleanup DB
    revokeAllAccess(id);
    deleteVM(id);

    // Cleanup data directory (rootfs, snapshots, overlay, etc.)
    const dataDir = process.env.DATA_DIR || "/data/envs";
    const vmDataPath = join(dataDir, id);
    try { rmSync(vmDataPath, { recursive: true, force: true }); } catch { /* best-effort */ }

    emitAdminEvent("vm.deleted", id, request.userId);

    return { ok: true, message: `VM ${id} destroyed` };
  });

  // Pause (snapshot) VM
  app.post("/vms/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = findVMById(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = checkAccess(id, request.userId);
    if (role !== "owner") {
      return reply.status(403).send({ error: "Only the owner can pause a VM" });
    }

    if (vm.status !== "running") {
      return reply.status(400).send({ error: `Cannot pause VM in '${vm.status}' state` });
    }

    try {
      await snapshotVM(id);
      const snapshotPath = `${process.env.DATA_DIR || "/data/vms"}/${id}/snapshot`;
      updateVMSnapshotPath(id, snapshotPath);
      updateVMStatus(id, "snapshotted");

      try { await removeRoute(id); } catch { /* ok */ }

      emitAdminEvent("vm.paused", id, request.userId);

      return { ok: true, message: `VM ${id} paused (snapshotted)` };
    } catch (err: any) {
      request.log.error({ err, id }, "Failed to pause VM");
      return reply.status(500).send({ error: "Failed to pause VM", details: err.message });
    }
  });

  // Clone VM (copy disk state from source)
  app.post("/vms/:id/clone", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string } || {};
    const sourceVM = findVMById(id);
    if (!sourceVM) {
      return reply.status(404).send({ error: "Source VM not found" });
    }

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    if (sourceVM.status !== "running" && sourceVM.status !== "snapshotted" && sourceVM.status !== "paused") {
      return reply.status(400).send({ error: `Cannot clone VM in '${sourceVM.status}' state` });
    }

    const dataDir = process.env.DATA_DIR || "/data/vms";
    const sourceDir = join(dataDir, id);
    const sourceRootfs = join(sourceDir, "rootfs.ext4");
    const sourceData = join(sourceDir, "data.ext4");

    if (!existsSync(sourceRootfs)) {
      return reply.status(400).send({ error: "Source VM has no rootfs to clone" });
    }

    const cloneMemSize = sourceVM.mem_size_mib;
    const userPlan = getUserPlan(request.userId);
    const currentRam = getUserProvisionedRam(request.userId);
    if (currentRam + cloneMemSize > userPlan.max_ram_mib) {
      return reply.status(400).send({
        error: "RAM quota exceeded",
        current_ram_mib: currentRam,
        requested_ram_mib: cloneMemSize,
        max_ram_mib: userPlan.max_ram_mib,
        plan: userPlan.plan,
      });
    }

    const cloneName = body.name || `${sourceVM.name} (copy)`;
    const slug = `vm-${generateSlug()}`;
    const { appPort, sshPort, opencodePort } = allocatePorts();
    const vsockCid = allocateCid();
    const vmIp = cidToVmIp(vsockCid);

    // Fetch cloning user's SSH keys (not source's)
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

    const opencodePassword = generateSlug() + generateSlug() + generateSlug() + generateSlug();
    const ghToken = user?.github_token || process.env.GH_PAT || null;

    // Create target data directory
    const targetDir = join(dataDir, slug);
    mkdirSync(targetDir, { recursive: true });

    // Copy disk files: pause source if running, copy, resume
    try {
      const isRunning = sourceVM.status === "running";
      if (isRunning) {
        await pauseVM(id);
      }

      try {
        // Copy rootfs (sparse/reflink when possible)
        try {
          execSync(`cp --reflink=auto "${sourceRootfs}" "${join(targetDir, "rootfs.ext4")}"`, { stdio: "pipe" });
        } catch {
          execSync(`cp "${sourceRootfs}" "${join(targetDir, "rootfs.ext4")}"`, { stdio: "pipe" });
        }

        // Copy data volume if it exists
        if (existsSync(sourceData)) {
          try {
            execSync(`cp --reflink=auto "${sourceData}" "${join(targetDir, "data.ext4")}"`, { stdio: "pipe" });
          } catch {
            execSync(`cp "${sourceData}" "${join(targetDir, "data.ext4")}"`, { stdio: "pipe" });
          }
        }
      } finally {
        // Always resume source if we paused it
        if (isRunning) {
          await resumeVM(id);
        }
      }
    } catch (err: any) {
      // Clean up target dir on copy failure
      try { execSync(`rm -rf "${targetDir}"`, { stdio: "pipe" }); } catch { /* ok */ }
      request.log.error({ err, sourceId: id, targetSlug: slug }, "Failed to copy disk files for clone");
      return reply.status(500).send({ error: "Failed to copy disk files", details: err.message });
    }

    // Insert VM record (reserves ports/CID)
    insertVM({
      id: slug,
      name: cloneName,
      owner_id: request.userId,
      gh_repo: sourceVM.gh_repo || null,
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
      mem_size_mib: cloneMemSize,
    });
    grantAccess(slug, request.userId, "owner");

    // Boot new VM from copied disks (createAndStartVM skips rootfs/data creation if files exist)
    try {
      const vmId = await createAndStartVM({
        slug,
        name: cloneName,
        appPort,
        sshPort,
        opencodePort,
        ghRepo: sourceVM.gh_repo || undefined,
        ghToken: ghToken || undefined,
        githubUsername: user?.github_username || undefined,
        sshKeys,
        opencodePassword,
        openaiApiKey: process.env.OPENAI_API_KEY,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        vsockCid,
        vmIp,
        memSizeMib: cloneMemSize,
      });
      updateVMInfo(slug, vmId, vmIp, vsockCid, null);
    } catch (err: any) {
      revokeAllAccess(slug);
      deleteVM(slug);
      try { execSync(`rm -rf "${targetDir}"`, { stdio: "pipe" }); } catch { /* ok */ }
      request.log.error({ err, slug }, "Failed to create cloned VM");
      return reply.status(500).send({ error: "Failed to create cloned VM", details: err.message });
    }

    updateVMStatus(slug, "running");

    try {
      await addRoute(slug, appPort);
    } catch (err) {
      request.log.warn({ err, slug }, "Failed to register Caddy route for clone");
    }

    emitAdminEvent("vm.cloned", slug, request.userId, { source: id, name: cloneName });

    return reply.status(201).send({
      id: slug,
      name: cloneName,
      url: `http://${slug}.${getBaseDomain()}`,
      ...(sourceVM.gh_repo ? { repo_url: `https://github.com/${sourceVM.gh_repo}` } : {}),
      ssh_command: `ssh ${slug}@ssh.${getBaseDomain()}`,
      ssh_port: sshPort,
      status: "running",
    });
  });

  // Status page (Caddy fallback for 502/503)
  app.get("/vms/:id/status-page", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = findVMById(id);

    const status = vm?.status || "unknown";
    const name = vm?.name || id;

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

    // If snapshotted, trigger a wake (check quota first)
    let isQuotaError = false;
    if (vm && (status === "snapshotted" || status === "paused")) {
      try {
        await ensureVMRunning(id);
      } catch (err: any) {
        if (err instanceof QuotaExceededError) {
          isQuotaError = true;
          statusMessage = "over your plan's RAM limit";
        } else {
          request.log.error({ err, id }, "Failed to wake VM from status page");
        }
      }
    }

    // Only auto-refresh for states that will resolve (waking/creating), not for errors/quota
    const shouldAutoRefresh = !isQuotaError && (status === "snapshotted" || status === "paused" || status === "creating");

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
    ${isQuotaError ? '' : '<div class="spinner"></div>'}
    <h2>${name}</h2>
    <p>VM is ${statusMessage}${isQuotaError ? '' : '...'}</p>
    ${isQuotaError ? '<p style="margin-top: 1rem; font-size: 0.625rem; color: #737373;">Stop another VM or <a href="/plan" style="color: #171717; text-decoration: underline;">upgrade your plan</a> to wake this one.</p>' : ''}
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
  app.get("/vms/:id/ssh-keys-status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = findVMById(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    if (vm.status !== "running" || !vm.vm_ip) {
      return { synced: false, reason: "not_running" };
    }

    try {
      const desiredKeys = await gatherUserKeys(request.userId);
      const currentRaw = await execInVM(vm.vm_ip, [
        "cat", "/home/dev/.ssh/authorized_keys",
      ]);
      const currentKeys = dedupeKeys(currentRaw);
      return { synced: currentKeys === desiredKeys };
    } catch {
      return { synced: false, reason: "check_failed" };
    }
  });

  // Sync SSH keys to a running VM
  app.post("/vms/:id/sync-ssh-keys", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = findVMById(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    if (vm.status !== "running" || !vm.vm_ip) {
      return reply.status(400).send({ error: "VM is not running" });
    }

    const allKeys = await gatherUserKeys(request.userId);
    const keysB64 = Buffer.from(allKeys).toString("base64");

    try {
      await execInVM(vm.vm_ip, [
        "sh", "-c",
        `echo '${keysB64}' | base64 -d > /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys`,
      ]);
      return { ok: true, message: "SSH keys synced to VM" };
    } catch (err: any) {
      request.log.error({ err, id }, "Failed to sync SSH keys");
      return reply.status(500).send({ error: "Failed to sync SSH keys", details: err.message });
    }
  });
}
