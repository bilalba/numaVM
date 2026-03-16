import { getDatabase } from "../adapters/providers.js";
import { hasIPv6Pool, allocateFromPool } from "./ipv6-pool.js";

const APP_PORT_BASE = 10001;
const SSH_PORT_BASE = 20001;
const OPENCODE_PORT_BASE = 30001;
const PORT_RANGE = 999;

// Vsock CIDs: 0-2 are reserved, start from 3
const VSOCK_CID_START = 3;
const VSOCK_CID_MAX = 65535;

// VM IP allocation: 172.16.0.0/16 subnet, .1 is gateway
const VM_IP_BASE_OCTET = 2; // Start from 172.16.0.2

const LOCAL_HOST_KEY = "__local__";

// In-flight reservations: ports allocated but not yet committed to DB.
// Prevents concurrent allocateResources() calls from returning the same port.
// Each entry auto-expires after 60s in case the VM creation fails without cleanup.
const RESERVATION_TTL_MS = 60_000;

// Per-host in-flight maps: outer key = hostId (or "__local__"), inner = port → expiry
const inflightApp = new Map<string, Map<number, number>>();
const inflightSsh = new Map<string, Map<number, number>>();
const inflightOpencode = new Map<string, Map<number, number>>();
const inflightCids = new Map<string, Map<number, number>>();

function getHostMap(outer: Map<string, Map<number, number>>, hostKey: string): Map<number, number> {
  let m = outer.get(hostKey);
  if (!m) {
    m = new Map();
    outer.set(hostKey, m);
  }
  return m;
}

function pruneExpired(m: Map<number, number>): void {
  const now = Date.now();
  for (const [key, expiry] of m) {
    if (now >= expiry) m.delete(key);
  }
}

function reserveInflight(m: Map<number, number>, value: number): void {
  m.set(value, Date.now() + RESERVATION_TTL_MS);
}

/** Release in-flight reservations for a set of ports/CID (called after DB insert or on failure). */
export function releaseReservation(resources: { appPort: number; sshPort: number; opencodePort: number; vsockCid: number }, hostId?: string): void {
  const hostKey = hostId ?? LOCAL_HOST_KEY;
  getHostMap(inflightApp, hostKey).delete(resources.appPort);
  getHostMap(inflightSsh, hostKey).delete(resources.sshPort);
  getHostMap(inflightOpencode, hostKey).delete(resources.opencodePort);
  getHostMap(inflightCids, hostKey).delete(resources.vsockCid);
}

function nextAvailable(used: Set<number>, base: number): number {
  const max = base + PORT_RANGE;
  for (let port = base; port <= max; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`No available ports in range ${base}-${max}`);
}

export function allocatePorts(hostId?: string): { appPort: number; sshPort: number; opencodePort: number } {
  const hostKey = hostId ?? LOCAL_HOST_KEY;

  const appMap = getHostMap(inflightApp, hostKey);
  const sshMap = getHostMap(inflightSsh, hostKey);
  const ocMap = getHostMap(inflightOpencode, hostKey);

  // Prune expired in-flight reservations
  pruneExpired(appMap);
  pruneExpired(sshMap);
  pruneExpired(ocMap);

  // Query DB scoped to this host
  const rows = hostId
    ? getDatabase().getUsedPortsByHost(hostId)
    : getDatabase().getUsedPorts();

  const usedApp = new Set([...rows.map((r) => r.app_port), ...appMap.keys()]);
  const usedSsh = new Set([...rows.map((r) => r.ssh_port), ...sshMap.keys()]);
  const usedOpencode = new Set([...rows.map((r) => r.opencode_port), ...ocMap.keys()]);

  const appPort = nextAvailable(usedApp, APP_PORT_BASE);
  const sshPort = nextAvailable(usedSsh, SSH_PORT_BASE);
  const opencodePort = nextAvailable(usedOpencode, OPENCODE_PORT_BASE);

  // Reserve so concurrent calls get different ports
  reserveInflight(appMap, appPort);
  reserveInflight(sshMap, sshPort);
  reserveInflight(ocMap, opencodePort);

  return { appPort, sshPort, opencodePort };
}

/**
 * Allocate a vsock CID for a new VM.
 * When hostId is provided, scopes to that host (different hosts can reuse CIDs).
 */
export function allocateCid(hostId?: string): number {
  const hostKey = hostId ?? LOCAL_HOST_KEY;
  const cidMap = getHostMap(inflightCids, hostKey);
  pruneExpired(cidMap);

  const dbCids = hostId
    ? getDatabase().getUsedCidsByHost(hostId)
    : getDatabase().getUsedCids();
  const usedCids = new Set([...dbCids, ...cidMap.keys()]);

  for (let cid = VSOCK_CID_START; cid <= VSOCK_CID_MAX; cid++) {
    if (!usedCids.has(cid)) {
      reserveInflight(cidMap, cid);
      return cid;
    }
  }
  throw new Error("No available vsock CIDs");
}

/**
 * Allocate a VM IP address on the 172.16.0.0/16 subnet.
 * Uses the vsock CID to derive a unique IP (simplifies mapping).
 */
export function cidToVmIp(cid: number): string {
  // Map CID to IP: CID 3 → 172.16.0.2, CID 4 → 172.16.0.3, etc.
  // For CIDs > 253, use higher octets: CID 256 → 172.16.1.0
  const offset = cid - VSOCK_CID_START + VM_IP_BASE_OCTET;
  const thirdOctet = Math.floor(offset / 256);
  const fourthOctet = offset % 256;
  return `172.16.${thirdOctet}.${fourthOctet}`;
}

/**
 * Read the VM_IPV6_PREFIX env var (lazy, cached).
 * When a pool is configured and prefix isn't explicitly set, defaults to "fd00::"
 * (ULA range) so VMs always get an internal IPv6 for the bridge network.
 */
let _ipv6Prefix: string | null | undefined;
export function getIPv6Prefix(): string | null {
  if (_ipv6Prefix === undefined) {
    const raw = process.env.VM_IPV6_PREFIX?.trim();
    if (raw) {
      _ipv6Prefix = raw;
    } else if (hasIPv6Pool()) {
      // Default ULA prefix when pool is configured but no prefix is set
      _ipv6Prefix = "fd00::";
    } else {
      _ipv6Prefix = null;
    }
  }
  return _ipv6Prefix;
}

/**
 * Derive a per-VM internal (ULA) IPv6 address from the configured prefix and CID.
 * Returns null if no IPv6 prefix is configured (and no pool).
 * Example: prefix "fd00::" + CID 3 → "fd00::3"
 */
export function cidToVmIpv6(cid: number): string | null {
  const prefix = getIPv6Prefix();
  if (!prefix) return null;
  return `${prefix}${cid}`;
}

/**
 * Allocate a public IPv6 address from the pool.
 * Returns null if no pool is configured or all addresses are in use.
 */
export function allocatePublicIPv6(): string | null {
  if (!hasIPv6Pool()) return null;
  const usedAddresses = getDatabase().getUsedIpv6();
  return allocateFromPool(usedAddresses);
}
