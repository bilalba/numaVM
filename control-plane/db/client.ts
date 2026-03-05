import Database, { type Database as DatabaseType } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = join(__dirname, "..", "..", "platform.db");
const db: DatabaseType = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Run schema migrations
const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

// Migrate existing envs table: add Firecracker columns + update CHECK constraint
const envColumns = db.pragma("table_info(envs)") as { name: string }[];
const colNames = new Set(envColumns.map((c) => c.name));
if (!colNames.has("vm_ip")) {
  // Need to recreate table to add columns AND update the status CHECK constraint
  // (SQLite doesn't support ALTER COLUMN or modifying constraints)
  // Temporarily disable FK checks for the migration
  db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE IF NOT EXISTS envs_new (
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
    INSERT INTO envs_new (id, name, owner_id, gh_repo, gh_token, container_id, app_port, ssh_port, opencode_port, opencode_password, status, created_at)
      SELECT id, name, owner_id, gh_repo, gh_token, container_id, app_port, ssh_port, opencode_port, opencode_password, status, created_at FROM envs;
    DROP TABLE envs;
    ALTER TABLE envs_new RENAME TO envs;
    CREATE INDEX IF NOT EXISTS idx_envs_owner ON envs(owner_id);
    CREATE INDEX IF NOT EXISTS idx_envs_status ON envs(status);
  `);
  db.pragma("foreign_keys = ON");
}

// Migrate: make gh_repo/gh_token nullable (was NOT NULL in earlier schema)
// Clean up any leftover temp table from a previously failed migration
db.exec("DROP TABLE IF EXISTS envs_mig2");
const ghRepoCol = (db.pragma("table_info(envs)") as { name: string; notnull: number }[])
  .find((c) => c.name === "gh_repo");
if (ghRepoCol && ghRepoCol.notnull === 1) {
  db.pragma("foreign_keys = OFF");
  // Build envs_mig2 with all current columns from envs (including any added like pages_port)
  const currentCols = (db.pragma("table_info(envs)") as { name: string }[]).map((c) => c.name);
  const colList = currentCols.join(", ");
  db.exec(`
    CREATE TABLE envs_mig2 (
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
    INSERT INTO envs_mig2 (${colList}) SELECT ${colList} FROM envs;
    DROP TABLE envs;
    ALTER TABLE envs_mig2 RENAME TO envs;
    CREATE INDEX IF NOT EXISTS idx_envs_owner ON envs(owner_id);
    CREATE INDEX IF NOT EXISTS idx_envs_status ON envs(status);
  `);
  db.pragma("foreign_keys = ON");
}

// Migrate: add cwd column to agent_sessions
const agentSessionCols = db.pragma("table_info(agent_sessions)") as { name: string }[];
if (!agentSessionCols.some((c) => c.name === "cwd")) {
  db.exec("ALTER TABLE agent_sessions ADD COLUMN cwd TEXT");
}

export { db };

// --- Types ---

export interface Env {
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
  created_at: string;
}

export interface EnvWithRole extends Env {
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

// --- Env CRUD ---

const insertEnvStmt = db.prepare(`
  INSERT INTO envs (id, name, owner_id, gh_repo, gh_token, container_id, vm_ip, vsock_cid, vm_pid, snapshot_path, app_port, ssh_port, opencode_port, opencode_password, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export function insertEnv(env: Omit<Env, "created_at">): void {
  insertEnvStmt.run(
    env.id, env.name, env.owner_id, env.gh_repo, env.gh_token,
    env.container_id, env.vm_ip, env.vsock_cid, env.vm_pid, env.snapshot_path,
    env.app_port, env.ssh_port, env.opencode_port,
    env.opencode_password, env.status
  );
}

const findEnvByIdStmt = db.prepare("SELECT * FROM envs WHERE id = ?");
export function findEnvById(id: string): Env | undefined {
  return findEnvByIdStmt.get(id) as Env | undefined;
}

const findEnvsByUserStmt = db.prepare(`
  SELECT e.*, ea.role FROM envs e
  INNER JOIN env_access ea ON ea.env_id = e.id
  WHERE ea.user_id = ?
  ORDER BY e.created_at DESC
`);
export function findEnvsByUser(userId: string): EnvWithRole[] {
  return findEnvsByUserStmt.all(userId) as EnvWithRole[];
}

const updateEnvStatusStmt = db.prepare("UPDATE envs SET status = ? WHERE id = ?");
export function updateEnvStatus(id: string, status: string): void {
  updateEnvStatusStmt.run(status, id);
}

const updateEnvContainerIdStmt = db.prepare("UPDATE envs SET container_id = ? WHERE id = ?");
export function updateEnvContainerId(id: string, containerId: string): void {
  updateEnvContainerIdStmt.run(containerId, id);
}

const updateEnvVmInfoStmt = db.prepare(
  "UPDATE envs SET container_id = ?, vm_ip = ?, vsock_cid = ?, vm_pid = ? WHERE id = ?"
);
export function updateEnvVmInfo(id: string, vmId: string, vmIp: string, vsockCid: number, vmPid: number | null): void {
  updateEnvVmInfoStmt.run(vmId, vmIp, vsockCid, vmPid, id);
}

const updateEnvSnapshotPathStmt = db.prepare("UPDATE envs SET snapshot_path = ? WHERE id = ?");
export function updateEnvSnapshotPath(id: string, snapshotPath: string | null): void {
  updateEnvSnapshotPathStmt.run(snapshotPath, id);
}

// --- Vsock CID allocation ---

const getUsedCidsStmt = db.prepare(
  "SELECT vsock_cid FROM envs WHERE vsock_cid IS NOT NULL AND status != 'error'"
);
export function getUsedCids(): number[] {
  return (getUsedCidsStmt.all() as { vsock_cid: number }[]).map((r) => r.vsock_cid);
}

// --- SSH proxy lookups ---

const findEnvBySshPortStmt = db.prepare("SELECT * FROM envs WHERE ssh_port = ?");
export function findEnvBySshPort(port: number): Env | undefined {
  return findEnvBySshPortStmt.get(port) as Env | undefined;
}

const getAuthorizedUsersForEnvStmt = db.prepare(`
  SELECT u.id, u.ssh_public_keys, u.github_username
  FROM env_access ea
  JOIN users u ON u.id = ea.user_id
  WHERE ea.env_id = ?
`);
export function getAuthorizedUsersForEnv(envId: string): { id: string; ssh_public_keys: string | null; github_username: string | null }[] {
  return getAuthorizedUsersForEnvStmt.all(envId) as { id: string; ssh_public_keys: string | null; github_username: string | null }[];
}

// --- All envs (for SSH proxy startup) ---

const findAllEnvsStmt = db.prepare("SELECT * FROM envs WHERE status != 'error'");
export function findAllEnvs(): Env[] {
  return findAllEnvsStmt.all() as Env[];
}

const deleteEnvStmt = db.prepare("DELETE FROM envs WHERE id = ?");
export function deleteEnv(id: string): void {
  deleteEnvStmt.run(id);
}

// --- Port allocation ---

const getUsedPortsStmt = db.prepare(
  "SELECT app_port, ssh_port, opencode_port FROM envs WHERE status != 'error'"
);
export function getUsedPorts(): { app_port: number; ssh_port: number; opencode_port: number }[] {
  return getUsedPortsStmt.all() as { app_port: number; ssh_port: number; opencode_port: number }[];
}

// --- Access control ---

const grantAccessStmt = db.prepare(`
  INSERT OR REPLACE INTO env_access (env_id, user_id, role) VALUES (?, ?, ?)
`);
export function grantAccess(envId: string, userId: string, role: string): void {
  grantAccessStmt.run(envId, userId, role);
}

const revokeAccessStmt = db.prepare(
  "DELETE FROM env_access WHERE env_id = ? AND user_id = ?"
);
export function revokeAccess(envId: string, userId: string): void {
  revokeAccessStmt.run(envId, userId);
}

const revokeAllAccessStmt = db.prepare("DELETE FROM env_access WHERE env_id = ?");
export function revokeAllAccess(envId: string): void {
  revokeAllAccessStmt.run(envId);
}

const getEnvAccessStmt = db.prepare(`
  SELECT ea.user_id, ea.role, u.email, u.name
  FROM env_access ea
  LEFT JOIN users u ON u.id = ea.user_id
  WHERE ea.env_id = ?
`);
export function getEnvAccess(envId: string): { user_id: string; role: string; email: string; name: string | null }[] {
  return getEnvAccessStmt.all(envId) as { user_id: string; role: string; email: string; name: string | null }[];
}

const checkAccessStmt = db.prepare(
  "SELECT role FROM env_access WHERE env_id = ? AND user_id = ?"
);
export function checkAccess(envId: string, userId: string): string | undefined {
  const row = checkAccessStmt.get(envId, userId) as { role: string } | undefined;
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

// --- VM Traffic ---

const insertTrafficStmt = db.prepare(
  "INSERT INTO vm_traffic (env_id, rx_bytes, tx_bytes) VALUES (?, ?, ?)"
);
export function insertTrafficRecord(envId: string, rxBytes: number, txBytes: number): void {
  insertTrafficStmt.run(envId, rxBytes, txBytes);
}

export function getTrafficHistory(envId: string, hours: number): { rx_bytes: number; tx_bytes: number; recorded_at: string }[] {
  return db.prepare(
    "SELECT rx_bytes, tx_bytes, recorded_at FROM vm_traffic WHERE env_id = ? AND recorded_at > datetime('now', '-' || ? || ' hours') ORDER BY recorded_at ASC"
  ).all(envId, hours) as { rx_bytes: number; tx_bytes: number; recorded_at: string }[];
}

export function getTrafficSummary(hours: number): { env_id: string; total_rx: number; total_tx: number; samples: number }[] {
  return db.prepare(
    "SELECT env_id, SUM(rx_bytes) as total_rx, SUM(tx_bytes) as total_tx, COUNT(*) as samples FROM vm_traffic WHERE recorded_at > datetime('now', '-' || ? || ' hours') GROUP BY env_id ORDER BY total_rx + total_tx DESC"
  ).all(hours) as { env_id: string; total_rx: number; total_tx: number; samples: number }[];
}

export function pruneOldTraffic(days: number = 7): number {
  const result = db.prepare(
    "DELETE FROM vm_traffic WHERE recorded_at < datetime('now', '-' || ? || ' days')"
  ).run(days);
  return result.changes;
}

// --- Admin Events ---

const insertAdminEventStmt = db.prepare(
  "INSERT INTO admin_events (type, env_id, user_id, metadata) VALUES (?, ?, ?, ?)"
);
export function emitAdminEvent(type: string, envId?: string | null, userId?: string | null, metadata?: Record<string, unknown>): void {
  insertAdminEventStmt.run(type, envId || null, userId || null, metadata ? JSON.stringify(metadata) : null);
}

// --- Agent Sessions ---

export interface AgentSession {
  id: string;
  env_id: string;
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
  INSERT INTO agent_sessions (id, env_id, agent_type, thread_id, title, cwd, status)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
export function insertAgentSession(s: Pick<AgentSession, "id" | "env_id" | "agent_type" | "thread_id" | "title" | "cwd" | "status">): void {
  insertAgentSessionStmt.run(s.id, s.env_id, s.agent_type, s.thread_id, s.title, s.cwd, s.status);
}

const findAgentSessionStmt = db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
export function findAgentSession(id: string): AgentSession | undefined {
  return findAgentSessionStmt.get(id) as AgentSession | undefined;
}

const findAgentSessionsByEnvStmt = db.prepare(
  "SELECT * FROM agent_sessions WHERE env_id = ? AND agent_type = ? AND status != 'archived' ORDER BY updated_at DESC"
);
export function findAgentSessionsByEnv(envId: string, agentType: string): AgentSession[] {
  return findAgentSessionsByEnvStmt.all(envId, agentType) as AgentSession[];
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
