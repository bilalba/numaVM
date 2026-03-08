/**
 * State store adapter for runtime VM state.
 *
 * OSS: In-memory Maps (single process)
 * Enterprise: Redis, etcd, or other distributed stores
 */

export interface VMRuntime {
  pid: number;
  socketPath: string;
  vsockCid: number;
  vmIp: string;
  tapDev: string;
  startedAt: string;
  hostId?: string; // For multi-server: which host runs this VM
}

export interface IStateStore {
  // VM runtime tracking
  setVMRuntime(vmId: string, info: VMRuntime): void;
  getVMRuntime(vmId: string): VMRuntime | undefined;
  deleteVMRuntime(vmId: string): void;
  getAllVMRuntimes(): Map<string, VMRuntime>;

  // Idle timer tracking
  setIdleWindow(vmId: string, windowBytes: number, windowStart: number): void;
  getIdleWindow(vmId: string): { windowBytes: number; windowStart: number } | undefined;
  deleteIdleWindow(vmId: string): void;
  getAllIdleWindows(): Map<string, { windowBytes: number; windowStart: number }>;
}
