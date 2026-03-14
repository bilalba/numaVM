/**
 * Wake-on-Connect TCP Proxy
 *
 * Two modes:
 *
 * 1. IPv6 proxy: When a VM is snapshotted, its IPv6 DNAT rules are removed.
 *    A local TCP server bound to the VM's public IPv6+port intercepts connections
 *    that would otherwise be dropped.
 *
 * 2. App proxy: When a VM is snapshotted, its IPv4 DNAT rules (OUTPUT chain for
 *    localhost) are removed. A local TCP server on the VM's appPort/opencodePort
 *    intercepts connections from Caddy, wakes the VM, and bridges through —
 *    so HTTPS subdomain requests get the actual page instead of a placeholder.
 *
 * When the VM is running, DNAT in PREROUTING/OUTPUT intercepts packets before
 * they reach these local sockets, so the proxies are effectively no-ops.
 */

import net from "node:net";
import { execSync } from "node:child_process";
import { ensureVMRunning } from "./wake.js";
import { getDatabase } from "../adapters/providers.js";
import type { FirewallRule } from "../db/client.js";

// vmId → list of TCP servers (IPv6 proxy)
const proxyServers = new Map<string, net.Server[]>();

// vmId → list of TCP servers (app port proxy)
const appProxyServers = new Map<string, net.Server[]>();


/**
 * Collect the unique TCP ports to proxy for a VM: all TCP firewall rules + always port 22.
 */
function collectPorts(rules: FirewallRule[]): number[] {
  const ports = new Set<number>([22]);
  for (const rule of rules) {
    if (rule.proto === "tcp") {
      ports.add(rule.port);
    }
  }
  return Array.from(ports);
}

/**
 * Wake the VM, look up its internal IP, bridge client socket to vmIp:targetPort.
 */
function bridgeAfterWake(vmId: string, targetPort: number, client: net.Socket, label: string): void {
  console.log(`[wake-proxy] ${label} — waking ${vmId}`);

  client.pause();

  ensureVMRunning(vmId)
    .then(() => {
      const vm = getDatabase().findVMById(vmId);
      if (!vm || !vm.vm_ip) {
        console.error(`[wake-proxy] ${vmId} woke but has no vm_ip — dropping connection`);
        client.destroy();
        return;
      }

      const upstream = net.createConnection({ host: vm.vm_ip, port: targetPort }, () => {
        client.resume();
        client.pipe(upstream);
        upstream.pipe(client);
      });

      upstream.on("error", (err) => {
        console.warn(`[wake-proxy] ${vmId} upstream error on port ${targetPort}: ${err.message}`);
        client.destroy();
      });

      client.on("error", () => {
        upstream.destroy();
      });

      client.on("close", () => {
        upstream.destroy();
      });

      upstream.on("close", () => {
        client.destroy();
      });
    })
    .catch((err) => {
      console.error(`[wake-proxy] Failed to wake ${vmId}: ${err.message}`);
      client.destroy();
    });
}

/**
 * Create a TCP server with standard error handling. Returns the server
 * (already listening) or null if bind failed.
 */
function createProxyServer(
  vmId: string,
  host: string,
  port: number,
  onConnection: (client: net.Socket) => void,
): net.Server | null {
  const server = net.createServer(onConnection);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") {
      console.warn(`[wake-proxy] ${vmId} failed to bind ${host}:${port}: ${err.message}`);
    }
  });

  try {
    server.listen(port, host);
    return server;
  } catch (err: any) {
    console.warn(`[wake-proxy] ${vmId} listen error ${host}:${port}: ${err.message}`);
    return null;
  }
}

// --- IPv6 proxy ---

/**
 * Ensure the IPv6 address is assigned to the appropriate host interface so we
 * can bind a TCP server to it. When a VM is snapshotted, removeIpv6Nat() strips
 * the address — we must re-add it (without DNAT) so the wake proxy can listen.
 */
function ensureIpv6OnInterface(ipv6: string): void {
  try {
    // ULA (fd00::) lives on the bridge; global unicast on the external interface
    const isUla = ipv6.startsWith("fd") || ipv6.startsWith("fc");
    const iface = isUla
      ? "br0"
      : (execSync("ip -6 route show default | awk '{print $5}' | head -1", { stdio: "pipe" }).toString().trim() || "eth0");
    try { execSync(`ip -6 addr add ${ipv6}/128 dev ${iface}`, { stdio: "pipe" }); } catch { /* already exists */ }
    // Ensure the local route exists — ip addr add normally creates it, but if
    // the address survived a del/re-add cycle the route can go missing.
    try { execSync(`ip -6 route replace local ${ipv6} dev ${iface} table local`, { stdio: "pipe" }); } catch { /* ok */ }
  } catch (err: any) {
    console.warn(`[wake-proxy] Failed to add ${ipv6} to interface: ${err.message}`);
  }
}

/**
 * Bind wake-proxy listeners for a VM on its public IPv6 address.
 * Safe to call multiple times — unbinds existing listeners first.
 */
export function bindWakeProxy(vmId: string, publicIpv6: string, rules: FirewallRule[]): void {
  unbindWakeProxy(vmId);

  // Ensure the address is on the interface (may have been removed during snapshot)
  ensureIpv6OnInterface(publicIpv6);

  const ports = collectPorts(rules);
  const servers: net.Server[] = [];

  for (const port of ports) {
    const server = createProxyServer(vmId, publicIpv6, port, (client) => {
      bridgeAfterWake(vmId, port, client, `IPv6 [${publicIpv6}]:${port}`);
    });
    if (server) servers.push(server);
  }

  if (servers.length > 0) {
    proxyServers.set(vmId, servers);
  }
}

/**
 * Close all IPv6 wake-proxy listeners for a VM.
 */
export function unbindWakeProxy(vmId: string): void {
  const servers = proxyServers.get(vmId);
  if (!servers) return;
  for (const server of servers) {
    try { server.close(); } catch { /* already closed */ }
  }
  proxyServers.delete(vmId);
}

// --- App port proxy (Caddy HTTPS subdomain wake-on-connect) ---

/**
 * Bind wake-proxy listeners on a VM's appPort and opencodePort.
 * When snapshotted, IPv4 DNAT (OUTPUT chain) is removed, so Caddy's connection
 * to localhost:appPort lands here instead of being forwarded to the VM.
 */
export function bindAppWakeProxy(vmId: string, appPort: number, opencodePort: number): void {
  unbindAppWakeProxy(vmId);

  const servers: net.Server[] = [];
  const mappings: [number, number][] = [
    [appPort, 3000],       // Caddy → localhost:appPort → vmIp:3000
    [opencodePort, 5000],  // OpenCode → localhost:opencodePort → vmIp:5000
  ];

  for (const [hostPort, vmPort] of mappings) {
    const server = createProxyServer(vmId, "0.0.0.0", hostPort, (client) => {
      bridgeAfterWake(vmId, vmPort, client, `App port ${hostPort}→${vmPort}`);
    });
    if (server) servers.push(server);
  }

  if (servers.length > 0) {
    appProxyServers.set(vmId, servers);
  }
}

/**
 * Close all app port wake-proxy listeners for a VM.
 */
export function unbindAppWakeProxy(vmId: string): void {
  const servers = appProxyServers.get(vmId);
  if (!servers) return;
  for (const server of servers) {
    try { server.close(); } catch { /* already closed */ }
  }
  appProxyServers.delete(vmId);
}

// --- Initialization ---

/**
 * Initialize wake proxies for all VMs.
 * Called at control plane startup after reconcileRunningVMs().
 */
export function initWakeProxies(): void {
  const db = getDatabase();
  const allVMs = db.findAllVMs();

  let ipv6Count = 0;
  let appCount = 0;

  for (const vm of allVMs) {
    // IPv6 proxy
    if (vm.vm_ipv6) {
      const rules = db.getVMFirewallRules(vm.id);
      bindWakeProxy(vm.id, vm.vm_ipv6, rules);
      ipv6Count++;
    }

    // App port proxy (all VMs with allocated ports)
    bindAppWakeProxy(vm.id, vm.app_port, vm.opencode_port);
    appCount++;
  }

  if (ipv6Count > 0 || appCount > 0) {
    console.log(`[wake-proxy] Initialized proxies: ${ipv6Count} IPv6, ${appCount} app`);
  }
}
