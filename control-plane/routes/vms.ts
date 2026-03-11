import type { FastifyInstance } from "fastify";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { customAlphabet } from "nanoid";
import { getDatabase, getVMEngine, getReverseProxy, getLifecycleHook } from "../adapters/providers.js";
import { fetchSshKeys } from "../services/github.js";
import { ensureVMRunning, QuotaExceededError, DataQuotaExceededError, DiskQuotaExceededError } from "../services/wake.js";
import { bindWakeProxy, unbindWakeProxy, bindAppWakeProxy, unbindAppWakeProxy } from "../services/wake-proxy.js";
import { agentManager } from "../agents/manager.js";
import { validateVMName } from "../utils/validation.js";

const generateSlug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);
const getBaseDomain = () => process.env.BASE_DOMAIN || "localhost";

const DEFAULT_MEM_SIZE = 256;
const DEFAULT_DISK_SIZE = 1;

export function registerVMRoutes(app: FastifyInstance) {
  // Create VM
  app.post("/vms", async (request, reply) => {
    const body = request.body as { name?: string; gh_repo?: string; private?: boolean; mem_size_mib?: number; disk_size_gib?: number; image?: string; initial_prompt?: string };

    if (!body.name || typeof body.name !== "string") {
      return reply.status(400).send({ error: "name is required" });
    }
    const nameValidation = validateVMName(body.name);
    if (!nameValidation.valid) {
      return reply.status(400).send({ error: nameValidation.message });
    }
    // Check uniqueness
    if (getDatabase().findVMByName(body.name)) {
      return reply.status(409).send({ error: "Name already taken" });
    }

    const userPlan = getDatabase().getUserPlan(request.userId);
    const memSizeMib = body.mem_size_mib ?? DEFAULT_MEM_SIZE;
    if (!userPlan.valid_mem_sizes.includes(memSizeMib)) {
      return reply.status(400).send({ error: `mem_size_mib must be one of: ${userPlan.valid_mem_sizes.join(", ")}` });
    }

    const diskSizeGib = body.disk_size_gib ?? DEFAULT_DISK_SIZE;
    if (!userPlan.valid_disk_sizes.includes(diskSizeGib)) {
      return reply.status(400).send({ error: `disk_size_gib must be one of: ${userPlan.valid_disk_sizes.join(", ")}` });
    }

    // Check RAM quota (only running/creating VMs count)
    const currentRam = getDatabase().getUserProvisionedRam(request.userId);
    if (currentRam + memSizeMib > userPlan.max_ram_mib) {
      return reply.status(400).send({
        error: "RAM quota exceeded",
        current_ram_mib: currentRam,
        requested_ram_mib: memSizeMib,
        max_ram_mib: userPlan.max_ram_mib,
        plan: userPlan.plan,
      });
    }

    // Check disk quota (all non-error VMs count — disk persists even when snapshotted)
    const currentDisk = getDatabase().getUserProvisionedDisk(request.userId);
    if (currentDisk + diskSizeGib > userPlan.max_disk_gib) {
      return reply.status(400).send({
        error: "Disk quota exceeded",
        current_disk_gib: currentDisk,
        requested_disk_gib: diskSizeGib,
        max_disk_gib: userPlan.max_disk_gib,
        plan: userPlan.plan,
      });
    }

    // Check monthly data transfer quota
    const dataUsage = getDatabase().getUserMonthlyDataUsage(request.userId);
    if (dataUsage >= userPlan.max_data_bytes) {
      return reply.status(400).send({
        error: "Monthly data transfer limit reached",
        data_used_bytes: dataUsage,
        data_max_bytes: userPlan.max_data_bytes,
        plan: userPlan.plan,
      });
    }

    // Resolve image (distro) — default to alpine
    const image = body.image || "alpine";
    let imageVersion = 1;
    try {
      const available = getVMEngine().getAvailableImages();
      const imageInfo = available.find((i) => i.distro === image);
      if (!imageInfo) {
        return reply.status(400).send({ error: `Unknown image: ${image}. Available: ${available.map((i) => i.distro).join(", ")}` });
      }
      imageVersion = imageInfo.version;
    } catch {
      // If manifest is unavailable, allow creation with defaults
    }

    const slug = `vm-${generateSlug()}`;
    const { appPort, sshPort, opencodePort, vsockCid, vmIp, vmIpv6, vmIpv6Internal } = getVMEngine().allocateResources();

    // GitHub repo is optional — if provided, VM will clone it
    const repoFullName = body.gh_repo || null;

    // Fetch user's SSH keys (GitHub + custom)
    const user = getDatabase().findUserById(request.userId);
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
    getDatabase().insertVM({
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
      status_detail: null,
      mem_size_mib: memSizeMib,
      disk_size_gib: diskSizeGib,
      image,
      image_version: imageVersion,
      vm_ipv6: vmIpv6,
    });

    // Grant owner access (used by auth verify for subdomain gating)
    getDatabase().grantAccess(slug, request.userId, "owner");

    // Bind wake-on-connect proxies (IPv6 + app ports)
    if (vmIpv6) {
      bindWakeProxy(slug, vmIpv6, []);
    }
    bindAppWakeProxy(slug, appPort, opencodePort);

    // Return immediately — VM creation happens in the background.
    // Dashboard polls GET /vms/:id for status + status_detail.
    reply.status(201).send({
      id: slug,
      name: body.name,
      url: `http://${body.name}.${getBaseDomain()}`,
      ...(repoFullName ? { repo_url: `https://github.com/${repoFullName}` } : {}),
      ssh_command: `ssh ${body.name}@ssh.${getBaseDomain()}`,
      ssh_port: sshPort,
      status: "creating",
    });

    // Background VM creation with real progress updates
    const userId = request.userId;
    (async () => {
      try {
        // Call lifecycle hook for extra kernel args (e.g. LiteLLM config injection)
        let extraKernelArgs: string[] = [];
        try {
          extraKernelArgs = await getLifecycleHook().getExtraKernelArgs?.({ vmId: slug, userId }) ?? [];
        } catch (err) {
          console.error(`[vm] Lifecycle hook getExtraKernelArgs failed for ${slug}:`, err);
        }

        const vmId = await getVMEngine().createAndStartVM({
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
          vmIpv6,
          vmIpv6Internal,
          memSizeMib: memSizeMib,
          diskSizeGib: diskSizeGib,
          image,
          extraKernelArgs,
          onProgress: (detail: string) => {
            getDatabase().updateVMStatusDetail(slug, detail);
          },
        });
        getDatabase().updateVMInfo(slug, vmId, vmIp, vsockCid, null);

        // VM is booted and SSH-ready (vsock signal confirmed). Set running immediately.
        getDatabase().updateVMStatus(slug, "running");

        // Register Caddy route now that VM is running
        try {
          await getReverseProxy().addRoute(slug, appPort);
        } catch (err) {
          console.error(`[vm] Failed to register Caddy route for ${slug}:`, err);
        }

        getDatabase().emitAdminEvent("vm.created", slug, userId, { name: body.name, mem_size_mib: memSizeMib, disk_size_gib: diskSizeGib, ...(repoFullName ? { repo: repoFullName } : {}) });

        // Auto-create OpenCode session with initial prompt if provided
        const initialPrompt = body.initial_prompt?.trim();
        if (initialPrompt) {
          const safeName = (body.name || "workspace").toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "workspace";
          const cwd = `/home/dev/${safeName}`;
          agentManager.createSession(slug, "opencode", { cwd, prompt: initialPrompt }).catch((err) => {
            console.error(`[vm] Failed to auto-create OpenCode session for ${slug}:`, err);
          });
        }

        // Poll VM init progress in background (non-blocking) for dashboard status_detail
        const progressLabels: Record<string, string> = {
          cloning: "Cloning repository",
          installing: "Installing dependencies",
          building: "Building project",
          starting: "Starting server",
          ready: "Ready",
        };
        (async () => {
          let lastProgress = "";
          const maxWait = 5 * 60 * 1000;
          const start = Date.now();
          while (Date.now() - start < maxWait) {
            try {
              const raw = await getVMEngine().exec(slug, ["cat", "/tmp/init-progress"]);
              const progress = raw.trim();
              if (progress && progress !== lastProgress) {
                lastProgress = progress;
                if (progress.startsWith("error:")) {
                  getDatabase().updateVMStatusDetail(slug, `Error: ${progress.slice(6)}`);
                  break;
                }
                getDatabase().updateVMStatusDetail(slug, progressLabels[progress] || progress);
                if (progress === "ready") {
                  getDatabase().updateVMStatusDetail(slug, null);
                  break;
                }
              }
            } catch { /* SSH may not be ready yet */ }
            await new Promise((r) => setTimeout(r, 2000));
          }
        })().catch(() => {});
      } catch (err: any) {
        console.error(`[vm] Background VM creation failed for ${slug}:`, err);
        getDatabase().updateVMStatusDetail(slug, `Error: ${err.message}`);
        getDatabase().updateVMStatus(slug, "error");
        // Roll back DB records so ports/CIDs are freed for retry
        getDatabase().revokeAllAccess(slug);
        getDatabase().deleteVM(slug);
        const dataDir = process.env.DATA_DIR || "/data/envs";
        try { rmSync(join(dataDir, slug), { recursive: true, force: true }); } catch { /* ok */ }
      }
    })();
  });

  // List VMs for authenticated user
  app.get("/vms", async (request) => {
    const vms = getDatabase().findVMsByUser(request.userId);
    return {
      vms: vms.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        role: e.role,
        url: `http://${e.name}.${getBaseDomain()}`,
        ...(e.gh_repo ? { repo_url: `https://github.com/${e.gh_repo}` } : {}),
        created_at: e.created_at,
        mem_size_mib: e.mem_size_mib,
        disk_size_gib: e.disk_size_gib,
        image: e.image,
        image_version: e.image_version,
        is_public: !!e.is_public,
      })),
    };
  });

  // Check name availability
  app.get("/vms/check-name/:name", async (request) => {
    const { name } = request.params as { name: string };
    const validation = validateVMName(name);
    if (!validation.valid) {
      return { available: false, reason: validation.reason === "reserved" ? "reserved" : "invalid", message: validation.message };
    }
    const existing = getDatabase().findVMByName(name);
    if (existing) {
      return { available: false, reason: "taken", message: "Already taken" };
    }
    return { available: true };
  });

  // Get user's quota usage (RAM + data transfer + LLM)
  app.get("/vms/quota", async (request) => {
    const userPlan = getDatabase().getUserPlan(request.userId);
    const currentRam = getDatabase().getUserProvisionedRam(request.userId);
    const currentDisk = getDatabase().getUserProvisionedDisk(request.userId);
    const dataUsage = getDatabase().getUserMonthlyDataUsage(request.userId);

    const llmUsage = await getLifecycleHook().getLLMUsage?.(request.userId) ?? null;

    return {
      used_mib: currentRam,
      max_mib: userPlan.max_ram_mib,
      available_mib: userPlan.max_ram_mib - currentRam,
      disk_used_gib: currentDisk,
      disk_max_gib: userPlan.max_disk_gib,
      disk_available_gib: userPlan.max_disk_gib - currentDisk,
      valid_disk_sizes: userPlan.valid_disk_sizes,
      data_used_bytes: dataUsage,
      data_max_bytes: userPlan.max_data_bytes,
      data_used_pct: Math.round((dataUsage / userPlan.max_data_bytes) * 100),
      plan: userPlan.plan,
      plan_label: userPlan.label,
      valid_mem_sizes: userPlan.valid_mem_sizes,
      trial_active: userPlan.trial_active,
      trial_expires_at: userPlan.trial_expires_at,
      ...(llmUsage ? {
        llm_spend: llmUsage.spend,
        llm_budget: llmUsage.budget,
        llm_used_pct: Math.round((llmUsage.spend / llmUsage.budget) * 100),
      } : {}),
    };
  });

  // Get VM details
  app.get("/vms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    // Auto-wake snapshotted VMs when detail page is loaded
    let quotaError: { message: string; current_ram_mib: number; vm_ram_mib: number; max_ram_mib: number; plan: string } | undefined;
    let dataQuotaError: { message: string; data_used_bytes: number; data_max_bytes: number; plan: string } | undefined;
    let diskQuotaError: { message: string; used_gib: number; vm_gib: number; max_gib: number; plan: string } | undefined;
    if (vm.status === "snapshotted" || vm.status === "paused") {
      try {
        await ensureVMRunning(vm.id);
      } catch (err: any) {
        if (err instanceof QuotaExceededError) {
          quotaError = { message: err.message, current_ram_mib: err.current_ram_mib, vm_ram_mib: err.vm_ram_mib, max_ram_mib: err.max_ram_mib, plan: err.plan };
        } else if (err instanceof DiskQuotaExceededError) {
          diskQuotaError = { message: err.message, used_gib: err.used_gib, vm_gib: err.vm_gib, max_gib: err.max_gib, plan: err.plan };
        } else if (err instanceof DataQuotaExceededError) {
          dataQuotaError = { message: err.message, data_used_bytes: err.used_bytes, data_max_bytes: err.max_bytes, plan: err.plan };
        } else {
          console.error(`[wake] Background wake failed for ${id}:`, err);
          request.log.error({ err, vmId: id }, "Background wake failed");
        }
      }
    }

    // Live VM status
    let vmStatus: { running: boolean; status: string; startedAt: string | null; vsockCid: number } | null = null;
    try {
      vmStatus = await getVMEngine().inspectVM(vm.id);
    } catch {
      // VM may have been removed externally
    }

    return {
      id: vm.id,
      name: vm.name,
      status: vm.status,
      status_detail: vm.status_detail,
      url: `http://${vm.name}.${getBaseDomain()}`,
      ...(vm.gh_repo ? { repo_url: `https://github.com/${vm.gh_repo}` } : {}),
      ssh_command: `ssh ${vm.name}@ssh.${getBaseDomain()}`,
      ssh_port: vm.ssh_port,
      app_port: vm.app_port,
      opencode_port: vm.opencode_port,
      vm_status: vmStatus,
      role,
      created_at: vm.created_at,
      mem_size_mib: vm.mem_size_mib,
      disk_size_gib: vm.disk_size_gib,
      image: vm.image,
      image_version: vm.image_version,
      is_public: !!vm.is_public,
      vm_ipv6: vm.vm_ipv6 || null,
      ...(quotaError ? { quota_error: quotaError } : {}),
      ...(diskQuotaError ? { disk_quota_error: diskQuotaError } : {}),
      ...(dataQuotaError ? { data_quota_error: dataQuotaError } : {}),
    };
  });

  // Destroy VM (owner only)
  app.delete("/vms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (role !== "owner") {
      return reply.status(403).send({ error: "Only the owner can delete a VM" });
    }

    // Call lifecycle hook before destroy (e.g. cleanup external resources)
    try {
      await getLifecycleHook().onVMDestroy?.({ vmId: id, userId: request.userId });
    } catch (err) {
      console.error(`[vm] Lifecycle hook onVMDestroy failed for ${id}:`, err);
    }

    // Tear down wake-on-connect proxies
    unbindWakeProxy(id);
    unbindAppWakeProxy(id);

    // Cleanup VM (best-effort) — includes TAP, iptables DNAT, IPv6 firewall + NAT
    try {
      await getVMEngine().removeVMFull(
        id,
        vm.vm_ip || "",
        vm.app_port,
        vm.ssh_port,
        vm.opencode_port,
        vm.vm_ipv6,
        vm.vsock_cid ?? undefined,
      );
    } catch { /* may already be stopped/removed */ }

    // Cleanup Caddy route (best-effort)
    try { await getReverseProxy().removeRoute(id); } catch { /* may not exist */ }

    // Cleanup DB (order matters: messages → sessions → access → VM)
    getDatabase().deleteAgentSessionsByVM(id);
    getDatabase().revokeAllAccess(id);
    getDatabase().deleteVM(id);

    // Cleanup data directory (rootfs, snapshots, overlay, etc.)
    const dataDir = process.env.DATA_DIR || "/data/envs";
    const vmDataPath = join(dataDir, id);
    try { rmSync(vmDataPath, { recursive: true, force: true }); } catch { /* best-effort */ }

    getDatabase().emitAdminEvent("vm.deleted", id, request.userId);

    return { ok: true, message: `VM ${id} destroyed` };
  });

  // Pause (snapshot) VM
  app.post("/vms/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (role !== "owner") {
      return reply.status(403).send({ error: "Only the owner can pause a VM" });
    }

    if (vm.status !== "running") {
      return reply.status(400).send({ error: `Cannot pause VM in '${vm.status}' state` });
    }

    try {
      await getVMEngine().snapshotVM(id);
      const snapshotPath = `${process.env.DATA_DIR || "/data/vms"}/${id}/snapshot`;
      getDatabase().updateVMSnapshotPath(id, snapshotPath);
      getDatabase().updateVMStatus(id, "snapshotted");

      // Caddy route stays — wake-proxy on appPort handles connections while snapshotted

      getDatabase().emitAdminEvent("vm.paused", id, request.userId);

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
    const sourceVM = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!sourceVM) {
      return reply.status(404).send({ error: "Source VM not found" });
    }

    const role = getDatabase().checkAccess(sourceVM.id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    if (sourceVM.status !== "running" && sourceVM.status !== "snapshotted" && sourceVM.status !== "paused") {
      return reply.status(400).send({ error: `Cannot clone VM in '${sourceVM.status}' state` });
    }

    if (!getVMEngine().hasRootfs(id)) {
      return reply.status(400).send({ error: "Source VM has no rootfs to clone" });
    }

    const cloneMemSize = sourceVM.mem_size_mib;
    const cloneDiskSize = sourceVM.disk_size_gib;
    const userPlan = getDatabase().getUserPlan(request.userId);
    const currentRam = getDatabase().getUserProvisionedRam(request.userId);
    if (currentRam + cloneMemSize > userPlan.max_ram_mib) {
      return reply.status(400).send({
        error: "RAM quota exceeded",
        current_ram_mib: currentRam,
        requested_ram_mib: cloneMemSize,
        max_ram_mib: userPlan.max_ram_mib,
        plan: userPlan.plan,
      });
    }

    // Check disk quota
    const currentDisk = getDatabase().getUserProvisionedDisk(request.userId);
    if (currentDisk + cloneDiskSize > userPlan.max_disk_gib) {
      return reply.status(400).send({
        error: "Disk quota exceeded",
        current_disk_gib: currentDisk,
        requested_disk_gib: cloneDiskSize,
        max_disk_gib: userPlan.max_disk_gib,
        plan: userPlan.plan,
      });
    }

    // Check monthly data transfer quota
    const dataUsage = getDatabase().getUserMonthlyDataUsage(request.userId);
    if (dataUsage >= userPlan.max_data_bytes) {
      return reply.status(400).send({
        error: "Monthly data transfer limit reached",
        data_used_bytes: dataUsage,
        data_max_bytes: userPlan.max_data_bytes,
        plan: userPlan.plan,
      });
    }

    // Require a valid name for the clone
    const cloneName = body.name || `${sourceVM.name}-copy`;
    const cloneNameValidation = validateVMName(cloneName);
    if (!cloneNameValidation.valid) {
      return reply.status(400).send({ error: cloneNameValidation.message });
    }
    if (getDatabase().findVMByName(cloneName)) {
      return reply.status(409).send({ error: "Name already taken" });
    }

    const slug = `vm-${generateSlug()}`;
    const { appPort, sshPort, opencodePort, vsockCid, vmIp, vmIpv6, vmIpv6Internal } = getVMEngine().allocateResources();

    // Fetch cloning user's SSH keys (not source's)
    const user = getDatabase().findUserById(request.userId);
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

    // Clone disk files (handles pause/resume of source VM)
    try {
      await getVMEngine().cloneDisks(id, slug);
    } catch (err: any) {
      request.log.error({ err, sourceId: id, targetSlug: slug }, "Failed to copy disk files for clone");
      return reply.status(500).send({ error: "Failed to copy disk files", details: err.message });
    }

    // Insert VM record (reserves ports/CID)
    getDatabase().insertVM({
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
      status_detail: null,
      mem_size_mib: cloneMemSize,
      disk_size_gib: cloneDiskSize,
      image: sourceVM.image,
      image_version: sourceVM.image_version,
      vm_ipv6: vmIpv6,
    });
    getDatabase().grantAccess(slug, request.userId, "owner");

    // Bind wake-on-connect proxies (IPv6 + app ports)
    if (vmIpv6) {
      bindWakeProxy(slug, vmIpv6, []);
    }
    bindAppWakeProxy(slug, appPort, opencodePort);

    // Boot new VM from copied disks (createAndStartVM skips rootfs/data creation if files exist)
    try {
      const vmId = await getVMEngine().createAndStartVM({
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
        vmIpv6,
        vmIpv6Internal,
        memSizeMib: cloneMemSize,
      });
      getDatabase().updateVMInfo(slug, vmId, vmIp, vsockCid, null);
    } catch (err: any) {
      getDatabase().revokeAllAccess(slug);
      getDatabase().deleteVM(slug);
      try { getVMEngine().removeVM(slug); } catch { /* ok */ }
      request.log.error({ err, slug }, "Failed to create cloned VM");
      return reply.status(500).send({ error: "Failed to create cloned VM", details: err.message });
    }

    getDatabase().updateVMStatus(slug, "running");

    try {
      await getReverseProxy().addRoute(slug, appPort);
    } catch (err) {
      request.log.warn({ err, slug }, "Failed to register Caddy route for clone");
    }

    getDatabase().emitAdminEvent("vm.cloned", slug, request.userId, { source: id, name: cloneName });

    return reply.status(201).send({
      id: slug,
      name: cloneName,
      url: `http://${cloneName}.${getBaseDomain()}`,
      ...(sourceVM.gh_repo ? { repo_url: `https://github.com/${sourceVM.gh_repo}` } : {}),
      ssh_command: `ssh ${cloneName}@ssh.${getBaseDomain()}`,
      ssh_port: sshPort,
      status: "running",
    });
  });

  // Status page (Caddy fallback for 502/503)
  app.get("/vms/:id/status-page", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);

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

    // If snapshotted, trigger a wake and redirect back to the VM's subdomain
    let isQuotaError = false;
    if (vm && (status === "snapshotted" || status === "paused")) {
      try {
        await ensureVMRunning(id);
        // VM is now running — redirect back so Caddy proxies to the actual app
        const baseDomain = getBaseDomain();
        const scheme = baseDomain === "localhost" ? "http" : "https";
        return reply.redirect(`${scheme}://${vm!.name}.${baseDomain}/`);
      } catch (err: any) {
        if (err instanceof QuotaExceededError) {
          isQuotaError = true;
          statusMessage = "over your plan's RAM limit";
        } else if (err instanceof DiskQuotaExceededError) {
          isQuotaError = true;
          statusMessage = "over your plan's disk limit";
        } else if (err instanceof DataQuotaExceededError) {
          isQuotaError = true;
          statusMessage = "over your plan's monthly data transfer limit";
        } else {
          request.log.error({ err, id }, "Failed to wake VM from status page");
        }
      }
    }

    // Auto-refresh only for "creating" (snapshotted/paused now redirect after wake)
    const shouldAutoRefresh = !isQuotaError && status === "creating";

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
    const user = getDatabase().findUserById(userId);
    const parts: string[] = [];

    if (user?.github_username) {
      const ghKeys = await fetchSshKeys(user.github_username);
      if (ghKeys) parts.push(ghKeys);
    }
    if (user?.ssh_public_keys) {
      parts.push(user.ssh_public_keys);
    }

    // Always include the internal key
    parts.push(getVMEngine().getInternalSshPubKey());

    return dedupeKeys(parts.join("\n"));
  }

  // Check if SSH keys are already synced to the VM
  app.get("/vms/:id/ssh-keys-status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    if (vm.status !== "running" || !vm.vm_ip) {
      return { synced: false, reason: "not_running" };
    }

    try {
      const desiredKeys = await gatherUserKeys(request.userId);
      const currentRaw = await getVMEngine().exec(vm.id, [
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
    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    if (vm.status !== "running" || !vm.vm_ip) {
      return reply.status(400).send({ error: "VM is not running" });
    }

    const allKeys = await gatherUserKeys(request.userId);
    const keysB64 = Buffer.from(allKeys).toString("base64");

    try {
      await getVMEngine().exec(vm.id, [
        "sh", "-c",
        `echo '${keysB64}' | base64 -d > /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys`,
      ]);
      return { ok: true, message: "SSH keys synced to VM" };
    } catch (err: any) {
      request.log.error({ err, id }, "Failed to sync SSH keys");
      return reply.status(500).send({ error: "Failed to sync SSH keys", details: err.message });
    }
  });

  // Available rootfs images (no auth required — used by create form)
  app.get("/images", async () => {
    const distroLabels: Record<string, string> = {
      alpine: "Alpine Linux (faster boot)",
      ubuntu: "Ubuntu (glibc)",
    };

    try {
      const available = getVMEngine().getAvailableImages();
      return {
        images: available.map((img) => ({
          distro: img.distro,
          label: distroLabels[img.distro] || img.distro,
          distro_version: img.distro_version,
          node_version: img.node_version,
        })),
        default: "alpine",
      };
    } catch {
      return {
        images: [{ distro: "alpine", label: distroLabels.alpine, distro_version: "", node_version: "" }],
        default: "alpine",
      };
    }
  });
}
