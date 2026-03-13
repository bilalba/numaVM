/**
 * Pre-snapshot cleanup — called by ALL snapshot paths before engine.snapshotVM().
 *
 * Two layers:
 * 1. In-VM: wall message + SIGHUP sshd to gracefully close direct IPv6 SSH sessions
 * 2. Proxy-side: disconnect SSH proxy clients, tear down agent bridges, kill terminals, notify WS hub
 */

import { getVMEngine } from "../adapters/providers.js";
import { disconnectSSHForVM } from "./ssh-proxy.js";
import { agentManager } from "../agents/manager.js";
import { destroyTerminalsForVM } from "../terminal/pty-handler.js";
import { wsHub } from "../agents/ws-hub.js";

export async function prepareVMForSnapshot(vmId: string): Promise<void> {
  const engine = getVMEngine();

  // 1. In-VM: broadcast wall message (best-effort, 2s timeout)
  try {
    await engine.exec(vmId, ["wall", "VM going to sleep..."], { timeoutMs: 2000 });
  } catch { /* best-effort */ }

  // 2. Brief pause so wall message is visible in terminals
  await new Promise(r => setTimeout(r, 500));

  // 3. In-VM: gracefully close all SSH sessions (best-effort, 2s timeout)
  //    SIGHUP causes sshd children to close cleanly — direct IPv6 clients
  //    see a proper SSH disconnect instead of TCP RST
  try {
    await engine.exec(vmId, ["pkill", "-HUP", "sshd"], { timeoutMs: 2000 });
  } catch { /* best-effort — may fail if no sshd children */ }

  // 4. Proxy-side: suppress wake-retry and disconnect proxy SSH clients
  disconnectSSHForVM(vmId);

  // 5. Proxy-side: tear down agent bridges (SSE, stdio)
  agentManager.destroyBridgesForVM(vmId);

  // 6. Proxy-side: kill terminal PTYs
  destroyTerminalsForVM(vmId);

  // 7. Proxy-side: notify + close dashboard WebSocket clients
  wsHub.closeConnectionsForVM(vmId);
}
