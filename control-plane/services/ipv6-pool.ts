import { readFileSync } from "node:fs";

/**
 * IPv6 Pool-Based Allocation
 *
 * Loads public IPv6 addresses from VM_IPV6_POOL (comma-separated) or
 * VM_IPV6_POOL_FILE (one per line). Each VM gets one address from the pool,
 * mapped to an internal ULA address via DNAT/SNAT on the host.
 */

let _pool: string[] | undefined;

function loadPool(): string[] {
  // Comma-separated list
  const inline = process.env.VM_IPV6_POOL?.trim();
  if (inline) {
    return inline.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // File with one address per line
  const file = process.env.VM_IPV6_POOL_FILE?.trim();
  if (file) {
    try {
      const content = readFileSync(file, "utf-8");
      return content.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    } catch (err) {
      console.error(`[ipv6-pool] Failed to read pool file ${file}:`, err);
      return [];
    }
  }

  return [];
}

/** Get the IPv6 address pool. Lazy-loaded and cached. */
export function getIPv6Pool(): string[] {
  if (_pool === undefined) {
    _pool = loadPool();
    if (_pool.length > 0) {
      console.log(`[ipv6-pool] Loaded ${_pool.length} IPv6 addresses from pool`);
    }
  }
  return _pool;
}

/** Whether an IPv6 pool is configured. */
export function hasIPv6Pool(): boolean {
  return getIPv6Pool().length > 0;
}

/** Pick the first pool address not already in use. Returns null if pool is exhausted. */
export function allocateFromPool(usedAddresses: string[]): string | null {
  const pool = getIPv6Pool();
  if (pool.length === 0) return null;

  const used = new Set(usedAddresses);
  for (const addr of pool) {
    if (!used.has(addr)) return addr;
  }

  console.warn(`[ipv6-pool] Pool exhausted (${pool.length} addresses, all in use)`);
  return null;
}
