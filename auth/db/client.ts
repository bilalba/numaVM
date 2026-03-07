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

// Column migrations (ALTER TABLE doesn't support IF NOT EXISTS in SQLite)
try { db.exec("ALTER TABLE users ADD COLUMN github_username TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN ssh_public_keys TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN github_token TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'base'"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN trial_started_at DATETIME"); } catch { /* already exists */ }

// Backfill: set trial_started_at for existing base users who don't have it
db.exec("UPDATE users SET trial_started_at = created_at WHERE trial_started_at IS NULL AND plan = 'base' AND id != 'dev-user'");

// Seed admin user from env var
const adminEmail = process.env.ADMIN_EMAIL;
if (adminEmail) {
  db.prepare("UPDATE users SET is_admin = 1 WHERE email = ?").run(adminEmail);
}

export { db };

// --- Query helpers ---

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
  created_at: string;
}

const updateUserSshKeysStmt = db.prepare(
  "UPDATE users SET ssh_public_keys = ? WHERE id = ?"
);
export function updateUserSshKeys(userId: string, keys: string | null): void {
  updateUserSshKeysStmt.run(keys, userId);
}

const updateUserGithubTokenStmt = db.prepare(
  "UPDATE users SET github_token = ? WHERE id = ?"
);
export function updateUserGithubToken(userId: string, token: string | null): void {
  updateUserGithubTokenStmt.run(token, userId);
}

const findUserByEmailStmt = db.prepare("SELECT * FROM users WHERE email = ?");
export function findUserByEmail(email: string): User | undefined {
  return findUserByEmailStmt.get(email) as User | undefined;
}

const findUserByGithubIdStmt = db.prepare(
  "SELECT * FROM users WHERE github_id = ?"
);
export function findUserByGithubId(githubId: string): User | undefined {
  return findUserByGithubIdStmt.get(githubId) as User | undefined;
}

const findUserByGoogleIdStmt = db.prepare(
  "SELECT * FROM users WHERE google_id = ?"
);
export function findUserByGoogleId(googleId: string): User | undefined {
  return findUserByGoogleIdStmt.get(googleId) as User | undefined;
}

const findUserByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
export function findUserById(id: string): User | undefined {
  return findUserByIdStmt.get(id) as User | undefined;
}

const insertUserStmt = db.prepare(`
  INSERT INTO users (id, email, name, github_id, github_username, google_id, avatar_url, trial_started_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);

const updateUserGithubStmt = db.prepare(`
  UPDATE users SET github_id = ?, github_username = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url)
  WHERE id = ?
`);

const updateUserGoogleStmt = db.prepare(`
  UPDATE users SET google_id = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url)
  WHERE id = ?
`);

export function upsertUserFromGithub(params: {
  id: string;
  email: string;
  name: string | null;
  githubId: string;
  githubUsername: string;
  avatarUrl: string | null;
}): User {
  const existing = findUserByGithubId(params.githubId) ?? findUserByEmail(params.email);
  if (existing) {
    updateUserGithubStmt.run(params.githubId, params.githubUsername, params.name, params.avatarUrl, existing.id);
    return findUserById(existing.id)!;
  }
  insertUserStmt.run(params.id, params.email, params.name, params.githubId, params.githubUsername, null, params.avatarUrl);
  return findUserById(params.id)!;
}

export function upsertUserFromGoogle(params: {
  id: string;
  email: string;
  name: string | null;
  googleId: string;
  avatarUrl: string | null;
}): User {
  const existing = findUserByGoogleId(params.googleId) ?? findUserByEmail(params.email);
  if (existing) {
    updateUserGoogleStmt.run(params.googleId, params.name, params.avatarUrl, existing.id);
    return findUserById(existing.id)!;
  }
  insertUserStmt.run(params.id, params.email, params.name, null, null, params.googleId, params.avatarUrl);
  return findUserById(params.id)!;
}

export function upsertUserFromEmail(params: {
  id: string;
  email: string;
}): User {
  const existing = findUserByEmail(params.email);
  if (existing) return existing;
  insertUserStmt.run(params.id, params.email, null, null, null, null, null);
  return findUserById(params.id)!;
}

// --- Migration: rename env_access → vm_access ---
const authTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
if (authTables.includes("env_access") && !authTables.includes("vm_access")) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    ALTER TABLE env_access RENAME TO vm_access;
    ALTER TABLE vm_access RENAME COLUMN env_id TO vm_id;
  `);
  db.pragma("foreign_keys = ON");
}

const checkVMAccessStmt = db.prepare(
  "SELECT role FROM vm_access WHERE vm_id = ? AND user_id = ?"
);
export function checkVMAccess(
  vmId: string,
  userId: string
): string | undefined {
  const row = checkVMAccessStmt.get(vmId, userId) as
    | { role: string }
    | undefined;
  return row?.role;
}
