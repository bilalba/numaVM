import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IAuthDatabase, User } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stmt = Statement<any[]>;

export class SqliteAuthDatabase implements IAuthDatabase {
  private db: DatabaseType;

  // Prepared statements (initialized after migrations)
  private findUserByIdStmt!: Stmt;
  private findUserByEmailStmt!: Stmt;
  private findUserByGithubIdStmt!: Stmt;
  private findUserByGoogleIdStmt!: Stmt;
  private insertUserStmt!: Stmt;
  private updateUserGithubStmt!: Stmt;
  private updateUserGoogleStmt!: Stmt;
  private updateUserGithubTokenStmt!: Stmt;
  private updateUserSshKeysStmt!: Stmt;
  private checkVMAccessStmt!: Stmt;
  private findVMIdByNameStmt!: Stmt;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? join(__dirname, "..", "..", "..", "platform.db");
    this.db = new Database(resolvedPath);
    this.runMigrations();
    this.prepareStatements();
  }

  runMigrations(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // Run schema
    const schema = readFileSync(join(__dirname, "..", "..", "db", "schema.sql"), "utf-8");
    this.db.exec(schema);

    // Column migrations (ALTER TABLE doesn't support IF NOT EXISTS in SQLite)
    try { this.db.exec("ALTER TABLE users ADD COLUMN github_username TEXT"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE users ADD COLUMN ssh_public_keys TEXT"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE users ADD COLUMN github_token TEXT"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'base'"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE users ADD COLUMN trial_started_at DATETIME"); } catch { /* already exists */ }

    // Backfill: set trial_started_at for existing base users who don't have it
    this.db.exec("UPDATE users SET trial_started_at = created_at WHERE trial_started_at IS NULL AND plan = 'base' AND id != 'dev-user'");

    // Rename env_access → vm_access migration
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
    if (tables.includes("env_access") && !tables.includes("vm_access")) {
      this.db.pragma("foreign_keys = OFF");
      this.db.exec(`
        ALTER TABLE env_access RENAME TO vm_access;
        ALTER TABLE vm_access RENAME COLUMN env_id TO vm_id;
      `);
      this.db.pragma("foreign_keys = ON");
    }

    // Seed admin user from env var
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      this.db.prepare("UPDATE users SET is_admin = 1 WHERE email = ?").run(adminEmail);
    }
  }

  private prepareStatements(): void {
    this.findUserByIdStmt = this.db.prepare("SELECT * FROM users WHERE id = ?");
    this.findUserByEmailStmt = this.db.prepare("SELECT * FROM users WHERE email = ?");
    this.findUserByGithubIdStmt = this.db.prepare("SELECT * FROM users WHERE github_id = ?");
    this.findUserByGoogleIdStmt = this.db.prepare("SELECT * FROM users WHERE google_id = ?");
    this.insertUserStmt = this.db.prepare(`
      INSERT INTO users (id, email, name, github_id, github_username, google_id, avatar_url, trial_started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    this.updateUserGithubStmt = this.db.prepare(`
      UPDATE users SET github_id = ?, github_username = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url)
      WHERE id = ?
    `);
    this.updateUserGoogleStmt = this.db.prepare(`
      UPDATE users SET google_id = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url)
      WHERE id = ?
    `);
    this.updateUserGithubTokenStmt = this.db.prepare("UPDATE users SET github_token = ? WHERE id = ?");
    this.updateUserSshKeysStmt = this.db.prepare("UPDATE users SET ssh_public_keys = ? WHERE id = ?");
    this.checkVMAccessStmt = this.db.prepare("SELECT role FROM vm_access WHERE vm_id = ? AND user_id = ?");
    this.findVMIdByNameStmt = this.db.prepare("SELECT id FROM vms WHERE name = ?");
  }

  async findUserById(id: string): Promise<User | undefined> {
    return this.findUserByIdStmt.get(id) as User | undefined;
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    return this.findUserByEmailStmt.get(email) as User | undefined;
  }

  async findUserByGithubId(githubId: string): Promise<User | undefined> {
    return this.findUserByGithubIdStmt.get(githubId) as User | undefined;
  }

  async findUserByGoogleId(googleId: string): Promise<User | undefined> {
    return this.findUserByGoogleIdStmt.get(googleId) as User | undefined;
  }

  async upsertUserFromGithub(params: {
    id: string;
    email: string;
    name: string | null;
    githubId: string;
    githubUsername: string;
    avatarUrl: string | null;
  }): Promise<User> {
    const existing = (await this.findUserByGithubId(params.githubId)) ?? (await this.findUserByEmail(params.email));
    if (existing) {
      this.updateUserGithubStmt.run(params.githubId, params.githubUsername, params.name, params.avatarUrl, existing.id);
      return (await this.findUserById(existing.id))!;
    }
    this.insertUserStmt.run(params.id, params.email, params.name, params.githubId, params.githubUsername, null, params.avatarUrl);
    return (await this.findUserById(params.id))!;
  }

  async upsertUserFromGoogle(params: {
    id: string;
    email: string;
    name: string | null;
    googleId: string;
    avatarUrl: string | null;
  }): Promise<User> {
    const existing = (await this.findUserByGoogleId(params.googleId)) ?? (await this.findUserByEmail(params.email));
    if (existing) {
      this.updateUserGoogleStmt.run(params.googleId, params.name, params.avatarUrl, existing.id);
      return (await this.findUserById(existing.id))!;
    }
    this.insertUserStmt.run(params.id, params.email, params.name, null, null, params.googleId, params.avatarUrl);
    return (await this.findUserById(params.id))!;
  }

  async upsertUserFromEmail(params: { id: string; email: string }): Promise<User> {
    const existing = await this.findUserByEmail(params.email);
    if (existing) return existing;
    this.insertUserStmt.run(params.id, params.email, null, null, null, null, null);
    return (await this.findUserById(params.id))!;
  }

  async updateUserGithubToken(userId: string, token: string | null): Promise<void> {
    this.updateUserGithubTokenStmt.run(token, userId);
  }

  async updateUserSshKeys(userId: string, keys: string | null): Promise<void> {
    this.updateUserSshKeysStmt.run(keys, userId);
  }

  async checkVMAccess(vmId: string, userId: string): Promise<string | undefined> {
    const row = this.checkVMAccessStmt.get(vmId, userId) as { role: string } | undefined;
    return row?.role;
  }

  async findVMIdByName(name: string): Promise<string | undefined> {
    const row = this.findVMIdByNameStmt.get(name) as { id: string } | undefined;
    return row?.id;
  }
}
