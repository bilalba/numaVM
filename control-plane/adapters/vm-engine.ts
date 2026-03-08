/**
 * VM Engine adapter interface.
 *
 * OSS: Single-node Firecracker (firecracker.ts)
 * Enterprise: Multi-server orchestration, Kubernetes, etc.
 */

export interface CreateVMParams {
  slug: string;
  name?: string;
  appPort: number;
  sshPort: number;
  opencodePort: number;
  ghRepo?: string;
  ghToken?: string;
  githubUsername?: string;
  sshKeys: string;
  opencodePassword: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  vsockCid: number;
  vmIp: string;
  vcpuCount?: number;
  memSizeMib?: number;
  onProgress?: (detail: string) => void;
}

export interface VMRuntimeInfo {
  running: boolean;
  status: "running" | "paused" | "stopped" | "snapshotted";
  startedAt: string | null;
  vsockCid: number;
}

export interface IVMEngine {
  // Lifecycle
  createAndStartVM(params: CreateVMParams): Promise<string>;
  stopVM(vmId: string): Promise<void>;
  removeVM(vmId: string): Promise<void>;
  removeVMFull(vmId: string, vmIp: string, appPort: number, sshPort: number, opencodePort: number): Promise<void>;
  inspectVM(vmId: string): Promise<VMRuntimeInfo>;

  // Pause/resume (for disk copy during clone)
  pauseVM(vmId: string): Promise<void>;
  resumeVM(vmId: string): Promise<void>;

  // Snapshot/restore
  snapshotVM(vmId: string): Promise<void>;
  restoreVM(vmId: string, vsockCid: number, vmIp: string, appPort: number, sshPort: number, opencodePort: number): Promise<void>;

  // Runtime queries
  isVmRunning(vmId: string): boolean;
  getVmIp(vmId: string): string;
  getVsockCid(vmId: string): number;

  // SSH key management
  getInternalSshPubKey(): string;
  getInternalSshKeyPath(): string;

  // DNAT cleanup (exposed for routes that need direct access)
  removeDnat(hostPort: number, vmIp: string, vmPort: number): void;

  // Startup reconciliation
  reconcileRunningVMs(): Promise<void>;

  // Graceful shutdown
  destroyAllVMs(): Promise<void>;
}
