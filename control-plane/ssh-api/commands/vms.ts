import { customAlphabet } from "nanoid";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { CommandContext } from "../dispatcher.js";
import { writeJson, writeError } from "../dispatcher.js";
import { getDatabase, getVMEngine, getReverseProxy } from "../../adapters/providers.js";
import { fetchSshKeys } from "../../services/github.js";
import { ensureVMRunning, QuotaExceededError } from "../../services/wake.js";

const generateSlug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

function getBaseDomain(): string {
  return process.env.BASE_DOMAIN || "localhost";
}

export async function handleVMsCommand(ctx: CommandContext): Promise<void> {
  const { args, flags, user, channel } = ctx;

  // No subcommand: list VMs
  if (args.length === 0) {
    return listVMs(ctx);
  }

  // "vms create --name foo"
  if (args[0] === "create") {
    return createVM(ctx);
  }

  // "vms <id> [action]"
  const vmId = args[0];
  const action = args[1] || "show";

  switch (action) {
    case "show":
      return showVM(vmId, ctx);
    case "delete":
    case "rm":
    case "remove":
      return deleteVMCmd(vmId, ctx);
    case "start":
    case "wake":
      return startVM(vmId, ctx);
    case "stop":
    case "snapshot":
      return stopVM(vmId, ctx);
    default:
      writeError(channel, `Unknown action: ${action}. Try: show, delete, start, stop`);
      channel.exit(1);
      channel.close();
  }
}

async function listVMs(ctx: CommandContext): Promise<void> {
  const vms = getDatabase().findVMsByUser(ctx.user.userId);
  const result = vms.map((e) => ({
    id: e.id,
    name: e.name,
    status: e.status,
    role: e.role,
    url: `https://${e.id}.${getBaseDomain()}`,
    ssh_command: `ssh ${e.id}@ssh.${getBaseDomain()}`,
    created_at: e.created_at,
    mem_size_mib: e.mem_size_mib,
  }));

  writeJson(ctx.channel, result);
  ctx.channel.exit(0);
  ctx.channel.close();
}

async function showVM(vmId: string, ctx: CommandContext): Promise<void> {
  const vm = getDatabase().findVMById(vmId);
  if (!vm) {
    writeError(ctx.channel, `VM not found: ${vmId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  const role = getDatabase().checkAccess(vmId, ctx.user.userId);
  if (!role) {
    writeError(ctx.channel, `No access to VM: ${vmId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  writeJson(ctx.channel, {
    id: vm.id,
    name: vm.name,
    status: vm.status,
    role,
    url: `https://${vm.name}.${getBaseDomain()}`,
    ssh_command: `ssh ${vm.name}@ssh.${getBaseDomain()}`,
    ssh_port: vm.ssh_port,
    app_port: vm.app_port,
    created_at: vm.created_at,
    mem_size_mib: vm.mem_size_mib,
  });
  ctx.channel.exit(0);
  ctx.channel.close();
}

const DEFAULT_MEM_SIZE = 256;
const DEFAULT_DISK_SIZE = 1;

async function createVM(ctx: CommandContext): Promise<void> {
  const { flags, user, channel } = ctx;

  const name = typeof flags.name === "string" ? flags.name : null;
  if (!name || name.length < 1 || name.length > 64) {
    writeError(channel, "--name is required (1-64 chars). Usage: vms create --name <name> [--repo owner/repo] [--mem 512] [--disk 5]");
    channel.exit(1);
    channel.close();
    return;
  }

  const repoFullName = typeof flags.repo === "string" ? flags.repo : null;
  const memSizeMib = typeof flags.mem === "string" ? parseInt(flags.mem, 10) : DEFAULT_MEM_SIZE;
  const diskSizeGib = typeof flags.disk === "string" ? parseInt(flags.disk, 10) : DEFAULT_DISK_SIZE;

  // Validate plan + quota
  const userPlan = getDatabase().getUserPlan(user.userId);
  if (!userPlan.valid_mem_sizes.includes(memSizeMib)) {
    writeError(channel, `Invalid memory size. Valid options: ${userPlan.valid_mem_sizes.join(", ")} MiB`);
    channel.exit(1);
    channel.close();
    return;
  }
  if (!userPlan.valid_disk_sizes.includes(diskSizeGib)) {
    writeError(channel, `Invalid disk size. Valid options: ${userPlan.valid_disk_sizes.join(", ")} GiB`);
    channel.exit(1);
    channel.close();
    return;
  }

  const currentRam = getDatabase().getUserProvisionedRam(user.userId);
  if (currentRam + memSizeMib > userPlan.max_ram_mib) {
    writeError(channel, `RAM quota exceeded (${currentRam}/${userPlan.max_ram_mib} MiB used). Stop a VM or upgrade your plan.`);
    channel.exit(1);
    channel.close();
    return;
  }

  const currentDisk = getDatabase().getUserProvisionedDisk(user.userId);
  if (currentDisk + diskSizeGib > userPlan.max_disk_gib) {
    writeError(channel, `Disk quota exceeded (${currentDisk}/${userPlan.max_disk_gib} GiB used). Delete a VM or upgrade your plan.`);
    channel.exit(1);
    channel.close();
    return;
  }

  // Allocate resources
  const slug = `vm-${generateSlug()}`;
  const { appPort, sshPort, opencodePort, vsockCid, vmIp, vmIpv6, vmIpv6Internal } = getVMEngine().allocateResources();

  // Fetch SSH keys
  const dbUser = getDatabase().findUserById(user.userId);
  const keyParts: string[] = [];
  if (dbUser?.github_username) {
    const ghKeys = await fetchSshKeys(dbUser.github_username);
    if (ghKeys) keyParts.push(ghKeys);
  }
  if (dbUser?.ssh_public_keys) {
    keyParts.push(dbUser.ssh_public_keys);
  }
  const sshKeys = keyParts.join("\n");

  // GitHub token
  const ghToken = dbUser?.github_token || process.env.GH_PAT || null;
  if (repoFullName && !ghToken) {
    writeError(channel, "GitHub not connected. Connect your GitHub account first to use repo cloning.");
    channel.exit(1);
    channel.close();
    return;
  }

  const opencodePassword = generateSlug() + generateSlug() + generateSlug() + generateSlug();

  // Insert VM record (reserves ports/CID)
  getDatabase().insertVM({
    id: slug,
    name,
    owner_id: user.userId,
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
    image: "alpine",
    image_version: 1,
    vm_ipv6: vmIpv6,
  });
  getDatabase().grantAccess(slug, user.userId, "owner");

  channel.write(`Creating VM "${name}" (${memSizeMib} MiB RAM, ${diskSizeGib} GiB disk)...\r\n`);

  // Create VM
  try {
    const vmId = await getVMEngine().createAndStartVM({
      slug,
      name,
      appPort,
      sshPort,
      opencodePort,
      ghRepo: repoFullName || undefined,
      ghToken: ghToken || undefined,
      githubUsername: dbUser?.github_username || undefined,
      sshKeys,
      opencodePassword,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      vsockCid,
      vmIp,
      vmIpv6,
      vmIpv6Internal,
      memSizeMib,
    });
    getDatabase().updateVMInfo(slug, vmId, vmIp, vsockCid, null);
  } catch (err: any) {
    getDatabase().revokeAllAccess(slug);
    getDatabase().deleteVM(slug);
    writeError(channel, `Failed to create VM: ${err.message}`);
    channel.exit(2);
    channel.close();
    return;
  }

  getDatabase().updateVMStatus(slug, "running");

  // Register Caddy route (non-fatal)
  try {
    await getReverseProxy().addRoute(slug, appPort);
  } catch { /* non-fatal */ }

  getDatabase().emitAdminEvent("vm.created", slug, user.userId, { name, mem_size_mib: memSizeMib, ...(repoFullName ? { repo: repoFullName } : {}), source: "ssh" });

  const baseDomain = getBaseDomain();
  channel.write(`Ready.\r\n`);
  writeJson(channel, {
    id: slug,
    name,
    status: "running",
    url: `https://${name}.${baseDomain}`,
    ssh_command: `ssh ${name}@ssh.${baseDomain}`,
    ssh_port: sshPort,
    ...(repoFullName ? { repo_url: `https://github.com/${repoFullName}` } : {}),
  });
  channel.exit(0);
  channel.close();
}

async function deleteVMCmd(vmId: string, ctx: CommandContext): Promise<void> {
  const vm = getDatabase().findVMById(vmId);
  if (!vm) {
    writeError(ctx.channel, `VM not found: ${vmId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  const role = getDatabase().checkAccess(vmId, ctx.user.userId);
  if (role !== "owner") {
    writeError(ctx.channel, "Only the owner can delete a VM");
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  try {
    await getVMEngine().removeVMFull(
      vmId,
      vm.vm_ip || "",
      vm.app_port,
      vm.ssh_port,
      vm.opencode_port,
      vm.vm_ipv6,
      vm.vsock_cid ?? undefined,
    );
  } catch { /* may already be stopped */ }

  try { await getReverseProxy().removeRoute(vmId); } catch { /* may not exist */ }

  getDatabase().revokeAllAccess(vmId);
  getDatabase().deleteVM(vmId);

  // Cleanup data directory
  const dataDir = process.env.DATA_DIR || "/data/envs";
  try { rmSync(join(dataDir, vmId), { recursive: true, force: true }); } catch { /* best-effort */ }

  getDatabase().emitAdminEvent("vm.deleted", vmId, ctx.user.userId);

  writeJson(ctx.channel, { ok: true, message: `VM ${vmId} destroyed` });
  ctx.channel.exit(0);
  ctx.channel.close();
}

async function startVM(vmId: string, ctx: CommandContext): Promise<void> {
  const vm = getDatabase().findVMById(vmId);
  if (!vm) {
    writeError(ctx.channel, `VM not found: ${vmId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  const role = getDatabase().checkAccess(vmId, ctx.user.userId);
  if (!role) {
    writeError(ctx.channel, `No access to VM: ${vmId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  try {
    await ensureVMRunning(vmId);
    writeJson(ctx.channel, { ok: true, status: "running", message: `VM ${vmId} is running` });
    ctx.channel.exit(0);
  } catch (err: any) {
    if (err instanceof QuotaExceededError) {
      writeError(ctx.channel, `RAM quota exceeded. Stop another VM or upgrade your plan.`);
    } else {
      writeError(ctx.channel, `Failed to start: ${err.message}`);
    }
    ctx.channel.exit(1);
  }
  ctx.channel.close();
}

async function stopVM(vmId: string, ctx: CommandContext): Promise<void> {
  const vm = getDatabase().findVMById(vmId);
  if (!vm) {
    writeError(ctx.channel, `VM not found: ${vmId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  const role = getDatabase().checkAccess(vmId, ctx.user.userId);
  if (role !== "owner" && role !== "editor") {
    writeError(ctx.channel, "Only the owner or editors can stop a VM");
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  try {
    await getVMEngine().snapshotVM(vmId);
    writeJson(ctx.channel, { ok: true, status: "snapshotted", message: `VM ${vmId} snapshotted` });
    ctx.channel.exit(0);
  } catch (err: any) {
    writeError(ctx.channel, `Failed to stop: ${err.message}`);
    ctx.channel.exit(1);
  }
  ctx.channel.close();
}
