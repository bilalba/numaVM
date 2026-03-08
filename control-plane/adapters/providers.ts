import type { IDatabase } from "./database.js";
import type { IVMEngine } from "./vm-engine.js";
import type { IReverseProxy } from "./reverse-proxy.js";
import type { IStateStore } from "./state-store.js";
import type { IIdleMonitor } from "./idle-monitor.js";

export interface Providers {
  database: IDatabase;
  vmEngine: IVMEngine;
  reverseProxy: IReverseProxy;
  stateStore: IStateStore;
  idleMonitor: IIdleMonitor;
}

let providers: Providers | null = null;

export function getProviders(): Providers {
  if (!providers) throw new Error("Providers not initialized. Call initProviders() first.");
  return providers;
}

// Convenience accessors
export function getDatabase(): IDatabase { return getProviders().database; }
export function getVMEngine(): IVMEngine { return getProviders().vmEngine; }
export function getReverseProxy(): IReverseProxy { return getProviders().reverseProxy; }
export function getStateStore(): IStateStore { return getProviders().stateStore; }
export function getIdleMonitor(): IIdleMonitor { return getProviders().idleMonitor; }

/**
 * Initialize providers with OSS defaults, optionally overridden by enterprise implementations.
 *
 * Usage (OSS):
 *   await initProviders();
 *
 * Usage (enterprise plugin):
 *   await initProviders({
 *     database: new PostgresDatabase(process.env.PG_URL!),
 *     stateStore: new RedisStateStore(process.env.REDIS_URL!),
 *   });
 */
export async function initProviders(overrides?: Partial<Providers>): Promise<Providers> {
  const { SqliteDatabase } = await import("./impl/sqlite-database.js");
  const { FirecrackerEngine } = await import("./impl/firecracker-engine.js");
  const { CaddyProxy } = await import("./impl/caddy-proxy.js");
  const { InMemoryStateStore } = await import("./impl/memory-state-store.js");
  const { LocalIdleMonitor } = await import("./impl/local-idle-monitor.js");

  providers = {
    database: overrides?.database ?? new SqliteDatabase(),
    vmEngine: overrides?.vmEngine ?? new FirecrackerEngine(),
    reverseProxy: overrides?.reverseProxy ?? new CaddyProxy(),
    stateStore: overrides?.stateStore ?? new InMemoryStateStore(),
    idleMonitor: overrides?.idleMonitor ?? new LocalIdleMonitor(),
  };

  return providers;
}
