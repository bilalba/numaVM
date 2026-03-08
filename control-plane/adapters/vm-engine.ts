/**
 * VM Engine adapter interface.
 *
 * OSS: Single-node Firecracker (firecracker.ts)
 * Enterprise: Multi-server orchestration, Kubernetes, etc.
 */

import type { ChildProcess } from "node:child_process";
import type { IPty } from "node-pty";

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

export interface SpawnedProcess {
  process: ChildProcess;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: (signal?: NodeJS.Signals) => void;
}

export interface AllocatedResources {
  appPort: number;
  sshPort: number;
  opencodePort: number;
  vsockCid: number;
  vmIp: string;
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

  // --- VM communication (enterprise: routed through node agents) ---

  /** Execute a command in a VM and return stdout. */
  exec(vmId: string, cmd: string[], options?: { user?: string; timeoutMs?: number }): Promise<string>;

  /** Spawn an interactive PTY session to a VM. */
  spawnPty(vmId: string, remoteCmd: string, cols: number, rows: number): IPty;

  /** Spawn a long-running process with stdio pipes to a VM. */
  spawnProcess(vmId: string, remoteCmd: string, options?: { user?: string }): SpawnedProcess;

  // --- Resource management (enterprise: per-node allocation) ---

  /** Allocate ports, CID, and IP for a new VM. */
  allocateResources(): AllocatedResources;

  // --- Disk operations (enterprise: delegated to node agents) ---

  /** Check if a VM has a restorable snapshot. */
  hasSnapshot(vmId: string): boolean;

  /** Read saved VM config (env.json). */
  getVMConfig(vmId: string): Record<string, string>;

  /** Clone disk files from source VM to a target VM slug (handles pause/resume of source). */
  cloneDisks(sourceVmId: string, targetSlug: string): Promise<void>;

  /** Check if source VM has a rootfs available for cloning. */
  hasRootfs(vmId: string): boolean;

  // --- Monitoring (enterprise: aggregated from node agents) ---

  /** Get live network traffic counters for a VM. */
  getLiveTraffic(vmId: string): { rxBytes: number; txBytes: number };
}
