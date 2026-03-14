import type { FastifyInstance } from "fastify";
import { getDatabase, getVMEngine } from "../adapters/providers.js";
import { applyIpv6FirewallRules } from "../services/firecracker.js";
import { cidToVmIpv6 } from "../services/port-allocator.js";
import { bindWakeProxy } from "../services/wake-proxy.js";
import type { FirewallRule } from "../db/client.js";

function isValidIpv6Cidr(s: string): boolean {
  // Accept ::/0 and any IPv6 CIDR like 2001:db8::/32
  if (s === "::/0") return true;
  const parts = s.split("/");
  if (parts.length !== 2) return false;
  const prefix = parseInt(parts[1], 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 128) return false;
  // Basic IPv6 address validation — must contain at least one colon
  return parts[0].includes(":");
}

export function registerFirewallRoutes(app: FastifyInstance) {
  // Get firewall rules for a VM
  app.get("/vms/:id/firewall", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const rules = getDatabase().getVMFirewallRules(vm.id);
    return { rules, vm_ipv6: vm.vm_ipv6 || null };
  });

  // Set firewall rules for a VM
  app.post("/vms/:id/firewall", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { rules?: FirewallRule[] };

    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (role !== "owner") {
      return reply.status(403).send({ error: "Only the owner can manage firewall rules" });
    }

    if (!Array.isArray(body.rules)) {
      return reply.status(400).send({ error: "rules must be an array" });
    }

    // Validate each rule
    for (const rule of body.rules) {
      if (rule.proto !== "tcp" && rule.proto !== "udp") {
        return reply.status(400).send({ error: `Invalid protocol: ${rule.proto}. Must be tcp or udp` });
      }
      if (typeof rule.port !== "number" || rule.port < 1 || rule.port > 65535 || !Number.isInteger(rule.port)) {
        return reply.status(400).send({ error: `Invalid port: ${rule.port}. Must be 1-65535` });
      }
      const source = rule.source || "::/0";
      if (!isValidIpv6Cidr(source)) {
        return reply.status(400).send({ error: `Invalid source CIDR: ${source}` });
      }
      // Normalize source
      rule.source = source;
    }

    // Save to DB
    getDatabase().updateVMFirewallRules(vm.id, body.rules);

    // Apply live if VM is running and has an IPv6 address
    if (vm.host_id) {
      // Multi-node: proxy to the node agent
      try {
        // @ts-ignore -- commercial layer import, only used in multi-node mode
        const { getNodeForVM } = await import("../../../commercial/node-registry.js");
        // @ts-ignore -- commercial layer import, only used in multi-node mode
        const { nodeRequest } = await import("../../../commercial/node-request.js");
        const node = getNodeForVM(vm.id);
        if (node) {
          await nodeRequest(node, "POST", `/vms/${vm.id}/firewall`, { rules: body.rules });
        }
      } catch (err: any) {
        console.error(`[firewall] Failed to proxy firewall rules to node for ${vm.id}:`, err);
        // Rules are saved to CP DB — they'll be synced on next create/restore
      }
    } else {
      // Single-node (OSS): apply locally
      const firewallTarget = (vm.vsock_cid ? cidToVmIpv6(vm.vsock_cid) : null) || vm.vm_ipv6;
      if (firewallTarget && getVMEngine().isVmRunning(vm.id)) {
        try {
          applyIpv6FirewallRules(vm.id, firewallTarget, body.rules);
        } catch (err: any) {
          console.error(`[firewall] Failed to apply ip6tables rules for ${vm.id}:`, err);
          // Rules are saved to DB — they'll be applied on next start/restore
        }
      }
    }

    // Rebind wake proxy with updated ports (no-op when VM is running — DNAT masks it)
    if (vm.vm_ipv6) {
      bindWakeProxy(vm.id, vm.vm_ipv6, body.rules);
    }

    getDatabase().emitAdminEvent("vm.firewall_updated", vm.id, request.userId, {
      rule_count: body.rules.length,
    });

    return { ok: true, rules: body.rules };
  });
}
