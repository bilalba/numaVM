import type { IAuthDatabase } from "./types.js";

export interface AuthProviders {
  database: IAuthDatabase;
}

let providers: AuthProviders | null = null;

export function getAuthProviders(): AuthProviders {
  if (!providers) throw new Error("Auth providers not initialized. Call initAuthProviders() first.");
  return providers;
}

export function getAuthDatabase(): IAuthDatabase {
  return getAuthProviders().database;
}

/**
 * Initialize auth providers with OSS defaults, optionally overridden by enterprise implementations.
 *
 * Usage (OSS):
 *   await initAuthProviders();
 *
 * Usage (enterprise plugin):
 *   await initAuthProviders({
 *     database: new PostgresAuthDatabase(process.env.PG_URL!),
 *   });
 */
export async function initAuthProviders(overrides?: Partial<AuthProviders>): Promise<AuthProviders> {
  const { SqliteAuthDatabase } = await import("./impl/sqlite-auth-db.js");

  providers = {
    database: overrides?.database ?? new SqliteAuthDatabase(),
  };

  return providers;
}
