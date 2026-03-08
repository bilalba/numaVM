import type { IStateStore, VMRuntime } from "../state-store.js";

/**
 * In-memory implementation of IStateStore.
 * Uses Maps for single-process, single-server deployments.
 */
export class InMemoryStateStore implements IStateStore {
  private vmRuntimes = new Map<string, VMRuntime>();
  private idleWindows = new Map<string, { windowBytes: number; windowStart: number }>();

  // --- VM runtime tracking ---
  setVMRuntime(vmId: string, info: VMRuntime): void { this.vmRuntimes.set(vmId, info); }
  getVMRuntime(vmId: string): VMRuntime | undefined { return this.vmRuntimes.get(vmId); }
  deleteVMRuntime(vmId: string): void { this.vmRuntimes.delete(vmId); }
  getAllVMRuntimes(): Map<string, VMRuntime> { return new Map(this.vmRuntimes); }

  // --- Idle timer tracking ---
  setIdleWindow(vmId: string, windowBytes: number, windowStart: number): void { this.idleWindows.set(vmId, { windowBytes, windowStart }); }
  getIdleWindow(vmId: string): { windowBytes: number; windowStart: number } | undefined { return this.idleWindows.get(vmId); }
  deleteIdleWindow(vmId: string): void { this.idleWindows.delete(vmId); }
  getAllIdleWindows(): Map<string, { windowBytes: number; windowStart: number }> { return new Map(this.idleWindows); }
}
