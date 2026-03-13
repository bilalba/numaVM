import type { IDatabase, FirewallRule, SshKeyRecord } from "../database.js";
import type { VM, VMWithRole, User, UserPlan, AgentSession, AgentMessage } from "../types.js";
import { getPlanRegistry } from "../providers.js";
import {
  db,
  insertVM as _insertVM,
  findVMById as _findVMById,
  findVMByName as _findVMByName,
  findVMsByUser as _findVMsByUser,
  findAllVMs as _findAllVMs,
  deleteVM as _deleteVM,
  updateVMStatus as _updateVMStatus,
  updateVMStatusDetail as _updateVMStatusDetail,
  updateVMContainerId as _updateVMContainerId,
  updateVMInfo as _updateVMInfo,
  updateVMSnapshotPath as _updateVMSnapshotPath,
  updateVMPublic as _updateVMPublic,
  updateVMFirewallRules as _updateVMFirewallRules,
  getVMFirewallRules as _getVMFirewallRules,
  findVMBySshPort as _findVMBySshPort,
  getAuthorizedUsersForVM as _getAuthorizedUsersForVM,
  grantAccess as _grantAccess,
  revokeAccess as _revokeAccess,
  revokeAllAccess as _revokeAllAccess,
  getVMAccess as _getVMAccess,
  checkAccess as _checkAccess,
  findUserById as _findUserById,
  findUserByEmail as _findUserByEmail,
  findAllUsersWithSshKeys as _findAllUsersWithSshKeys,
  updateUserSshKeys as _updateUserSshKeys,
  appendUserSshKey as _appendUserSshKey,
  clearUserGithubToken as _clearUserGithubToken,
  getUserPlan as _getUserPlan,
  getUserProvisionedRam as _getUserProvisionedRam,
  getUserProvisionedDisk as _getUserProvisionedDisk,
  getUserMonthlyDataUsage as _getUserMonthlyDataUsage,
  setStripeCustomerId as _setStripeCustomerId,
  updateUserPlan as _updateUserPlan,
  findUserByStripeCustomerId as _findUserByStripeCustomerId,
  insertAgentSession as _insertAgentSession,
  findAgentSession as _findAgentSession,
  findAgentSessionsByVM as _findAgentSessionsByVM,
  updateAgentSessionStatus as _updateAgentSessionStatus,
  updateAgentSessionTitle as _updateAgentSessionTitle,
  updateAgentSessionThreadId as _updateAgentSessionThreadId,
  updateAgentSessionModel as _updateAgentSessionModel,
  insertAgentMessage as _insertAgentMessage,
  findMessagesBySession as _findMessagesBySession,
  deleteAgentSession as _deleteAgentSession,
  deleteAgentSessionsByVM as _deleteAgentSessionsByVM,
  getUsedPorts as _getUsedPorts,
  getUsedCids as _getUsedCids,
  getUsedIpv6 as _getUsedIpv6,
  insertTrafficRecord as _insertTrafficRecord,
  getTrafficHistory as _getTrafficHistory,
  getTrafficSummary as _getTrafficSummary,
  pruneOldTraffic as _pruneOldTraffic,
  emitAdminEvent as _emitAdminEvent,
  getUserSshKeys as _getUserSshKeys,
  addUserSshKey as _addUserSshKey,
  removeUserSshKey as _removeUserSshKey,
  findUserSshKeyByFingerprint as _findUserSshKeyByFingerprint,
  getAllSshKeysForVM as _getAllSshKeysForVM,
} from "../../db/client.js";

/**
 * SQLite implementation of IDatabase.
 * Delegates all calls to the existing db/client.ts functions.
 */
export class SqliteDatabase implements IDatabase {
  // --- IVMStore ---
  insertVM(vm: Omit<VM, "created_at">): void { _insertVM(vm); }
  findVMById(id: string): VM | undefined { return _findVMById(id); }
  findVMByName(name: string): VM | undefined { return _findVMByName(name); }
  findVMsByUser(userId: string): VMWithRole[] { return _findVMsByUser(userId); }
  findAllVMs(): VM[] { return _findAllVMs(); }
  deleteVM(id: string): void { _deleteVM(id); }
  updateVMStatus(id: string, status: string): void { _updateVMStatus(id, status); }
  updateVMStatusDetail(id: string, detail: string | null): void { _updateVMStatusDetail(id, detail); }
  updateVMContainerId(id: string, containerId: string): void { _updateVMContainerId(id, containerId); }
  updateVMInfo(id: string, vmId: string, vmIp: string, vsockCid: number, vmPid: number | null): void { _updateVMInfo(id, vmId, vmIp, vsockCid, vmPid); }
  updateVMSnapshotPath(id: string, snapshotPath: string | null): void { _updateVMSnapshotPath(id, snapshotPath); }
  updateVMPublic(id: string, isPublic: boolean): void { _updateVMPublic(id, isPublic); }
  updateVMFirewallRules(id: string, rules: FirewallRule[]): void { _updateVMFirewallRules(id, rules); }
  getVMFirewallRules(id: string): FirewallRule[] { return _getVMFirewallRules(id); }
  findVMBySshPort(port: number): VM | undefined { return _findVMBySshPort(port); }
  getAuthorizedUsersForVM(vmId: string): { id: string; ssh_public_keys: string | null; github_username: string | null }[] { return _getAuthorizedUsersForVM(vmId); }

  // --- IAccessStore ---
  grantAccess(vmId: string, userId: string, role: string): void { _grantAccess(vmId, userId, role); }
  revokeAccess(vmId: string, userId: string): void { _revokeAccess(vmId, userId); }
  revokeAllAccess(vmId: string): void { _revokeAllAccess(vmId); }
  getVMAccess(vmId: string): { user_id: string; role: string; email: string; name: string | null }[] { return _getVMAccess(vmId); }
  checkAccess(vmId: string, userId: string): string | undefined { return _checkAccess(vmId, userId); }

  // --- IUserStore ---
  findUserById(id: string): User | undefined { return _findUserById(id); }
  findUserByEmail(email: string): User | undefined { return _findUserByEmail(email); }
  findAllUsersWithSshKeys(): { id: string; email: string; name: string | null; github_username: string | null; ssh_public_keys: string; plan: string }[] { return _findAllUsersWithSshKeys(); }
  updateUserSshKeys(userId: string, keys: string | null): void { _updateUserSshKeys(userId, keys); }
  appendUserSshKey(userId: string, key: string): void { _appendUserSshKey(userId, key); }
  clearUserGithubToken(userId: string): void { _clearUserGithubToken(userId); }
  getUserPlan(userId: string): UserPlan { return _getUserPlan(userId, getPlanRegistry()); }
  getUserProvisionedRam(userId: string): number { return _getUserProvisionedRam(userId); }
  getUserProvisionedDisk(userId: string): number { return _getUserProvisionedDisk(userId); }
  getUserMonthlyDataUsage(userId: string): number { return _getUserMonthlyDataUsage(userId); }
  setStripeCustomerId(userId: string, customerId: string): void { _setStripeCustomerId(userId, customerId); }
  updateUserPlan(userId: string, plan: string): void { _updateUserPlan(userId, plan); }
  findUserByStripeCustomerId(customerId: string): User | undefined { return _findUserByStripeCustomerId(customerId); }
  getUserSshKeys(userId: string): SshKeyRecord[] { return _getUserSshKeys(userId); }
  addUserSshKey(userId: string, id: string, keyData: string, keyType: string, fingerprint: string, comment: string | null, source: string): void { _addUserSshKey(userId, id, keyData, keyType, fingerprint, comment, source); }
  removeUserSshKey(userId: string, keyId: string): void { _removeUserSshKey(userId, keyId); }
  findUserSshKeyByFingerprint(userId: string, fingerprint: string): SshKeyRecord | undefined { return _findUserSshKeyByFingerprint(userId, fingerprint); }
  getAllSshKeysForVM(vmId: string): SshKeyRecord[] { return _getAllSshKeysForVM(vmId); }

  // --- IAgentStore ---
  insertAgentSession(s: Pick<AgentSession, "id" | "vm_id" | "agent_type" | "thread_id" | "title" | "cwd" | "status">): void { _insertAgentSession(s); }
  findAgentSession(id: string): AgentSession | undefined { return _findAgentSession(id); }
  findAgentSessionsByVM(vmId: string, agentType: string): AgentSession[] { return _findAgentSessionsByVM(vmId, agentType); }
  updateAgentSessionStatus(id: string, status: string): void { _updateAgentSessionStatus(id, status); }
  updateAgentSessionTitle(id: string, title: string): void { _updateAgentSessionTitle(id, title); }
  updateAgentSessionThreadId(id: string, threadId: string): void { _updateAgentSessionThreadId(id, threadId); }
  updateAgentSessionModel(id: string, model: string | null, provider: string | null): void { _updateAgentSessionModel(id, model, provider); }
  insertAgentMessage(m: Pick<AgentMessage, "id" | "session_id" | "role" | "content" | "metadata">): void { _insertAgentMessage(m); }
  findMessagesBySession(sessionId: string): AgentMessage[] { return _findMessagesBySession(sessionId); }
  deleteAgentSession(id: string): void { _deleteAgentSession(id); }
  deleteAgentSessionsByVM(vmId: string): void { _deleteAgentSessionsByVM(vmId); }

  // --- IInfraStore ---
  getUsedPorts(): { app_port: number; ssh_port: number; opencode_port: number }[] { return _getUsedPorts(); }
  getUsedCids(): number[] { return _getUsedCids(); }
  getUsedIpv6(): string[] { return _getUsedIpv6(); }
  insertTrafficRecord(vmId: string, rxBytes: number, txBytes: number, ownerId?: string): void { _insertTrafficRecord(vmId, rxBytes, txBytes, ownerId); }
  getTrafficHistory(vmId: string, hours: number): { rx_bytes: number; tx_bytes: number; recorded_at: string }[] { return _getTrafficHistory(vmId, hours); }
  getTrafficSummary(hours: number): { vm_id: string; total_rx: number; total_tx: number; samples: number }[] { return _getTrafficSummary(hours); }
  pruneOldTraffic(days?: number): number { return _pruneOldTraffic(days); }
  emitAdminEvent(type: string, vmId?: string | null, userId?: string | null, metadata?: Record<string, unknown>): void { _emitAdminEvent(type, vmId, userId, metadata); }

  // --- Raw queries ---
  raw<T = any>(sql: string, ...params: any[]): T[] { return db.prepare(sql).all(...params) as T[]; }
  rawGet<T = any>(sql: string, ...params: any[]): T | undefined { return db.prepare(sql).get(...params) as T | undefined; }
}
