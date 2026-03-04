import {
  findEnvById,
  updateEnvStatus,
  updateEnvSnapshotPath,
  updateEnvVmInfo,
} from "../db/client.js";
import { restoreVM, createAndStartVM, isVmRunning, getInternalSshPubKey } from "./firecracker.js";
import { addRoute } from "./caddy.js";
import { resetIdleTimer } from "./idle-monitor.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Wake-on-Request Service
 *
 * Ensures a VM is running before any operation proceeds. If the VM is
 * snapshotted, it restores from the snapshot. If the snapshot files are
 * missing, it creates a fresh VM. If already running, this is a no-op.
 *
 * Called by terminal, agent, and file routes before interacting with a VM.
 */

// Track in-progress wakes to avoid duplicate restores
const pendingWakes = new Map<string, Promise<void>>();

/**
 * Ensure a VM is running. Restores from snapshot if needed.
 * Returns immediately if VM is already running.
 * Coalesces concurrent wake requests for the same env.
 */
export async function ensureVMRunning(envId: string): Promise<void> {
  console.log(`[wake] ensureVMRunning called for ${envId}`);

  // Check if already running in memory
  if (isVmRunning(envId)) {
    console.log(`[wake] ${envId} already running in memory, skipping`);
    resetIdleTimer(envId);
    return;
  }

  const env = findEnvById(envId);
  if (!env) throw new Error("Environment not found");

  console.log(`[wake] ${envId} DB status=${env.status}, vmIp=${env.vm_ip}, vsockCid=${env.vsock_cid}`);

  // Already running according to DB and memory
  if (env.status === "running" && isVmRunning(envId)) {
    resetIdleTimer(envId);
    return;
  }

  // Not snapshotted — can't wake
  if (env.status !== "snapshotted" && env.status !== "paused") {
    if (env.status === "running") {
      // DB says running but VM process is gone — stale state
      console.warn(`[wake] ${envId} DB says running but VM not in memory (stale state)`);
      return;
    }
    console.warn(`[wake] ${envId} cannot wake from status: ${env.status}`);
    throw new Error(`Cannot wake VM in state: ${env.status}`);
  }

  // Coalesce concurrent wake requests
  const existing = pendingWakes.get(envId);
  if (existing) {
    console.log(`[wake] ${envId} already waking, coalescing request`);
    return existing;
  }

  console.log(`[wake] ${envId} starting wake...`);
  const wakePromise = doWake(envId, env);
  pendingWakes.set(envId, wakePromise);

  try {
    await wakePromise;
  } finally {
    pendingWakes.delete(envId);
  }
}

async function doWake(envId: string, env: ReturnType<typeof findEnvById>): Promise<void> {
  if (!env) throw new Error("Environment not found");
  if (!env.vsock_cid) throw new Error("Environment has no vsock CID");
  if (!env.vm_ip) throw new Error("Environment has no VM IP");

  // Check if snapshot files actually exist
  const dataDir = process.env.DATA_DIR || "/data/envs";
  const snapshotDir = join(dataDir, envId, "snapshot");
  const hasSnapshot = existsSync(join(snapshotDir, "vmstate")) && existsSync(join(snapshotDir, "memory"));

  updateEnvStatus(envId, "creating"); // Temporarily mark as creating

  try {
    if (hasSnapshot) {
      console.log(`[wake] Restoring VM ${envId} from snapshot...`);
      await restoreVM(
        envId,
        env.vsock_cid,
        env.vm_ip,
        env.app_port,
        env.ssh_port,
        env.opencode_port,
      );
      console.log(`[wake] VM ${envId} restored successfully`);
    } else {
      // Snapshot files missing — create a fresh VM instead
      console.log(`[wake] Snapshot files missing for ${envId}, creating fresh VM...`);
      await createFreshVM(envId, env, dataDir);
      console.log(`[wake] VM ${envId} created fresh (no snapshot to restore)`);
    }

    // Update DB state
    updateEnvStatus(envId, "running");
    updateEnvSnapshotPath(envId, null);

    // Re-register Caddy route
    try {
      await addRoute(envId, env.app_port);
    } catch (err) {
      console.warn(`[wake] Failed to re-register Caddy route for ${envId}: ${err}`);
    }

    // Reset idle timer so it doesn't immediately re-snapshot
    resetIdleTimer(envId);
  } catch (err: any) {
    updateEnvStatus(envId, "error");
    console.error(`[wake] Failed to wake VM ${envId}: ${err.message}`);
    throw err;
  }
}

/**
 * Create a fresh VM when snapshot files are missing.
 * Reuses the existing rootfs and data volume from the env's data dir.
 */
async function createFreshVM(
  envId: string,
  env: NonNullable<ReturnType<typeof findEnvById>>,
  dataDir: string,
): Promise<void> {
  // Read env config from the saved env.json
  const envConfigPath = join(dataDir, envId, "env.json");
  let envConfig: any = {};
  try {
    envConfig = JSON.parse(readFileSync(envConfigPath, "utf-8"));
  } catch {
    console.warn(`[wake] No env.json found for ${envId}, using defaults`);
  }

  await createAndStartVM({
    slug: envId,
    appPort: env.app_port,
    sshPort: env.ssh_port,
    opencodePort: env.opencode_port,
    ghRepo: envConfig.gh_repo || "",
    ghToken: envConfig.gh_token || "",
    sshKeys: envConfig.ssh_keys || "",
    opencodePassword: envConfig.opencode_password || "",
    openaiApiKey: envConfig.openai_api_key || "",
    anthropicApiKey: envConfig.anthropic_api_key || "",
    vsockCid: env.vsock_cid!,
    vmIp: env.vm_ip!,
  });
}
