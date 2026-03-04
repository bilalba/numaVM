import { getUsedPorts, getUsedCids } from "../db/client.js";

const APP_PORT_BASE = 10001;
const SSH_PORT_BASE = 20001;
const OPENCODE_PORT_BASE = 30001;
const PORT_RANGE = 999;

// Vsock CIDs: 0-2 are reserved, start from 3
const VSOCK_CID_START = 3;
const VSOCK_CID_MAX = 65535;

// VM IP allocation: 172.16.0.0/16 subnet, .1 is gateway
const VM_IP_BASE_OCTET = 2; // Start from 172.16.0.2

function nextAvailable(used: Set<number>, base: number): number {
  const max = base + PORT_RANGE;
  for (let port = base; port <= max; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`No available ports in range ${base}-${max}`);
}

export function allocatePorts(): { appPort: number; sshPort: number; opencodePort: number } {
  const rows = getUsedPorts();

  const usedApp = new Set(rows.map((r) => r.app_port));
  const usedSsh = new Set(rows.map((r) => r.ssh_port));
  const usedOpencode = new Set(rows.map((r) => r.opencode_port));

  return {
    appPort: nextAvailable(usedApp, APP_PORT_BASE),
    sshPort: nextAvailable(usedSsh, SSH_PORT_BASE),
    opencodePort: nextAvailable(usedOpencode, OPENCODE_PORT_BASE),
  };
}

/**
 * Allocate a vsock CID for a new VM.
 */
export function allocateCid(): number {
  const usedCids = new Set(getUsedCids());
  for (let cid = VSOCK_CID_START; cid <= VSOCK_CID_MAX; cid++) {
    if (!usedCids.has(cid)) return cid;
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
