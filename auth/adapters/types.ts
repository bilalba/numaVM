// Auth database adapter interface

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

export interface IAuthDatabase {
  // User lookups
  findUserById(id: string): Promise<User | undefined>;
  findUserByEmail(email: string): Promise<User | undefined>;
  findUserByGithubId(githubId: string): Promise<User | undefined>;
  findUserByGoogleId(googleId: string): Promise<User | undefined>;

  // User upserts (OAuth + email flows)
  upsertUserFromGithub(params: {
    id: string;
    email: string;
    name: string | null;
    githubId: string;
    githubUsername: string;
    avatarUrl: string | null;
  }): Promise<User>;
  upsertUserFromGoogle(params: {
    id: string;
    email: string;
    name: string | null;
    googleId: string;
    avatarUrl: string | null;
  }): Promise<User>;
  upsertUserFromEmail(params: { id: string; email: string }): Promise<User>;

  // User updates
  updateUserGithubToken(userId: string, token: string | null): Promise<void>;
  updateUserSshKeys(userId: string, keys: string | null): Promise<void>;

  // Access control
  checkVMAccess(vmId: string, userId: string): Promise<string | undefined>;

  // Init
  runMigrations(): void;
}
