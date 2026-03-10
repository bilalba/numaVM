import { readFileSync } from "node:fs";
import { getDatabase, getVMEngine, getReverseProxy } from "../adapters/providers.js";
import { agentManager } from "../agents/manager.js";

/**
 * Network Idle Monitor
 *
 * Polls TAP device traffic counters for each running VM. When a VM
 * transfers less than IDLE_THRESHOLD_BYTES (default 20 KB) within
 * IDLE_TIMEOUT_MS (default 2 min), it's snapshotted and freed.
 *
 * Traffic is measured via /sys/class/net/tap-{slug}/statistics/{rx,tx}_bytes.
 * Vsock traffic is not counted (it uses a separate virtio device).
 */

const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "120000", 10); // 2 min
const IDLE_THRESHOLD_BYTES = parseInt(process.env.IDLE_THRESHOLD_BYTES || "20480", 10); // 20 KB
const POLL_INTERVAL_MS = parseInt(process.env.IDLE_POLL_INTERVAL_MS || "30000", 10); // 30s

interface VMTraffic {
  /** Bytes snapshot taken at windowStart */
  windowBytes: number;
  /** When the current measurement window started */
  windowStart: number;
}

const trafficMap = new Map<string, VMTraffic>();
const snapshottingSet = new Set<string>(); // per-VM concurrency guard
let pollTimer: ReturnType<typeof setInterval> | null = null;

// Traffic recording: store deltas every poll (~30s)
const RECORD_INTERVAL = 1; // every poll
let pollCount = 0;
const lastRecordedBytes = new Map<string, { rx: number; tx: number }>();
let lastPruneTime = 0;

function readTapBytes(tapDev: string): number {
  try {
    const rx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/rx_bytes`, "utf-8").trim(), 10);
    const tx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/tx_bytes`, "utf-8").trim(), 10);
    return rx + tx;
  } catch {
    return -1; // TAP device doesn't exist or isn't readable
  }
}

async function pollOnce(): Promise<void> {
  const db = getDatabase();
  const engine = getVMEngine();
  const proxy = getReverseProxy();

  // Get all running VMs (with owner for data quota checks)
  const runningVMs = db.raw<{ id: string; vsock_cid: number; app_port: number; ssh_port: number; opencode_port: number; vm_ip: string; owner_id: string }>(
    "SELECT v.id, v.vsock_cid, v.app_port, v.ssh_port, v.opencode_port, v.vm_ip, va.user_id as owner_id FROM vms v INNER JOIN vm_access va ON va.vm_id = v.id AND va.role = 'owner' WHERE v.status = 'running'"
  );

  const now = Date.now();

  for (const vm of runningVMs) {
    const tapDev = `tap-${vm.id}`;
    const currentBytes = readTapBytes(tapDev);

    if (currentBytes < 0) continue; // TAP not available

    const prev = trafficMap.get(vm.id);

    if (!prev) {
      // First observation — start a measurement window
      trafficMap.set(vm.id, { windowBytes: currentBytes, windowStart: now });
      continue;
    }

    const windowDuration = now - prev.windowStart;

    if (windowDuration < IDLE_TIMEOUT_MS) {
      // Window still open, keep collecting
      continue;
    }

    // Window elapsed — check bytes transferred during the window
    const bytesInWindow = currentBytes - prev.windowBytes;

    if (bytesInWindow >= IDLE_THRESHOLD_BYTES) {
      // Enough traffic — reset the window
      trafficMap.set(vm.id, { windowBytes: currentBytes, windowStart: now });
      continue;
    }

    // Less than threshold transferred in the window — snapshot
    {
      // Skip if a snapshot is already in-flight for this VM
      if (snapshottingSet.has(vm.id)) {
        continue;
      }

      console.log(`[idle-monitor] VM ${vm.id} transferred only ${bytesInWindow} bytes in ${Math.round(windowDuration / 1000)}s (threshold: ${IDLE_THRESHOLD_BYTES}), snapshotting...`);

      snapshottingSet.add(vm.id);
      try {
        // Tear down agent bridges before snapshot so SSE disconnects
        // don't falsely mark idle sessions as "error"
        agentManager.destroyBridgesForVM(vm.id);

        // Snapshot the VM
        await engine.snapshotVM(vm.id);

        // Update DB
        const snapshotPath = `${process.env.DATA_DIR || "/data/vms"}/${vm.id}/snapshot`;
        db.updateVMSnapshotPath(vm.id, snapshotPath);
        db.updateVMStatus(vm.id, "snapshotted");

        // Caddy route stays — wake-proxy on appPort handles connections while snapshotted

        // Clean up traffic tracking
        trafficMap.delete(vm.id);

        db.emitAdminEvent("vm.idle_snapshotted", vm.id, null, { idleBytes: bytesInWindow, windowMs: windowDuration });
        console.log(`[idle-monitor] VM ${vm.id} snapshotted successfully`);
      } catch (err: any) {
        console.error(`[idle-monitor] Failed to snapshot VM ${vm.id}: ${err.message}`);
        // Reset the window so we don't immediately retry
        trafficMap.set(vm.id, { windowBytes: currentBytes, windowStart: now });
      } finally {
        snapshottingSet.delete(vm.id);
      }
    }
  }

  // Record traffic deltas every RECORD_INTERVAL polls (~5min)
  pollCount++;
  if (pollCount >= RECORD_INTERVAL) {
    pollCount = 0;
    for (const vm of runningVMs) {
      const tapDev = `tap-${vm.id}`;
      let rx = 0, tx = 0;
      try {
        rx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/rx_bytes`, "utf-8").trim(), 10);
        tx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/tx_bytes`, "utf-8").trim(), 10);
      } catch { continue; }

      const prev = lastRecordedBytes.get(vm.id);
      if (prev) {
        const deltaRx = Math.max(0, rx - prev.rx);
        const deltaTx = Math.max(0, tx - prev.tx);
        if (deltaRx > 0 || deltaTx > 0) {
          db.insertTrafficRecord(vm.id, deltaRx, deltaTx, vm.owner_id);
        }
      }
      lastRecordedBytes.set(vm.id, { rx, tx });
    }

    // Prune old records once per day
    const now = Date.now();
    if (now - lastPruneTime > 86400000) {
      lastPruneTime = now;
      const pruned = db.pruneOldTraffic(7);
      if (pruned > 0) {
        console.log(`[idle-monitor] Pruned ${pruned} old traffic records`);
      }
    }
  }

  // Check monthly data transfer limits per user
  // Group running VMs by owner, check if any owner has exceeded their limit
  const ownerVMs = new Map<string, string[]>();
  for (const vm of runningVMs) {
    const list = ownerVMs.get(vm.owner_id) || [];
    list.push(vm.id);
    ownerVMs.set(vm.owner_id, list);
  }
  for (const [userId, vmIds] of ownerVMs) {
    const usage = db.getUserMonthlyDataUsage(userId);
    const plan = db.getUserPlan(userId);
    if (usage >= plan.max_data_bytes) {
      console.log(`[idle-monitor] User ${userId} exceeded monthly data limit (${(usage / 1024 ** 3).toFixed(1)} GB / ${(plan.max_data_bytes / 1024 ** 3).toFixed(0)} GB), pausing ${vmIds.length} VM(s)...`);
      for (const vmId of vmIds) {
        if (snapshottingSet.has(vmId)) continue;
        snapshottingSet.add(vmId);
        try {
          agentManager.destroyBridgesForVM(vmId);
          await engine.snapshotVM(vmId);
          const snapshotPath = `${process.env.DATA_DIR || "/data/vms"}/${vmId}/snapshot`;
          db.updateVMSnapshotPath(vmId, snapshotPath);
          db.updateVMStatus(vmId, "snapshotted");
          // Caddy route stays — wake-proxy handles connections
          trafficMap.delete(vmId);
          db.emitAdminEvent("vm.data_limit_paused", vmId, userId, { usedBytes: usage, maxBytes: plan.max_data_bytes });
          console.log(`[idle-monitor] VM ${vmId} paused (data limit)`);
        } catch (err: any) {
          console.error(`[idle-monitor] Failed to pause VM ${vmId} for data limit: ${err.message}`);
        } finally {
          snapshottingSet.delete(vmId);
        }
      }
    }
  }

  // Clean up stale entries for VMs that no longer exist
  for (const slug of trafficMap.keys()) {
    const exists = runningVMs.some((e) => e.id === slug);
    if (!exists) trafficMap.delete(slug);
  }
  for (const slug of lastRecordedBytes.keys()) {
    const exists = runningVMs.some((e) => e.id === slug);
    if (!exists) lastRecordedBytes.delete(slug);
  }
}

/**
 * Start the idle monitor polling loop.
 */
export function startIdleMonitor(): void {
  if (pollTimer) return; // Already running

  console.log(`[idle-monitor] Started (window: ${IDLE_TIMEOUT_MS / 1000}s, threshold: ${IDLE_THRESHOLD_BYTES} bytes, poll: ${POLL_INTERVAL_MS / 1000}s)`);

  pollTimer = setInterval(() => {
    pollOnce().catch((err) => {
      console.error(`[idle-monitor] Poll error: ${err.message}`);
    });
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the idle monitor.
 */
export function stopIdleMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("[idle-monitor] Stopped");
  }
}

/**
 * Reset the idle timer for a specific VM (call when there's known activity
 * like terminal connections, agent messages, etc.).
 */
export function resetIdleTimer(slug: string): void {
  const now = Date.now();
  const prev = trafficMap.get(slug);
  if (prev) {
    // Reset the window so the VM gets a fresh 2-min grace period
    prev.windowBytes = prev.windowBytes; // keep current baseline
    prev.windowStart = now;
  } else {
    trafficMap.set(slug, { windowBytes: 0, windowStart: now });
  }
}
