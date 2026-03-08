/**
 * Idle monitor adapter interface.
 *
 * OSS: Local TAP traffic monitoring (idle-monitor.ts)
 * Enterprise: No-op on control plane (node agents handle idle monitoring)
 */
export interface IIdleMonitor {
  /** Start the idle monitoring loop. */
  start(): void;

  /** Stop the idle monitoring loop. */
  stop(): void;

  /** Reset the idle timer for a VM (e.g. on terminal connect, agent message). */
  resetTimer(vmId: string): void;
}
