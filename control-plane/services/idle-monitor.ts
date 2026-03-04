import { readFileSync } from "node:fs";
import { db, findEnvById, updateEnvStatus, updateEnvSnapshotPath } from "../db/client.js";
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
let pollTimer: ReturnType<typeof setInterval> | null = null;

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
    "SELECT id, vsock_cid, app_port, ssh_port, opencode_port, pages_port, vm_ip FROM envs WHERE status = 'running'"
  ).all() as { id: string; vsock_cid: number; app_port: number; ssh_port: number; opencode_port: number; pages_port: number | null; vm_ip: string }[];

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
      console.log(`[idle-monitor] VM ${env.id} transferred only ${bytesInWindow} bytes in ${Math.round(windowDuration / 1000)}s (threshold: ${IDLE_THRESHOLD_BYTES}), snapshotting...`);

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

        // Clean up DNAT rules (done by snapshotVM -> stopVM)
        // The removeDnat calls need the port info
        const { removeDnat } = await import("./firecracker.js") as any;
        // DNAT cleanup is handled in snapshotVM via the Firecracker process cleanup

        console.log(`[idle-monitor] VM ${env.id} snapshotted successfully`);
      } catch (err: any) {
        console.error(`[idle-monitor] Failed to snapshot VM ${env.id}: ${err.message}`);
      }
    }
  }

  // Clean up stale entries for VMs that no longer exist
  for (const slug of trafficMap.keys()) {
    const exists = runningEnvs.some((e) => e.id === slug);
    if (!exists) trafficMap.delete(slug);
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
