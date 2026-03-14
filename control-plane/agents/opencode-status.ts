/**
 * In-memory OpenCode status tracker.
 *
 * Uses a tight TCP connect loop (50ms timeout, 5ms sleep — same pattern as
 * waitForTcpReady in firecracker.ts) to detect when the OpenCode server is
 * accepting connections. Broadcasts "opencode.ready" over the WS hub when
 * the port opens. This avoids SSH round-trips in ensureRunning().
 */

import { createConnection as netCreateConnection } from "node:net";
import { wsHub } from "./ws-hub.js";

type Status = "starting" | "ready" | "unknown";

interface TrackedVM {
  status: Status;
  aborted: boolean;
  waiters: Array<() => void>;
  port: number;
}

const tracked = new Map<string, TrackedVM>();

/** Start tracking a VM's OpenCode readiness. Tight TCP poll loop. */
export function trackVM(vmId: string, opencodePort: number, opencodePassword: string): void {
  // Clean up any existing tracker for this VM
  untrackVM(vmId);

  const entry: TrackedVM = {
    status: "starting",
    aborted: false,
    waiters: [],
    port: opencodePort,
  };

  tracked.set(vmId, entry);

  // Run the tight poll loop in the background
  pollLoop(vmId, entry).catch(() => {});
}

/**
 * Tight TCP connect loop: 50ms connect timeout, 5ms sleep between attempts,
 * 30s safety timeout. Port accepting connections = ready.
 */
async function pollLoop(vmId: string, entry: TrackedVM): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline && !entry.aborted) {
    const connected = await new Promise<boolean>((resolve) => {
      const sock = netCreateConnection({ host: "127.0.0.1", port: entry.port, timeout: 50 });
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => { sock.destroy(); resolve(false); });
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
    });

    if (entry.aborted) return;

    if (connected) {
      setReady(vmId, entry);
      return;
    }

    await new Promise((r) => setTimeout(r, 5));
  }

  // Safety timeout — mark unknown so waiters fall through to SSH fallback
  if (!entry.aborted && entry.status === "starting") {
    entry.status = "unknown";
    for (const resolve of entry.waiters) resolve();
    entry.waiters.length = 0;
  }
}

/** Get the current OpenCode status for a VM. */
export function getOpenCodeStatus(vmId: string): Status {
  return tracked.get(vmId)?.status ?? "unknown";
}

/** Wait for a VM's OpenCode to become ready. Resolves on ready or timeout. */
export function waitForReady(vmId: string, timeoutMs = 15_000): Promise<void> {
  const entry = tracked.get(vmId);
  if (!entry || entry.status === "ready" || entry.status === "unknown") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    entry.waiters.push(resolve);

    // Per-caller timeout
    const timer = setTimeout(() => {
      const idx = entry.waiters.indexOf(resolve);
      if (idx !== -1) entry.waiters.splice(idx, 1);
      resolve();
    }, timeoutMs);

    // If the entry resolves before timeout, clear the timer
    const originalResolve = resolve;
    entry.waiters[entry.waiters.length - 1] = () => {
      clearTimeout(timer);
      originalResolve();
    };
  });
}

/** Mark a VM's OpenCode as ready (called when ensureRunning() HTTP check succeeds). */
export function markReady(vmId: string): void {
  const entry = tracked.get(vmId);
  if (entry) {
    setReady(vmId, entry);
  }
}

/** Stop tracking a VM. Signals the poll loop to stop and resolves pending waiters. */
export function untrackVM(vmId: string): void {
  const entry = tracked.get(vmId);
  if (!entry) return;

  entry.aborted = true;

  // Resolve all pending waiters
  for (const resolve of entry.waiters) resolve();
  entry.waiters.length = 0;

  tracked.delete(vmId);
}

function setReady(vmId: string, entry: TrackedVM): void {
  if (entry.status === "ready") return;
  entry.status = "ready";
  // Notify all waiters
  for (const resolve of entry.waiters) resolve();
  entry.waiters.length = 0;
  // Push to any connected dashboards
  wsHub.broadcast(vmId, "", { type: "opencode.ready" } as any);
}
