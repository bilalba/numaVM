import {
  findEnvById,
  updateEnvStatus,
  updateEnvSnapshotPath,
  updateEnvVmInfo,
} from "../db/client.js";
import { restoreVM, isVmRunning } from "./firecracker.js";
import { addRoute } from "./caddy.js";
import { resetIdleTimer } from "./idle-monitor.js";

/**
 * Wake-on-Request Service
 *
 * Ensures a VM is running before any operation proceeds. If the VM is
 * snapshotted, it restores from the snapshot. If already running, this
 * is a no-op.
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
  // Check if already running
  if (isVmRunning(envId)) {
    resetIdleTimer(envId);
    return;
  }

  const env = findEnvById(envId);
  if (!env) throw new Error("Environment not found");

  // Already running according to DB
  if (env.status === "running" && isVmRunning(envId)) {
    resetIdleTimer(envId);
    return;
  }

  // Not snapshotted — can't wake
  if (env.status !== "snapshotted" && env.status !== "paused") {
    if (env.status === "running") {
      // DB says running but VM is gone — this is stale state
      // Let the caller handle it
      return;
    }
    throw new Error(`Cannot wake VM in state: ${env.status}`);
  }

  // Coalesce concurrent wake requests
  const existing = pendingWakes.get(envId);
  if (existing) {
    return existing;
  }

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

  console.log(`[wake] Restoring VM ${envId} from snapshot...`);

  updateEnvStatus(envId, "creating"); // Temporarily mark as creating

  try {
    await restoreVM(
      envId,
      env.vsock_cid,
      env.vm_ip,
      env.app_port,
      env.ssh_port,
      env.opencode_port,
    );

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

    console.log(`[wake] VM ${envId} restored successfully`);
  } catch (err: any) {
    updateEnvStatus(envId, "error");
    console.error(`[wake] Failed to restore VM ${envId}: ${err.message}`);
    throw err;
  }
}
