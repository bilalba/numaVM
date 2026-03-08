import Database, { type Database as DatabaseType } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = join(__dirname, "..", "..", "platform.db");
const db: DatabaseType = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Migration: rename envs → vms, env_access → vm_access, env_id → vm_id ---
// Check if old table names exist and migrate
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
if (tables.includes("envs") && !tables.includes("vms")) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    ALTER TABLE envs RENAME TO vms;
    ALTER TABLE agent_sessions RENAME COLUMN env_id TO vm_id;
    ALTER TABLE vm_traffic RENAME COLUMN env_id TO vm_id;
    ALTER TABLE admin_events RENAME COLUMN env_id TO vm_id;
  `);
  db.pragma("foreign_keys = ON");
}
if (tables.includes("env_access") && !tables.includes("vm_access")) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    ALTER TABLE env_access RENAME TO vm_access;
    ALTER TABLE vm_access RENAME COLUMN env_id TO vm_id;
  `);
  db.pragma("foreign_keys = ON");
}

// Run schema (creates tables if they don't exist)
const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

// Migrate existing vms table: add Firecracker columns + update CHECK constraint
const vmColumns = db.pragma("table_info(vms)") as { name: string }[];
const colNames = new Set(vmColumns.map((c) => c.name));
if (!colNames.has("vm_ip")) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vms_new (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      owner_id          TEXT NOT NULL,
      gh_repo           TEXT,
      gh_token          TEXT,
      container_id      TEXT,
      vm_ip             TEXT,
      vsock_cid         INTEGER UNIQUE,
      vm_pid            INTEGER,
      snapshot_path     TEXT,
      app_port          INTEGER UNIQUE,
      ssh_port          INTEGER UNIQUE,
      opencode_port     INTEGER UNIQUE,
      opencode_password TEXT,
      status            TEXT NOT NULL DEFAULT 'creating'
                        CHECK(status IN ('creating', 'running', 'stopped', 'paused', 'snapshotted', 'error')),
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO vms_new (id, name, owner_id, gh_repo, gh_token, container_id, app_port, ssh_port, opencode_port, opencode_password, status, created_at)
      SELECT id, name, owner_id, gh_repo, gh_token, container_id, app_port, ssh_port, opencode_port, opencode_password, status, created_at FROM vms;
    DROP TABLE vms;
    ALTER TABLE vms_new RENAME TO vms;
    CREATE INDEX IF NOT EXISTS idx_vms_owner ON vms(owner_id);
    CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status);
  `);
  db.pragma("foreign_keys = ON");
}

// Migrate: make gh_repo/gh_token nullable (was NOT NULL in earlier schema)
db.exec("DROP TABLE IF EXISTS vms_mig2");
const ghRepoCol = (db.pragma("table_info(vms)") as { name: string; notnull: number }[])
  .find((c) => c.name === "gh_repo");
if (ghRepoCol && ghRepoCol.notnull === 1) {
  db.pragma("foreign_keys = OFF");
  const currentCols = (db.pragma("table_info(vms)") as { name: string }[]).map((c) => c.name);
  const colList = currentCols.join(", ");
  db.exec(`
    CREATE TABLE vms_mig2 (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      owner_id          TEXT NOT NULL,
      gh_repo           TEXT,
      gh_token          TEXT,
      container_id      TEXT,
      vm_ip             TEXT,
      vsock_cid         INTEGER UNIQUE,
      vm_pid            INTEGER,
      snapshot_path     TEXT,
      app_port          INTEGER UNIQUE,
      ssh_port          INTEGER UNIQUE,
      opencode_port     INTEGER UNIQUE,
      opencode_password TEXT,
      status            TEXT NOT NULL DEFAULT 'creating'
                        CHECK(status IN ('creating', 'running', 'stopped', 'paused', 'snapshotted', 'error')),
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      pages_port        INTEGER UNIQUE
    );
    INSERT INTO vms_mig2 (${colList}) SELECT ${colList} FROM vms;
    DROP TABLE vms;
    ALTER TABLE vms_mig2 RENAME TO vms;
    CREATE INDEX IF NOT EXISTS idx_vms_owner ON vms(owner_id);
    CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status);
  `);
  db.pragma("foreign_keys = ON");
}

// Migrate: add mem_size_mib column to vms
const vmCols2 = db.pragma("table_info(vms)") as { name: string }[];
if (!vmCols2.some((c) => c.name === "mem_size_mib")) {
  db.exec("ALTER TABLE vms ADD COLUMN mem_size_mib INTEGER NOT NULL DEFAULT 512");
}

// Migrate: add status_detail column to vms (real-time progress during creation)
const vmCols3 = db.pragma("table_info(vms)") as { name: string }[];
if (!vmCols3.some((c) => c.name === "status_detail")) {
  db.exec("ALTER TABLE vms ADD COLUMN status_detail TEXT");
}

// Migrate: add disk_size_gib column to vms
const vmCols4 = db.pragma("table_info(vms)") as { name: string }[];
if (!vmCols4.some((c) => c.name === "disk_size_gib")) {
  db.exec("ALTER TABLE vms ADD COLUMN disk_size_gib INTEGER NOT NULL DEFAULT 5");
}

// Migrate: add owner_id to vm_traffic so data usage survives VM deletion
const trafficCols = db.pragma("table_info(vm_traffic)") as { name: string }[];
if (!trafficCols.some((c) => c.name === "owner_id")) {
  db.exec("ALTER TABLE vm_traffic ADD COLUMN owner_id TEXT");
  // Backfill from vm_access for existing records
  db.exec(`
    UPDATE vm_traffic SET owner_id = (
      SELECT va.user_id FROM vm_access va WHERE va.vm_id = vm_traffic.vm_id AND va.role = 'owner' LIMIT 1
    ) WHERE owner_id IS NULL
  `);
}

// Migrate: add plan columns to users
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'base'"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN trial_started_at DATETIME"); } catch { /* already exists */ }
// Backfill: set trial_started_at for existing base users who don't have it
db.exec("UPDATE users SET trial_started_at = created_at WHERE trial_started_at IS NULL AND plan = 'base' AND id != 'dev-user'");

// Migrate: add stripe_customer_id to users
try { db.exec("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT"); } catch { /* already exists */ }

// Migrate: add cwd column to agent_sessions
const agentSessionCols = db.pragma("table_info(agent_sessions)") as { name: string }[];
if (!agentSessionCols.some((c) => c.name === "cwd")) {
  db.exec("ALTER TABLE agent_sessions ADD COLUMN cwd TEXT");
}

export { db };

// --- Types ---

export interface VM {
  id: string;
  name: string;
  owner_id: string;
  gh_repo: string | null;
  gh_token: string | null;
  container_id: string | null;
  vm_ip: string | null;
  vsock_cid: number | null;
  vm_pid: number | null;
  snapshot_path: string | null;
  app_port: number;
  ssh_port: number;
  opencode_port: number;
  opencode_password: string | null;
  status: string;
  status_detail: string | null;
  created_at: string;
  mem_size_mib: number;
  disk_size_gib: number;
}

export interface VMWithRole extends VM {
  role: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  github_id: string | null;
  github_username: string | null;
  google_id: string | null;
  avatar_url: string | null;
  ssh_public_keys: string | null;
  github_token: string | null;
  is_admin: number;
  plan: string;
  trial_started_at: string | null;
  stripe_customer_id: string | null;
  created_at: string;
}

const updateUserSshKeysStmt = db.prepare(
  "UPDATE users SET ssh_public_keys = ? WHERE id = ?"
);
export function updateUserSshKeys(userId: string, keys: string | null): void {
  updateUserSshKeysStmt.run(keys, userId);
}

const clearUserGithubTokenStmt = db.prepare(
  "UPDATE users SET github_token = NULL WHERE id = ?"
);
export function clearUserGithubToken(userId: string): void {
  clearUserGithubTokenStmt.run(userId);
}

// --- VM CRUD ---

const insertVMStmt = db.prepare(`
  INSERT INTO vms (id, name, owner_id, gh_repo, gh_token, container_id, vm_ip, vsock_cid, vm_pid, snapshot_path, app_port, ssh_port, opencode_port, opencode_password, status, mem_size_mib, disk_size_gib)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export function insertVM(vm: Omit<VM, "created_at">): void {
  insertVMStmt.run(
    vm.id, vm.name, vm.owner_id, vm.gh_repo, vm.gh_token,
    vm.container_id, vm.vm_ip, vm.vsock_cid, vm.vm_pid, vm.snapshot_path,
    vm.app_port, vm.ssh_port, vm.opencode_port,
    vm.opencode_password, vm.status, vm.mem_size_mib, vm.disk_size_gib
  );
}

const findVMByIdStmt = db.prepare("SELECT * FROM vms WHERE id = ?");
export function findVMById(id: string): VM | undefined {
  return findVMByIdStmt.get(id) as VM | undefined;
}

const findVMsByUserStmt = db.prepare(`
  SELECT v.*, va.role FROM vms v
  INNER JOIN vm_access va ON va.vm_id = v.id
  WHERE va.user_id = ?
  ORDER BY v.created_at DESC
`);
export function findVMsByUser(userId: string): VMWithRole[] {
  return findVMsByUserStmt.all(userId) as VMWithRole[];
}

const updateVMStatusStmt = db.prepare("UPDATE vms SET status = ? WHERE id = ?");
export function updateVMStatus(id: string, status: string): void {
  updateVMStatusStmt.run(status, id);
}

const updateVMStatusDetailStmt = db.prepare("UPDATE vms SET status_detail = ? WHERE id = ?");
export function updateVMStatusDetail(id: string, detail: string | null): void {
  updateVMStatusDetailStmt.run(detail, id);
}

const updateVMContainerIdStmt = db.prepare("UPDATE vms SET container_id = ? WHERE id = ?");
export function updateVMContainerId(id: string, containerId: string): void {
  updateVMContainerIdStmt.run(containerId, id);
}

const updateVMInfoStmt = db.prepare(
  "UPDATE vms SET container_id = ?, vm_ip = ?, vsock_cid = ?, vm_pid = ? WHERE id = ?"
);
export function updateVMInfo(id: string, vmId: string, vmIp: string, vsockCid: number, vmPid: number | null): void {
  updateVMInfoStmt.run(vmId, vmIp, vsockCid, vmPid, id);
}

const updateVMSnapshotPathStmt = db.prepare("UPDATE vms SET snapshot_path = ? WHERE id = ?");
export function updateVMSnapshotPath(id: string, snapshotPath: string | null): void {
  updateVMSnapshotPathStmt.run(snapshotPath, id);
}

// --- RAM quota ---

const getUserProvisionedRamStmt = db.prepare(`
  SELECT COALESCE(SUM(v.mem_size_mib), 0) as total_ram
  FROM vms v
  INNER JOIN vm_access va ON va.vm_id = v.id
  WHERE va.user_id = ? AND va.role = 'owner'
  AND v.status IN ('running', 'creating')
`);
export function getUserProvisionedRam(userId: string): number {
  const row = getUserProvisionedRamStmt.get(userId) as { total_ram: number };
  return row.total_ram;
}

// --- Disk quota ---

const getUserProvisionedDiskStmt = db.prepare(`
  SELECT COALESCE(SUM(v.disk_size_gib), 0) as total_disk
  FROM vms v
  INNER JOIN vm_access va ON va.vm_id = v.id
  WHERE va.user_id = ? AND va.role = 'owner'
  AND v.status NOT IN ('error')
`);
export function getUserProvisionedDisk(userId: string): number {
  const row = getUserProvisionedDiskStmt.get(userId) as { total_disk: number };
  return row.total_disk;
}

// --- Plan resolution ---

import type { IPlanRegistry } from "../adapters/plan-registry.js";

export interface UserPlan {
  plan: string;
  label: string;
  max_ram_mib: number;
  max_data_bytes: number;
  valid_mem_sizes: number[];
  max_disk_gib: number;
  valid_disk_sizes: number[];
  trial_active: boolean;
  trial_expires_at: string | null;
}

const downgradeStmt = db.prepare(
  "UPDATE users SET plan = ? WHERE id = ?"
);

export function getUserPlan(userId: string, registry: IPlanRegistry): UserPlan {
  const defaultPlan = registry.getDefaultPlan();
  const defaultLimits = registry.getPlanLimits(defaultPlan)!;
  const fallback: UserPlan = { plan: defaultPlan, ...defaultLimits, trial_active: false, trial_expires_at: null };

  const user = findUserById(userId);
  if (!user) return fallback;

  const limits = registry.getPlanLimits(user.plan);
  if (!limits) return fallback;

  // If user is on a non-default plan, check trial logic
  const trialConfig = registry.getTrialConfig();
  if (user.plan !== defaultPlan && trialConfig) {
    // trial_started_at = NULL means permanent grant (no expiry) — e.g. dev-user, admin grants
    if (!user.trial_started_at) {
      return { plan: user.plan, ...limits, trial_active: false, trial_expires_at: null };
    }

    const trialStart = new Date(user.trial_started_at).getTime();
    const expiresAt = new Date(trialStart + trialConfig.duration_ms);

    if (Date.now() < expiresAt.getTime()) {
      return { plan: user.plan, ...limits, trial_active: true, trial_expires_at: expiresAt.toISOString() };
    }

    // Trial expired — lazy downgrade
    downgradeStmt.run(defaultPlan, userId);
    return fallback;
  }

  return { plan: user.plan, ...limits, trial_active: false, trial_expires_at: null };
}

// --- Vsock CID allocation ---

const getUsedCidsStmt = db.prepare(
  "SELECT vsock_cid FROM vms WHERE vsock_cid IS NOT NULL AND status != 'error'"
);
export function getUsedCids(): number[] {
  return (getUsedCidsStmt.all() as { vsock_cid: number }[]).map((r) => r.vsock_cid);
}

// --- SSH proxy lookups ---

const findVMBySshPortStmt = db.prepare("SELECT * FROM vms WHERE ssh_port = ?");
export function findVMBySshPort(port: number): VM | undefined {
  return findVMBySshPortStmt.get(port) as VM | undefined;
}

const getAuthorizedUsersForVMStmt = db.prepare(`
  SELECT u.id, u.ssh_public_keys, u.github_username
  FROM vm_access va
  JOIN users u ON u.id = va.user_id
  WHERE va.vm_id = ?
`);
export function getAuthorizedUsersForVM(vmId: string): { id: string; ssh_public_keys: string | null; github_username: string | null }[] {
  return getAuthorizedUsersForVMStmt.all(vmId) as { id: string; ssh_public_keys: string | null; github_username: string | null }[];
}

// --- All VMs (for SSH proxy startup) ---

const findAllVMsStmt = db.prepare("SELECT * FROM vms WHERE status != 'error'");
export function findAllVMs(): VM[] {
  return findAllVMsStmt.all() as VM[];
}

const deleteVMStmt = db.prepare("DELETE FROM vms WHERE id = ?");
export function deleteVM(id: string): void {
  deleteVMStmt.run(id);
}

// --- Port allocation ---

const getUsedPortsStmt = db.prepare(
  "SELECT app_port, ssh_port, opencode_port FROM vms WHERE status != 'error'"
);
export function getUsedPorts(): { app_port: number; ssh_port: number; opencode_port: number }[] {
  return getUsedPortsStmt.all() as { app_port: number; ssh_port: number; opencode_port: number }[];
}

// --- Access control ---

const grantAccessStmt = db.prepare(`
  INSERT OR REPLACE INTO vm_access (vm_id, user_id, role) VALUES (?, ?, ?)
`);
export function grantAccess(vmId: string, userId: string, role: string): void {
  grantAccessStmt.run(vmId, userId, role);
}

const revokeAccessStmt = db.prepare(
  "DELETE FROM vm_access WHERE vm_id = ? AND user_id = ?"
);
export function revokeAccess(vmId: string, userId: string): void {
  revokeAccessStmt.run(vmId, userId);
}

const revokeAllAccessStmt = db.prepare("DELETE FROM vm_access WHERE vm_id = ?");
export function revokeAllAccess(vmId: string): void {
  revokeAllAccessStmt.run(vmId);
}

const getVMAccessStmt = db.prepare(`
  SELECT va.user_id, va.role, u.email, u.name
  FROM vm_access va
  LEFT JOIN users u ON u.id = va.user_id
  WHERE va.vm_id = ?
`);
export function getVMAccess(vmId: string): { user_id: string; role: string; email: string; name: string | null }[] {
  return getVMAccessStmt.all(vmId) as { user_id: string; role: string; email: string; name: string | null }[];
}

const checkAccessStmt = db.prepare(
  "SELECT role FROM vm_access WHERE vm_id = ? AND user_id = ?"
);
export function checkAccess(vmId: string, userId: string): string | undefined {
  const row = checkAccessStmt.get(vmId, userId) as { role: string } | undefined;
  return row?.role;
}

// --- User lookups (reading from auth's users table) ---

const findUserByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
export function findUserById(id: string): User | undefined {
  return findUserByIdStmt.get(id) as User | undefined;
}

const findUserByEmailStmt = db.prepare("SELECT * FROM users WHERE email = ?");
export function findUserByEmail(email: string): User | undefined {
  return findUserByEmailStmt.get(email) as User | undefined;
}

const findAllUsersWithSshKeysStmt = db.prepare(
  "SELECT id, email, name, github_username, ssh_public_keys, plan FROM users WHERE ssh_public_keys IS NOT NULL AND ssh_public_keys != ''"
);
export function findAllUsersWithSshKeys(): { id: string; email: string; name: string | null; github_username: string | null; ssh_public_keys: string; plan: string }[] {
  return findAllUsersWithSshKeysStmt.all() as any[];
}

const appendUserSshKeyStmt = db.prepare(
  "UPDATE users SET ssh_public_keys = CASE WHEN ssh_public_keys IS NULL OR ssh_public_keys = '' THEN ? ELSE ssh_public_keys || char(10) || ? END WHERE id = ?"
);
export function appendUserSshKey(userId: string, key: string): void {
  appendUserSshKeyStmt.run(key, key, userId);
}

// --- Monthly data usage ---

const getUserMonthlyDataUsageStmt = db.prepare(`
  SELECT COALESCE(SUM(rx_bytes + tx_bytes), 0) as total_bytes
  FROM vm_traffic
  WHERE owner_id = ?
  AND recorded_at >= date('now', 'start of month')
`);
export function getUserMonthlyDataUsage(userId: string): number {
  const row = getUserMonthlyDataUsageStmt.get(userId) as { total_bytes: number };
  return row.total_bytes;
}

// --- VM Traffic ---

const insertTrafficStmt = db.prepare(
  "INSERT INTO vm_traffic (vm_id, owner_id, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)"
);
export function insertTrafficRecord(vmId: string, rxBytes: number, txBytes: number, ownerId?: string): void {
  insertTrafficStmt.run(vmId, ownerId ?? null, rxBytes, txBytes);
}

export function getTrafficHistory(vmId: string, hours: number): { rx_bytes: number; tx_bytes: number; recorded_at: string }[] {
  return db.prepare(
    "SELECT rx_bytes, tx_bytes, recorded_at FROM vm_traffic WHERE vm_id = ? AND recorded_at > datetime('now', '-' || ? || ' hours') ORDER BY recorded_at ASC"
  ).all(vmId, hours) as { rx_bytes: number; tx_bytes: number; recorded_at: string }[];
}

export function getTrafficSummary(hours: number): { vm_id: string; total_rx: number; total_tx: number; samples: number }[] {
  return db.prepare(
    "SELECT vm_id, SUM(rx_bytes) as total_rx, SUM(tx_bytes) as total_tx, COUNT(*) as samples FROM vm_traffic WHERE recorded_at > datetime('now', '-' || ? || ' hours') GROUP BY vm_id ORDER BY total_rx + total_tx DESC"
  ).all(hours) as { vm_id: string; total_rx: number; total_tx: number; samples: number }[];
}

export function pruneOldTraffic(days: number = 7): number {
  const result = db.prepare(
    "DELETE FROM vm_traffic WHERE recorded_at < datetime('now', '-' || ? || ' days')"
  ).run(days);
  return result.changes;
}

// --- Admin Events ---

const insertAdminEventStmt = db.prepare(
  "INSERT INTO admin_events (type, vm_id, user_id, metadata) VALUES (?, ?, ?, ?)"
);
export function emitAdminEvent(type: string, vmId?: string | null, userId?: string | null, metadata?: Record<string, unknown>): void {
  insertAdminEventStmt.run(type, vmId || null, userId || null, metadata ? JSON.stringify(metadata) : null);
}

// --- Agent Sessions ---

export interface AgentSession {
  id: string;
  vm_id: string;
  agent_type: "codex" | "opencode";
  thread_id: string | null;
  title: string | null;
  cwd: string | null;
  status: "idle" | "busy" | "error" | "archived";
  created_at: string;
  updated_at: string;
}

export interface AgentMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: string | null;
  created_at: string;
}

const insertAgentSessionStmt = db.prepare(`
  INSERT INTO agent_sessions (id, vm_id, agent_type, thread_id, title, cwd, status)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
export function insertAgentSession(s: Pick<AgentSession, "id" | "vm_id" | "agent_type" | "thread_id" | "title" | "cwd" | "status">): void {
  insertAgentSessionStmt.run(s.id, s.vm_id, s.agent_type, s.thread_id, s.title, s.cwd, s.status);
}

const findAgentSessionStmt = db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
export function findAgentSession(id: string): AgentSession | undefined {
  return findAgentSessionStmt.get(id) as AgentSession | undefined;
}

const findAgentSessionsByVMStmt = db.prepare(
  "SELECT * FROM agent_sessions WHERE vm_id = ? AND agent_type = ? AND status != 'archived' ORDER BY updated_at DESC"
);
export function findAgentSessionsByVM(vmId: string, agentType: string): AgentSession[] {
  return findAgentSessionsByVMStmt.all(vmId, agentType) as AgentSession[];
}

const updateAgentSessionStatusStmt = db.prepare(
  "UPDATE agent_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
);
export function updateAgentSessionStatus(id: string, status: string): void {
  updateAgentSessionStatusStmt.run(status, id);
}

const updateAgentSessionTitleStmt = db.prepare(
  "UPDATE agent_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
);
export function updateAgentSessionTitle(id: string, title: string): void {
  updateAgentSessionTitleStmt.run(title, id);
}

const updateAgentSessionThreadIdStmt = db.prepare(
  "UPDATE agent_sessions SET thread_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
);
export function updateAgentSessionThreadId(id: string, threadId: string): void {
  updateAgentSessionThreadIdStmt.run(threadId, id);
}

const insertAgentMessageStmt = db.prepare(`
  INSERT INTO agent_messages (id, session_id, role, content, metadata)
  VALUES (?, ?, ?, ?, ?)
`);
export function insertAgentMessage(m: Pick<AgentMessage, "id" | "session_id" | "role" | "content" | "metadata">): void {
  insertAgentMessageStmt.run(m.id, m.session_id, m.role, m.content, m.metadata);
}

const findMessagesBySessionStmt = db.prepare(
  "SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at ASC"
);
export function findMessagesBySession(sessionId: string): AgentMessage[] {
  return findMessagesBySessionStmt.all(sessionId) as AgentMessage[];
}

const deleteAgentMessagesBySessionStmt = db.prepare(
  "DELETE FROM agent_messages WHERE session_id = ?"
);
const deleteAgentSessionStmt = db.prepare(
  "DELETE FROM agent_sessions WHERE id = ?"
);
export function deleteAgentSession(id: string): void {
  deleteAgentMessagesBySessionStmt.run(id);
  deleteAgentSessionStmt.run(id);
}

// --- Stripe helpers ---

const setStripeCustomerIdStmt = db.prepare(
  "UPDATE users SET stripe_customer_id = ? WHERE id = ?"
);
export function setStripeCustomerId(userId: string, customerId: string): void {
  setStripeCustomerIdStmt.run(customerId, userId);
}

const updateUserPlanStmt = db.prepare(
  "UPDATE users SET plan = ?, trial_started_at = NULL WHERE id = ?"
);
export function updateUserPlan(userId: string, plan: string): void {
  updateUserPlanStmt.run(plan, userId);
}

const findUserByStripeCustomerIdStmt = db.prepare(
  "SELECT * FROM users WHERE stripe_customer_id = ?"
);
export function findUserByStripeCustomerId(customerId: string): User | undefined {
  return findUserByStripeCustomerIdStmt.get(customerId) as User | undefined;
}
