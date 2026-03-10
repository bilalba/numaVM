/**
 * Wake-on-Connect TCP Proxy
 *
 * When a VM is snapshotted, its IPv6 DNAT rules are removed. A local TCP server
 * bound to the VM's public IPv6+port intercepts connections that would otherwise
 * be dropped. On connect: wakes the VM, then bridges the client socket to the
 * VM's internal IP.
 *
 * When the VM is running, DNAT in PREROUTING intercepts packets before they
 * reach these local sockets, so the proxy is effectively a no-op.
 */

import net from "node:net";
import { ensureVMRunning } from "./wake.js";
import { getDatabase } from "../adapters/providers.js";
import type { FirewallRule } from "../db/client.js";

// vmId → list of TCP servers
const proxyServers = new Map<string, net.Server[]>();

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
 * Bind wake-proxy listeners for a VM on its public IPv6 address.
 * Safe to call multiple times — unbinds existing listeners first.
 */
export function bindWakeProxy(vmId: string, publicIpv6: string, rules: FirewallRule[]): void {
  // Tear down any existing listeners for this VM
  unbindWakeProxy(vmId);

  const ports = collectPorts(rules);
  const servers: net.Server[] = [];

  for (const port of ports) {
    const server = net.createServer((client) => {
      handleConnection(vmId, publicIpv6, port, client);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      // EADDRINUSE is expected when VM is running (DNAT active, or another process holds the port)
      if (err.code !== "EADDRINUSE") {
        console.warn(`[wake-proxy] ${vmId} failed to bind [${publicIpv6}]:${port}: ${err.message}`);
      }
    });

    try {
      server.listen(port, publicIpv6);
      servers.push(server);
    } catch (err: any) {
      console.warn(`[wake-proxy] ${vmId} listen error [${publicIpv6}]:${port}: ${err.message}`);
    }
  }

  if (servers.length > 0) {
    proxyServers.set(vmId, servers);
  }
}

/**
 * Close all wake-proxy listeners for a VM.
 */
export function unbindWakeProxy(vmId: string): void {
  const servers = proxyServers.get(vmId);
  if (!servers) return;
  for (const server of servers) {
    try {
      server.close();
    } catch { /* already closed */ }
  }
  proxyServers.delete(vmId);
}

/**
 * Handle an incoming connection: wake the VM, look up its internal IP, bridge the socket.
 */
function handleConnection(vmId: string, publicIpv6: string, port: number, client: net.Socket): void {
  console.log(`[wake-proxy] Connection to [${publicIpv6}]:${port} — waking ${vmId}`);

  // Pause incoming data until we've connected upstream
  client.pause();

  ensureVMRunning(vmId)
    .then(() => {
      const vm = getDatabase().findVMById(vmId);
      if (!vm || !vm.vm_ip) {
        console.error(`[wake-proxy] ${vmId} woke but has no vm_ip — dropping connection`);
        client.destroy();
        return;
      }

      const upstream = net.createConnection({ host: vm.vm_ip, port }, () => {
        // Bridge the two sockets
        client.resume();
        client.pipe(upstream);
        upstream.pipe(client);
      });

      upstream.on("error", (err) => {
        console.warn(`[wake-proxy] ${vmId} upstream error on port ${port}: ${err.message}`);
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
 * Initialize wake proxies for all VMs that have a public IPv6.
 * Called at control plane startup after reconcileRunningVMs().
 */
export function initWakeProxies(): void {
  const db = getDatabase();
  const allVMs = db.findAllVMs();

  let count = 0;
  for (const vm of allVMs) {
    if (!vm.vm_ipv6) continue;
    const rules = db.getVMFirewallRules(vm.id);
    bindWakeProxy(vm.id, vm.vm_ipv6, rules);
    count++;
  }

  if (count > 0) {
    console.log(`[wake-proxy] Initialized proxies for ${count} VMs`);
  }
}
