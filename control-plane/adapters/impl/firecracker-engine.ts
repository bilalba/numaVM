import type { IPty } from "node-pty";
import type { IVMEngine, CreateVMParams, VMRuntimeInfo, SpawnedProcess, AllocatedResources } from "../vm-engine.js";
import {
  createAndStartVM as _createAndStartVM,
  stopVM as _stopVM,
  removeVM as _removeVM,
  removeVMFull as _removeVMFull,
  inspectVM as _inspectVM,
  pauseVM as _pauseVM,
  resumeVM as _resumeVM,
  snapshotVM as _snapshotVM,
  restoreVM as _restoreVM,
  isVmRunning as _isVmRunning,
  getVmIp as _getVmIp,
  getVsockCid as _getVsockCid,
  getInternalSshPubKey as _getInternalSshPubKey,
  getInternalSshKeyPath as _getInternalSshKeyPath,
  removeDnat as _removeDnat,
  reconcileRunningVMs as _reconcileRunningVMs,
  destroyAllVMs as _destroyAllVMs,
  getDataDir,
  getAvailableImages as _getAvailableImages,
} from "../../services/firecracker.js";
import { execInVM, spawnPtyOverVsock, spawnProcessOverVsock } from "../../services/vsock-ssh.js";
import { allocatePorts, allocateCid, cidToVmIp } from "../../services/port-allocator.js";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Firecracker implementation of IVMEngine.
 * Delegates all calls to the existing services/firecracker.ts functions.
 */
export class FirecrackerEngine implements IVMEngine {
  async createAndStartVM(params: CreateVMParams): Promise<string> { return _createAndStartVM(params); }
  async stopVM(vmId: string): Promise<void> { return _stopVM(vmId); }
  async removeVM(vmId: string): Promise<void> { return _removeVM(vmId); }
  async removeVMFull(vmId: string, vmIp: string, appPort: number, sshPort: number, opencodePort: number): Promise<void> { return _removeVMFull(vmId, vmIp, appPort, sshPort, opencodePort); }
  async inspectVM(vmId: string): Promise<VMRuntimeInfo> { return _inspectVM(vmId); }
  async pauseVM(vmId: string): Promise<void> { return _pauseVM(vmId); }
  async resumeVM(vmId: string): Promise<void> { return _resumeVM(vmId); }
  async snapshotVM(vmId: string): Promise<void> { return _snapshotVM(vmId); }
  async restoreVM(vmId: string, vsockCid: number, vmIp: string, appPort: number, sshPort: number, opencodePort: number): Promise<void> { return _restoreVM(vmId, vsockCid, vmIp, appPort, sshPort, opencodePort); }
  isVmRunning(vmId: string): boolean { return _isVmRunning(vmId); }
  getVmIp(vmId: string): string { return _getVmIp(vmId); }
  getVsockCid(vmId: string): number { return _getVsockCid(vmId); }
  getInternalSshPubKey(): string { return _getInternalSshPubKey(); }
  getInternalSshKeyPath(): string { return _getInternalSshKeyPath(); }
  removeDnat(hostPort: number, vmIp: string, vmPort: number): void { _removeDnat(hostPort, vmIp, vmPort); }
  async reconcileRunningVMs(): Promise<void> { return _reconcileRunningVMs(); }
  async destroyAllVMs(): Promise<void> { return _destroyAllVMs(); }

  // --- VM communication ---

  async exec(vmId: string, cmd: string[], options?: { user?: string; timeoutMs?: number }): Promise<string> {
    return execInVM(this.getVmIp(vmId), cmd, options);
  }

  spawnPty(vmId: string, remoteCmd: string, cols: number, rows: number): IPty {
    return spawnPtyOverVsock(this.getVmIp(vmId), remoteCmd, cols, rows);
  }

  spawnProcess(vmId: string, remoteCmd: string, options?: { user?: string }): SpawnedProcess {
    return spawnProcessOverVsock(this.getVmIp(vmId), remoteCmd, options);
  }

  // --- Resource management ---

  allocateResources(): AllocatedResources {
    const { appPort, sshPort, opencodePort } = allocatePorts();
    const vsockCid = allocateCid();
    const vmIp = cidToVmIp(vsockCid);
    return { appPort, sshPort, opencodePort, vsockCid, vmIp };
  }

  // --- Disk operations ---

  hasSnapshot(vmId: string): boolean {
    const snapshotDir = join(getDataDir(), vmId, "snapshot");
    return existsSync(join(snapshotDir, "vmstate")) && existsSync(join(snapshotDir, "memory"));
  }

  getVMConfig(vmId: string): Record<string, string> {
    const configPath = join(getDataDir(), vmId, "env.json");
    try {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.warn(`[firecracker-engine] No env.json found for ${vmId}, using defaults`);
      return {};
    }
  }

  async cloneDisks(sourceVmId: string, targetSlug: string): Promise<void> {
    const dataDir = getDataDir();
    const sourceDir = join(dataDir, sourceVmId);
    const sourceRootfs = join(sourceDir, "rootfs.ext4");
    const sourceData = join(sourceDir, "data.ext4");
    const targetDir = join(dataDir, targetSlug);

    mkdirSync(targetDir, { recursive: true });

    const isRunning = _isVmRunning(sourceVmId);
    if (isRunning) {
      await _pauseVM(sourceVmId);
    }

    try {
      // Copy rootfs (sparse/reflink when possible)
      try {
        execSync(`cp --reflink=auto "${sourceRootfs}" "${join(targetDir, "rootfs.ext4")}"`, { stdio: "pipe" });
      } catch {
        execSync(`cp "${sourceRootfs}" "${join(targetDir, "rootfs.ext4")}"`, { stdio: "pipe" });
      }

      // Copy data volume if it exists
      if (existsSync(sourceData)) {
        try {
          execSync(`cp --reflink=auto "${sourceData}" "${join(targetDir, "data.ext4")}"`, { stdio: "pipe" });
        } catch {
          execSync(`cp "${sourceData}" "${join(targetDir, "data.ext4")}"`, { stdio: "pipe" });
        }
      }
    } finally {
      if (isRunning) {
        await _resumeVM(sourceVmId);
      }
    }
  }

  hasRootfs(vmId: string): boolean {
    return existsSync(join(getDataDir(), vmId, "rootfs.ext4"));
  }

  getAvailableImages(): { distro: string; version: number; distro_version: string; node_version: string }[] {
    return _getAvailableImages();
  }

  // --- Monitoring ---

  getLiveTraffic(vmId: string): { rxBytes: number; txBytes: number } {
    const tapDev = `tap-${vmId}`;
    try {
      const rx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/rx_bytes`, "utf-8").trim(), 10);
      const tx = parseInt(readFileSync(`/sys/class/net/${tapDev}/statistics/tx_bytes`, "utf-8").trim(), 10);
      return { rxBytes: rx, txBytes: tx };
    } catch {
      return { rxBytes: 0, txBytes: 0 };
    }
  }
}
