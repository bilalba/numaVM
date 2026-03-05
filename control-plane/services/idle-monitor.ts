import { readFileSync } from "node:fs";
import { db, findEnvById, updateEnvStatus, updateEnvSnapshotPath, emitAdminEvent, insertTrafficRecord, pruneOldTraffic } from "../db/client.js";
import { snapshotVM } from "./firecracker.js";
import { removeRoute } from "./caddy.js";

/**
 * Network Idle Monitor
 *
 * Polls TAP device traffic counters for each running VM. When a VM
 * transfers less than IDLE_THRESHOLD_BYTES (default 10 KB) within
 * IDLE_TIMEOUT_MS (default 2 min), it's snapshotted and freed.
 *
 * Traffic is measured via /sys/class/net/tap-{slug}/statistics/{rx,tx}_bytes.
 * Vsock traffic is not counted (it uses a separate virtio device).
 */

const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "120000", 10); // 2 min
const IDLE_THRESHOLD_BYTES = parseInt(process.env.IDLE_THRESHOLD_BYTES || "10240", 10); // 10 KB
const POLL_INTERVAL_MS = parseInt(process.env.IDLE_POLL_INTERVAL_MS || "30000", 10); // 30s

interface VMTraffic {
  /** Bytes snapshot taken at windowStart */
  windowBytes: number;
  /** When the current measurement window started */
  windowStart: number;
}

const trafficMap = new Map<string, VMTraffic>();
const snapshottingSet = new Set<string>(); // per-env concurrency guard
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
  // Get all running VMs
  const runningEnvs = db.prepare(
    "SELECT id, vsock_cid, app_port, ssh_port, opencode_port, vm_ip FROM envs WHERE status = 'running'"
  ).all() as { id: string; vsock_cid: number; app_port: number; ssh_port: number; opencode_port: number; vm_ip: string }[];

  const now = Date.now();

  for (const env of runningEnvs) {
    const tapDev = `tap-${env.id}`;
    const currentBytes = readTapBytes(tapDev);

    if (currentBytes < 0) continue; // TAP not available

    const prev = trafficMap.get(env.id);

    if (!prev) {
      // First observation — start a measurement window
      trafficMap.set(env.id, { windowBytes: currentBytes, windowStart: now });
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
      trafficMap.set(env.id, { windowBytes: currentBytes, windowStart: now });
      continue;
    }

    // Less than threshold transferred in the window — snapshot
    {
      // Skip if a snapshot is already in-flight for this env
      if (snapshottingSet.has(env.id)) {
        continue;
      }

      console.log(`[idle-monitor] VM ${env.id} transferred only ${bytesInWindow} bytes in ${Math.round(windowDuration / 1000)}s (threshold: ${IDLE_THRESHOLD_BYTES}), snapshotting...`);

      snapshottingSet.add(env.id);
      try {
        // Snapshot the VM
        await snapshotVM(env.id);

        // Update DB
        const snapshotPath = `${process.env.DATA_DIR || "/data/envs"}/${env.id}/snapshot`;
        updateEnvSnapshotPath(env.id, snapshotPath);
        updateEnvStatus(env.id, "snapshotted");

        // Remove Caddy route (requests will hit status page / trigger wake)
        try {
          await removeRoute(env.id);
        } catch { /* ok */ }

        // Clean up traffic tracking
        trafficMap.delete(env.id);

        emitAdminEvent("vm.idle_snapshotted", env.id, null, { idleBytes: bytesInWindow, windowMs: windowDuration });
        console.log(`[idle-monitor] VM ${env.id} snapshotted successfully`);
      } catch (err: any) {
        console.error(`[idle-monitor] Failed to snapshot VM ${env.id}: ${err.message}`);
        // Reset the window so we don't immediately retry
        trafficMap.set(env.id, { windowBytes: currentBytes, windowStart: now });
      } finally {
        snapshottingSet.delete(env.id);
      }
    }
  }

  // Record traffic deltas every RECORD_INTERVAL polls (~5min)
  pollCount++;
  if (pollCount >= RECORD_INTERVAL) {
    pollCount = 0;
    for (const env of runningEnvs) {
      const tapDev = `tap-${env.id}`;
      let rx = 0, tx = 0;
      try {
        rx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/rx_bytes`, "utf-8").trim(), 10);
        tx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/tx_bytes`, "utf-8").trim(), 10);
      } catch { continue; }

      const prev = lastRecordedBytes.get(env.id);
      if (prev) {
        const deltaRx = Math.max(0, rx - prev.rx);
        const deltaTx = Math.max(0, tx - prev.tx);
        if (deltaRx > 0 || deltaTx > 0) {
          insertTrafficRecord(env.id, deltaRx, deltaTx);
        }
      }
      lastRecordedBytes.set(env.id, { rx, tx });
    }

    // Prune old records once per day
    const now = Date.now();
    if (now - lastPruneTime > 86400000) {
      lastPruneTime = now;
      const pruned = pruneOldTraffic(7);
      if (pruned > 0) {
        console.log(`[idle-monitor] Pruned ${pruned} old traffic records`);
      }
    }
  }

  // Clean up stale entries for VMs that no longer exist
  for (const slug of trafficMap.keys()) {
    const exists = runningEnvs.some((e) => e.id === slug);
    if (!exists) trafficMap.delete(slug);
  }
  for (const slug of lastRecordedBytes.keys()) {
    const exists = runningEnvs.some((e) => e.id === slug);
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
