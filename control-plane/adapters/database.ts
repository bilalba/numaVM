import type { VM, VMWithRole, User, UserPlan, AgentSession, AgentMessage } from "./types.js";
import type { FirewallRule, SshKeyRecord } from "../db/client.js";

// Re-export types so consumers can import everything from one place
export type { VM, VMWithRole, User, UserPlan, AgentSession, AgentMessage } from "./types.js";
export type { FirewallRule, SshKeyRecord } from "../db/client.js";

// --- Sub-interfaces grouped by domain ---

export interface IVMStore {
  insertVM(vm: Omit<VM, "created_at">): void;
  findVMById(id: string): VM | undefined;
  findVMByName(name: string): VM | undefined;
  findVMsByUser(userId: string): VMWithRole[];
  findAllVMs(): VM[];
  deleteVM(id: string): void;
  updateVMStatus(id: string, status: string): void;
  updateVMStatusDetail(id: string, detail: string | null): void;
  updateVMContainerId(id: string, containerId: string): void;
  updateVMInfo(id: string, vmId: string, vmIp: string, vsockCid: number, vmPid: number | null): void;
  updateVMSnapshotPath(id: string, snapshotPath: string | null): void;
  updateVMPublic(id: string, isPublic: boolean): void;
  updateVMKeepAlive(id: string, keepAlive: boolean): void;
  updateVMFirewallRules(id: string, rules: FirewallRule[]): void;
  getVMFirewallRules(id: string): FirewallRule[];
  findVMBySshPort(port: number): VM | undefined;
  getAuthorizedUsersForVM(vmId: string): { id: string; ssh_public_keys: string | null; github_username: string | null }[];
}

export interface IAccessStore {
  grantAccess(vmId: string, userId: string, role: string): void;
  revokeAccess(vmId: string, userId: string): void;
  revokeAllAccess(vmId: string): void;
  getVMAccess(vmId: string): { user_id: string; role: string; email: string; name: string | null }[];
  checkAccess(vmId: string, userId: string): string | undefined;
}

export interface IUserStore {
  findUserById(id: string): User | undefined;
  findUserByEmail(email: string): User | undefined;
  findAllUsersWithSshKeys(): { id: string; email: string; name: string | null; github_username: string | null; ssh_public_keys: string; plan: string }[];
  updateUserSshKeys(userId: string, keys: string | null): void;
  appendUserSshKey(userId: string, key: string): void;
  clearUserGithubToken(userId: string): void;
  getUserPlan(userId: string): UserPlan;
  getUserProvisionedRam(userId: string): number;
  getUserKeepAliveRam(userId: string): number;
  getUserProvisionedDisk(userId: string): number;
  getUserMonthlyDataUsage(userId: string): number;
  setStripeCustomerId(userId: string, customerId: string): void;
  updateUserPlan(userId: string, plan: string): void;
  findUserByStripeCustomerId(customerId: string): User | undefined;
  // Per-key SSH key management
  getUserSshKeys(userId: string): SshKeyRecord[];
  addUserSshKey(userId: string, id: string, keyData: string, keyType: string, fingerprint: string, comment: string | null, source: string): void;
  removeUserSshKey(userId: string, keyId: string): void;
  findUserSshKeyByFingerprint(userId: string, fingerprint: string): SshKeyRecord | undefined;
  getAllSshKeysForVM(vmId: string): SshKeyRecord[];
}

export interface IAgentStore {
  insertAgentSession(s: Pick<AgentSession, "id" | "vm_id" | "agent_type" | "thread_id" | "title" | "cwd" | "status">): void;
  findAgentSession(id: string): AgentSession | undefined;
  findAgentSessionsByVM(vmId: string, agentType: string): AgentSession[];
  updateAgentSessionStatus(id: string, status: string): void;
  updateAgentSessionTitle(id: string, title: string): void;
  updateAgentSessionThreadId(id: string, threadId: string): void;
  updateAgentSessionModel(id: string, model: string | null, provider: string | null): void;
  insertAgentMessage(m: Pick<AgentMessage, "id" | "session_id" | "role" | "content" | "metadata">): void;
  findMessagesBySession(sessionId: string): AgentMessage[];
  deleteAgentSession(id: string): void;
  deleteAgentSessionsByVM(vmId: string): void;
}

export interface IInfraStore {
  getUsedPorts(): { app_port: number; ssh_port: number; opencode_port: number }[];
  getUsedCids(): number[];
  getUsedIpv6(): string[];
  insertTrafficRecord(vmId: string, rxBytes: number, txBytes: number, ownerId?: string): void;
  getTrafficHistory(vmId: string, hours: number): { rx_bytes: number; tx_bytes: number; recorded_at: string }[];
  getTrafficSummary(hours: number): { vm_id: string; total_rx: number; total_tx: number; samples: number }[];
  pruneOldTraffic(days?: number): number;
  emitAdminEvent(type: string, vmId?: string | null, userId?: string | null, metadata?: Record<string, unknown>): void;
}

/**
 * Composite database interface. The OSS implementation uses SQLite (better-sqlite3).
 * Enterprise implementations can swap in Postgres, CockroachDB, etc.
 */
export interface IDatabase extends IVMStore, IAccessStore, IUserStore, IAgentStore, IInfraStore {
  /** Run arbitrary SQL (for health checks, admin queries). */
  raw<T = any>(sql: string, ...params: any[]): T[];
  /** Run arbitrary SQL returning a single row. */
  rawGet<T = any>(sql: string, ...params: any[]): T | undefined;
}
