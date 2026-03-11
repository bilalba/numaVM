import type { IDatabase } from "./database.js";
import type { IVMEngine } from "./vm-engine.js";
import type { IReverseProxy } from "./reverse-proxy.js";
import type { IStateStore } from "./state-store.js";
import type { IIdleMonitor } from "./idle-monitor.js";
import type { IPlanRegistry } from "./plan-registry.js";
import type { IBillingProvider } from "./billing-provider.js";
import type { IVMLifecycleHook } from "./vm-lifecycle-hook.js";

export interface Providers {
  database: IDatabase;
  vmEngine: IVMEngine;
  reverseProxy: IReverseProxy;
  stateStore: IStateStore;
  idleMonitor: IIdleMonitor;
  planRegistry: IPlanRegistry;
  billing: IBillingProvider;
  lifecycleHook: IVMLifecycleHook;
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
export function getPlanRegistry(): IPlanRegistry { return getProviders().planRegistry; }
export function getBilling(): IBillingProvider { return getProviders().billing; }
export function getLifecycleHook(): IVMLifecycleHook { return getProviders().lifecycleHook; }

/**
 * Initialize providers with OSS defaults, optionally overridden by enterprise implementations.
 *
 * Usage (OSS):
 *   await initProviders();
 *
 * Usage (with custom providers):
 *   await initProviders({
 *     planRegistry: myPlanRegistry,
 *     billing: myBillingProvider,
 *   });
 */
export async function initProviders(overrides?: Partial<Providers>): Promise<Providers> {
  const { SqliteDatabase } = await import("./impl/sqlite-database.js");
  const { FirecrackerEngine } = await import("./impl/firecracker-engine.js");
  const { CaddyProxy } = await import("./impl/caddy-proxy.js");
  const { InMemoryStateStore } = await import("./impl/memory-state-store.js");
  const { LocalIdleMonitor } = await import("./impl/local-idle-monitor.js");
  const { CommunityPlanRegistry } = await import("./impl/community-plan-registry.js");
  const { NoBillingProvider } = await import("./impl/no-billing.js");
  const { NoopLifecycleHook } = await import("./impl/noop-lifecycle-hook.js");

  providers = {
    database: overrides?.database ?? new SqliteDatabase(),
    vmEngine: overrides?.vmEngine ?? new FirecrackerEngine(),
    reverseProxy: overrides?.reverseProxy ?? new CaddyProxy(),
    stateStore: overrides?.stateStore ?? new InMemoryStateStore(),
    idleMonitor: overrides?.idleMonitor ?? new LocalIdleMonitor(),
    planRegistry: overrides?.planRegistry ?? new CommunityPlanRegistry(),
    billing: overrides?.billing ?? new NoBillingProvider(),
    lifecycleHook: overrides?.lifecycleHook ?? new NoopLifecycleHook(),
  };

  return providers;
}
