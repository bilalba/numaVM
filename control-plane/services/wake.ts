import {
  findVMById,
  updateVMStatus,
  updateVMSnapshotPath,
  updateVMInfo,
  emitAdminEvent,
  getUserPlan,
  getUserProvisionedRam,
} from "../db/client.js";
import { restoreVM, createAndStartVM, isVmRunning, getInternalSshPubKey } from "./firecracker.js";
import { addRoute } from "./caddy.js";
import { resetIdleTimer } from "./idle-monitor.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class QuotaExceededError extends Error {
  current_ram_mib: number;
  vm_ram_mib: number;
  max_ram_mib: number;
  plan: string;

  constructor(current: number, vmRam: number, max: number, plan: string) {
    super(`RAM quota exceeded: ${current} MiB in use + ${vmRam} MiB needed > ${max} MiB limit (${plan} plan)`);
    this.name = "QuotaExceededError";
    this.current_ram_mib = current;
    this.vm_ram_mib = vmRam;
    this.max_ram_mib = max;
    this.plan = plan;
  }
}

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
 * Coalesces concurrent wake requests for the same VM.
 */
export async function ensureVMRunning(vmId: string): Promise<void> {
  console.log(`[wake] ensureVMRunning called for ${vmId}`);

  // Check if already running in memory
  if (isVmRunning(vmId)) {
    console.log(`[wake] ${vmId} already running in memory, skipping`);
    resetIdleTimer(vmId);
    return;
  }

  const vm = findVMById(vmId);
  if (!vm) throw new Error("VM not found");

  console.log(`[wake] ${vmId} DB status=${vm.status}, vmIp=${vm.vm_ip}, vsockCid=${vm.vsock_cid}`);

  // Already running according to DB and memory
  if (vm.status === "running" && isVmRunning(vmId)) {
    resetIdleTimer(vmId);
    return;
  }

  // Not snapshotted — can't wake
  if (vm.status !== "snapshotted" && vm.status !== "paused") {
    if (vm.status === "running") {
      // DB says running but VM process is gone — stale state
      console.warn(`[wake] ${vmId} DB says running but VM not in memory (stale state)`);
      return;
    }
    console.warn(`[wake] ${vmId} cannot wake from status: ${vm.status}`);
    throw new Error(`Cannot wake VM in state: ${vm.status}`);
  }

  // Check RAM quota before waking
  const userPlan = getUserPlan(vm.owner_id);
  const currentRam = getUserProvisionedRam(vm.owner_id);
  if (currentRam + vm.mem_size_mib > userPlan.max_ram_mib) {
    throw new QuotaExceededError(currentRam, vm.mem_size_mib, userPlan.max_ram_mib, userPlan.plan);
  }

  // Coalesce concurrent wake requests
  const existing = pendingWakes.get(vmId);
  if (existing) {
    console.log(`[wake] ${vmId} already waking, coalescing request`);
    return existing;
  }

  console.log(`[wake] ${vmId} starting wake...`);
  const wakePromise = doWake(vmId, vm);
  pendingWakes.set(vmId, wakePromise);

  try {
    await wakePromise;
  } finally {
    pendingWakes.delete(vmId);
  }
}

async function doWake(vmId: string, vm: ReturnType<typeof findVMById>): Promise<void> {
  if (!vm) throw new Error("VM not found");
  if (!vm.vsock_cid) throw new Error("VM has no vsock CID");
  if (!vm.vm_ip) throw new Error("VM has no IP address");

  // Check if snapshot files actually exist
  const dataDir = process.env.DATA_DIR || "/data/vms";
  const snapshotDir = join(dataDir, vmId, "snapshot");
  const hasSnapshot = existsSync(join(snapshotDir, "vmstate")) && existsSync(join(snapshotDir, "memory"));

  updateVMStatus(vmId, "creating"); // Temporarily mark as creating

  try {
    if (hasSnapshot) {
      console.log(`[wake] Restoring VM ${vmId} from snapshot...`);
      await restoreVM(
        vmId,
        vm.vsock_cid,
        vm.vm_ip,
        vm.app_port,
        vm.ssh_port,
        vm.opencode_port,
      );
      console.log(`[wake] VM ${vmId} restored successfully`);
    } else {
      // Snapshot files missing — create a fresh VM instead
      console.log(`[wake] Snapshot files missing for ${vmId}, creating fresh VM...`);
      await createFreshVM(vmId, vm, dataDir);
      console.log(`[wake] VM ${vmId} created fresh (no snapshot to restore)`);
    }

    // Update DB state
    updateVMStatus(vmId, "running");
    updateVMSnapshotPath(vmId, null);

    // Re-register Caddy route
    try {
      await addRoute(vmId, vm.app_port);
    } catch (err) {
      console.warn(`[wake] Failed to re-register Caddy route for ${vmId}: ${err}`);
    }

    emitAdminEvent("vm.woke", vmId, null, { hadSnapshot: hasSnapshot });

    // Reset idle timer so it doesn't immediately re-snapshot
    resetIdleTimer(vmId);
  } catch (err: any) {
    updateVMStatus(vmId, "error");
    console.error(`[wake] Failed to wake VM ${vmId}: ${err.message}`);
    throw err;
  }
}

/**
 * Create a fresh VM when snapshot files are missing.
 * Reuses the existing rootfs and data volume from the VM's data dir.
 */
async function createFreshVM(
  vmId: string,
  vm: NonNullable<ReturnType<typeof findVMById>>,
  dataDir: string,
): Promise<void> {
  // Read VM config from the saved vm.json
  const vmConfigPath = join(dataDir, vmId, "env.json");
  let vmConfig: any = {};
  try {
    vmConfig = JSON.parse(readFileSync(vmConfigPath, "utf-8"));
  } catch {
    console.warn(`[wake] No env.json found for ${vmId}, using defaults`);
  }

  await createAndStartVM({
    slug: vmId,
    name: vm.name,
    appPort: vm.app_port,
    sshPort: vm.ssh_port,
    opencodePort: vm.opencode_port,
    ghRepo: vmConfig.gh_repo || "",
    ghToken: vmConfig.gh_token || "",
    sshKeys: vmConfig.ssh_keys || "",
    opencodePassword: vmConfig.opencode_password || "",
    openaiApiKey: vmConfig.openai_api_key || "",
    anthropicApiKey: vmConfig.anthropic_api_key || "",
    vsockCid: vm.vsock_cid!,
    vmIp: vm.vm_ip!,
    memSizeMib: vm.mem_size_mib,
  });
}
