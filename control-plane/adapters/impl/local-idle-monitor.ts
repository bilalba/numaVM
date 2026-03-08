import type { IIdleMonitor } from "../idle-monitor.js";
import {
  startIdleMonitor,
  stopIdleMonitor,
  resetIdleTimer,
} from "../../services/idle-monitor.js";

/**
 * Local idle monitor — wraps the existing TAP traffic monitoring.
 * Reads /sys/class/net/tap-{slug}/statistics/ on the local host.
 */
export class LocalIdleMonitor implements IIdleMonitor {
  start(): void { startIdleMonitor(); }
  stop(): void { stopIdleMonitor(); }
  resetTimer(vmId: string): void { resetIdleTimer(vmId); }
}
