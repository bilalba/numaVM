import type { IVMEngine, CreateVMParams, VMRuntimeInfo } from "../vm-engine.js";
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
} from "../../services/firecracker.js";

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
}
