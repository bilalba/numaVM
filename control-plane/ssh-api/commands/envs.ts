import { customAlphabet } from "nanoid";
import type { CommandContext } from "../dispatcher.js";
import { writeJson, writeError } from "../dispatcher.js";
import {
  findEnvsByUser,
  findEnvById,
  findUserById,
  checkAccess,
  insertEnv,
  updateEnvStatus,
  updateEnvVmInfo,
  deleteEnv,
  grantAccess,
  revokeAllAccess,
  emitAdminEvent,
  getUserPlan,
  getUserProvisionedRam,
} from "../../db/client.js";
import {
  createAndStartVM,
  removeVMFull,
  snapshotVM,
} from "../../services/firecracker.js";
import { allocatePorts, allocateCid, cidToVmIp } from "../../services/port-allocator.js";
import { fetchSshKeys } from "../../services/github.js";
import { ensureVMRunning, QuotaExceededError } from "../../services/wake.js";
import { addRoute, removeRoute } from "../../services/caddy.js";

const generateSlug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

function getBaseDomain(): string {
  return process.env.BASE_DOMAIN || "localhost";
}

export async function handleEnvsCommand(ctx: CommandContext): Promise<void> {
  const { args, flags, user, channel } = ctx;

  // No subcommand: list envs
  if (args.length === 0) {
    return listEnvs(ctx);
  }

  // "envs create --name foo"
  if (args[0] === "create") {
    return createEnv(ctx);
  }

  // "envs <id> [action]"
  const envId = args[0];
  const action = args[1] || "show";

  switch (action) {
    case "show":
      return showEnv(envId, ctx);
    case "delete":
    case "rm":
    case "remove":
      return deleteEnvCmd(envId, ctx);
    case "start":
    case "wake":
      return startEnv(envId, ctx);
    case "stop":
    case "snapshot":
      return stopEnv(envId, ctx);
    default:
      writeError(channel, `Unknown action: ${action}. Try: show, delete, start, stop`);
      channel.exit(1);
      channel.close();
  }
}

async function listEnvs(ctx: CommandContext): Promise<void> {
  const envs = findEnvsByUser(ctx.user.userId);
  const result = envs.map((e) => ({
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

async function showEnv(envId: string, ctx: CommandContext): Promise<void> {
  const env = findEnvById(envId);
  if (!env) {
    writeError(ctx.channel, `Environment not found: ${envId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  const role = checkAccess(envId, ctx.user.userId);
  if (!role) {
    writeError(ctx.channel, `No access to environment: ${envId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  writeJson(ctx.channel, {
    id: env.id,
    name: env.name,
    status: env.status,
    role,
    url: `https://${env.id}.${getBaseDomain()}`,
    ssh_command: `ssh ${env.id}@ssh.${getBaseDomain()}`,
    ssh_port: env.ssh_port,
    app_port: env.app_port,
    created_at: env.created_at,
    mem_size_mib: env.mem_size_mib,
  });
  ctx.channel.exit(0);
  ctx.channel.close();
}

const DEFAULT_MEM_SIZE = 512;

async function createEnv(ctx: CommandContext): Promise<void> {
  const { flags, user, channel } = ctx;

  const name = typeof flags.name === "string" ? flags.name : null;
  if (!name || name.length < 1 || name.length > 64) {
    writeError(channel, "--name is required (1-64 chars). Usage: envs create --name <name> [--repo owner/repo] [--mem 512]");
    channel.exit(1);
    channel.close();
    return;
  }

  const repoFullName = typeof flags.repo === "string" ? flags.repo : null;
  const memSizeMib = typeof flags.mem === "string" ? parseInt(flags.mem, 10) : DEFAULT_MEM_SIZE;

  // Validate plan + quota
  const userPlan = getUserPlan(user.userId);
  if (!userPlan.valid_mem_sizes.includes(memSizeMib)) {
    writeError(channel, `Invalid memory size. Valid options: ${userPlan.valid_mem_sizes.join(", ")} MiB`);
    channel.exit(1);
    channel.close();
    return;
  }

  const currentRam = getUserProvisionedRam(user.userId);
  if (currentRam + memSizeMib > userPlan.max_ram_mib) {
    writeError(channel, `RAM quota exceeded (${currentRam}/${userPlan.max_ram_mib} MiB used). Stop an environment or upgrade your plan.`);
    channel.exit(1);
    channel.close();
    return;
  }

  // Allocate resources
  const slug = `env-${generateSlug()}`;
  const { appPort, sshPort, opencodePort } = allocatePorts();
  const vsockCid = allocateCid();
  const vmIp = cidToVmIp(vsockCid);

  // Fetch SSH keys
  const dbUser = findUserById(user.userId);
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

  // Insert env record (reserves ports/CID)
  insertEnv({
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
    mem_size_mib: memSizeMib,
  });
  grantAccess(slug, user.userId, "owner");

  channel.write(`Creating environment "${name}" (${memSizeMib} MiB)...\r\n`);

  // Create VM
  try {
    const vmId = await createAndStartVM({
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
      memSizeMib,
    });
    updateEnvVmInfo(slug, vmId, vmIp, vsockCid, null);
  } catch (err: any) {
    revokeAllAccess(slug);
    deleteEnv(slug);
    writeError(channel, `Failed to create VM: ${err.message}`);
    channel.exit(2);
    channel.close();
    return;
  }

  updateEnvStatus(slug, "running");

  // Register Caddy route (non-fatal)
  try {
    await addRoute(slug, appPort);
  } catch { /* non-fatal */ }

  emitAdminEvent("vm.created", slug, user.userId, { name, mem_size_mib: memSizeMib, ...(repoFullName ? { repo: repoFullName } : {}), source: "ssh" });

  const baseDomain = getBaseDomain();
  channel.write(`Ready.\r\n`);
  writeJson(channel, {
    id: slug,
    name,
    status: "running",
    url: `https://${slug}.${baseDomain}`,
    ssh_command: `ssh ${slug}@ssh.${baseDomain}`,
    ssh_port: sshPort,
    ...(repoFullName ? { repo_url: `https://github.com/${repoFullName}` } : {}),
  });
  channel.exit(0);
  channel.close();
}

async function deleteEnvCmd(envId: string, ctx: CommandContext): Promise<void> {
  const env = findEnvById(envId);
  if (!env) {
    writeError(ctx.channel, `Environment not found: ${envId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  const role = checkAccess(envId, ctx.user.userId);
  if (role !== "owner") {
    writeError(ctx.channel, "Only the owner can delete an environment");
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  try {
    await removeVMFull(
      envId,
      env.vm_ip || cidToVmIp(env.vsock_cid || 3),
      env.app_port,
      env.ssh_port,
      env.opencode_port,
    );
  } catch { /* may already be stopped */ }

  try { await removeRoute(envId); } catch { /* may not exist */ }

  revokeAllAccess(envId);
  deleteEnv(envId);
  emitAdminEvent("vm.deleted", envId, ctx.user.userId);

  writeJson(ctx.channel, { ok: true, message: `Environment ${envId} destroyed` });
  ctx.channel.exit(0);
  ctx.channel.close();
}

async function startEnv(envId: string, ctx: CommandContext): Promise<void> {
  const env = findEnvById(envId);
  if (!env) {
    writeError(ctx.channel, `Environment not found: ${envId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  const role = checkAccess(envId, ctx.user.userId);
  if (!role) {
    writeError(ctx.channel, `No access to environment: ${envId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  try {
    await ensureVMRunning(envId);
    writeJson(ctx.channel, { ok: true, status: "running", message: `Environment ${envId} is running` });
    ctx.channel.exit(0);
  } catch (err: any) {
    if (err instanceof QuotaExceededError) {
      writeError(ctx.channel, `RAM quota exceeded. Stop another environment or upgrade your plan.`);
    } else {
      writeError(ctx.channel, `Failed to start: ${err.message}`);
    }
    ctx.channel.exit(1);
  }
  ctx.channel.close();
}

async function stopEnv(envId: string, ctx: CommandContext): Promise<void> {
  const env = findEnvById(envId);
  if (!env) {
    writeError(ctx.channel, `Environment not found: ${envId}`);
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  const role = checkAccess(envId, ctx.user.userId);
  if (role !== "owner" && role !== "editor") {
    writeError(ctx.channel, "Only the owner or editors can stop an environment");
    ctx.channel.exit(1);
    ctx.channel.close();
    return;
  }

  try {
    await snapshotVM(envId);
    writeJson(ctx.channel, { ok: true, status: "snapshotted", message: `Environment ${envId} snapshotted` });
    ctx.channel.exit(0);
  } catch (err: any) {
    writeError(ctx.channel, `Failed to stop: ${err.message}`);
    ctx.channel.exit(1);
  }
  ctx.channel.close();
}
