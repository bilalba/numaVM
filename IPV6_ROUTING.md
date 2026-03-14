# IPv6 Routing & Wake-on-Connect

## Overview

Each VM gets a public IPv6 address from the host's /64 pool. Traffic is routed via ip6tables DNAT/SNAT between the public IPv6 and the VM's internal ULA address. The public IPv6 is added as a /128 on the external interface so the host responds to NDP neighbor solicitations from the upstream router.

## Key Functions

- **`addIpv6Nat(publicIpv6, ulaIpv6)`** — Adds the public IPv6 to the external interface, then creates PREROUTING DNAT and POSTROUTING SNAT rules mapping public ↔ ULA.
- **`removeIpv6Nat(publicIpv6, ulaIpv6, keepAddress?)`** — Removes all DNAT/SNAT rules. When `keepAddress=false` (default, used on VM delete), also removes the /128 from the interface. When `keepAddress=true` (used on snapshot), the address stays so the wake proxy can still bind to it.
- **`getDefaultInterface()`** — Auto-detects the external interface (e.g. `enp1s0`, `eth0`) from the default IPv6/IPv4 route.

## Wake-on-Connect Behavior

When a VM is snapshotted, it's suspended but remains wake-able. The wake proxy binds TCP servers on the VM's public IPv6 address for each firewall-allowed port. When a connection arrives, the proxy:

1. Accepts the connection and buffers initial data
2. Triggers VM resume (restore from snapshot)
3. Waits for the VM to become reachable
4. Forwards the buffered data and proxies bidirectionally

### IPv6 Address Lifecycle During Snapshot/Wake

The critical issue: snapshotting removes DNAT rules (so inbound traffic isn't forwarded to the now-suspended VM), but the wake proxy needs the IPv6 address to remain on the host interface to accept connections.

**Snapshot path**: `removeIpv6Nat(pub, ula, keepAddress=true)` — removes NAT rules but keeps the /128 address on the interface. The wake proxy then binds to this address.

**Wake/restore path**: `addIpv6Nat(pub, ula)` — re-adds NAT rules (and the address, idempotently). Wake proxy unbinds, traffic flows through DNAT to the running VM.

**Delete path**: `removeIpv6Nat(pub, ula, keepAddress=false)` — removes everything including the address.

### Agent Restart Recovery

On agent restart, `initWakeProxies()` iterates all snapshotted VMs and calls `bindWakeProxy()` for each. Three issues were fixed:

1. **Missing address** — `removeIpv6Nat()` during snapshot stripped the address. `bindWakeProxy()` now calls `ensureIpv6OnInterface()` to re-add it before binding.

2. **Missing local route** — Even if the address exists on the interface, the kernel's `local` routing table entry (which tells it "deliver packets for this address to me") can go missing after a del/re-add cycle. `ensureIpv6OnInterface()` runs `ip -6 route replace local <addr> dev <iface> table local` to guarantee the route exists.

3. **Address stripped on every snapshot** — Before the `keepAddress` parameter, every snapshot cycle would strip the address, breaking the wake proxy until the next agent restart. Now the snapshot path preserves the address.

## Files

- `oss/control-plane/services/firecracker.ts` — `addIpv6Nat()`, `removeIpv6Nat(keepAddress)`, `getDefaultInterface()`
- `oss/control-plane/services/wake-proxy.ts` — `ensureIpv6OnInterface()`, `bindWakeProxy()`
