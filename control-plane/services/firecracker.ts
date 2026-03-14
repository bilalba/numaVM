import { spawn, exec, execSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, unlinkSync, readdirSync } from "node:fs";
import { createConnection as netCreateConnection } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// --- Config (lazy reads for ESM import hoisting) ---

function getFcBin() { return process.env.FC_BIN || "/opt/firecracker/bin/firecracker"; }
function getKernelPath() { return process.env.FC_KERNEL || "/opt/firecracker/kernel/vmlinux"; }
function getRootfsDir() { return process.env.FC_ROOTFS_DIR || "/opt/firecracker/rootfs"; }

function resolveRootfsPath(image?: string): string {
  // Backward compat: explicit FC_ROOTFS env var overrides everything
  if (process.env.FC_ROOTFS) return process.env.FC_ROOTFS;
  const distro = image || "alpine";
  const rootfsDir = getRootfsDir();
  // Try versioned symlink first (e.g. alpine.ext4 -> alpine-v1.ext4)
  const symlinkPath = join(rootfsDir, `${distro}.ext4`);
  if (existsSync(symlinkPath)) return symlinkPath;
  // Fallback to base.ext4 for backward compat (only for alpine)
  if (distro === "alpine") {
    const basePath = join(rootfsDir, "base.ext4");
    if (existsSync(basePath)) return basePath;
  }
  throw new Error(`Rootfs not found for image '${distro}' at ${symlinkPath}`);
}

export function getAvailableImages(): { distro: string; version: number; distro_version: string; node_version: string }[] {
  const rootfsDir = getRootfsDir();
  const manifestPath = join(rootfsDir, "manifest.json");

  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const images = manifest.images as { distro: string; version: number; distro_version: string; node_version: string }[];
      // Return only the latest version per distro
      const latest = new Map<string, typeof images[0]>();
      for (const img of images) {
        const existing = latest.get(img.distro);
        if (!existing || img.version > existing.version) {
          latest.set(img.distro, img);
        }
      }
      return Array.from(latest.values());
    } catch {
      // Fall through to detection
    }
  }

  // Fallback: detect .ext4 files in rootfs dir
  const detected: { distro: string; version: number; distro_version: string; node_version: string }[] = [];
  try {
    for (const f of readdirSync(rootfsDir) as string[]) {
      // Match distro.ext4 symlinks (not versioned files)
      const match = f.match(/^([a-z]+)\.ext4$/);
      if (match && match[1] !== "base") {
        detected.push({ distro: match[1], version: 1, distro_version: "", node_version: "" });
      }
    }
  } catch {
    // rootfs dir may not exist in dev
  }

  // Always include alpine as a fallback
  if (detected.length === 0) {
    detected.push({ distro: "alpine", version: 1, distro_version: "", node_version: "" });
  }

  return detected;
}
export function getDataDir() { return process.env.DATA_DIR || "/data/vms"; }
function getSocketDir() { return process.env.FC_SOCKET_DIR || "/tmp"; }
function getVmGateway() { return process.env.VM_GATEWAY || "172.16.0.1"; }
function getDefaultVcpu() { return parseInt(process.env.VM_VCPU_COUNT || "2", 10); }
function getDefaultMem() { return parseInt(process.env.VM_MEM_SIZE_MIB || "512", 10); }

// --- Types ---

export interface CreateVMParams {
  slug: string;
  name?: string;
  appPort: number;
  sshPort: number;
  opencodePort: number;
  ghRepo?: string;
  ghToken?: string;
  githubUsername?: string;
  sshKeys: string;
  opencodePassword: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  vsockCid: number;
  vmIp: string;
  vmIpv6?: string | null;
  vmIpv6Internal?: string | null;
  vcpuCount?: number;
  memSizeMib?: number;
  diskSizeGib?: number;
  image?: string;
  extraKernelArgs?: string[];
  firewallRules?: FirewallRule[];
  onProgress?: (detail: string) => void;
}

export interface VMStatus {
  running: boolean;
  status: "running" | "paused" | "stopped" | "snapshotted";
  startedAt: string | null;
  vsockCid: number;
}

// Track running Firecracker processes in memory
const runningVMs = new Map<string, {
  process: ChildProcess | null;  // null for reconciled (re-adopted) VMs
  pid: number;
  socketPath: string;
  vsockCid: number;
  vmIp: string;
  tapDev: string;
  startedAt: string;
}>();

// --- Internal SSH key for vsock exec ---

let internalSshKeyPath: string | null = null;
let internalSshPubKey: string | null = null;

/**
 * Get or generate the internal SSH keypair used for vsock exec.
 * This key is injected into every VM alongside user keys.
 */
export function getInternalSshPubKey(): string {
  if (internalSshPubKey) return internalSshPubKey;

  const keyDir = join(getDataDir(), ".ssh");
  const keyPath = join(keyDir, "numavm_internal");
  const pubPath = keyPath + ".pub";

  if (!existsSync(pubPath)) {
    mkdirSync(keyDir, { recursive: true });
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -C "numavm-internal"`, { stdio: "pipe" });
  }

  internalSshKeyPath = keyPath;
  internalSshPubKey = readFileSync(pubPath, "utf-8").trim();
  return internalSshPubKey;
}

export function getInternalSshKeyPath(): string {
  if (!internalSshKeyPath) getInternalSshPubKey(); // ensures key is generated
  return internalSshKeyPath!;
}

// --- Firecracker REST API helpers ---

async function fcApi(socketPath: string, method: string, path: string, body?: any): Promise<any> {
  // Firecracker uses a Unix socket HTTP API
  // We use curl since Node's fetch doesn't support Unix sockets natively
  // Append HTTP status code on a separate line via -w so we can detect 4xx/5xx errors
  const args = [
    "--unix-socket", socketPath,
    "-s", "-S",
    "-m", "30",
    "-X", method,
    "-H", "Content-Type: application/json",
    "-w", "\n%{http_code}",
  ];

  if (body) {
    args.push("-d", JSON.stringify(body));
  }

  args.push(`http://localhost${path}`);

  return new Promise((resolve, reject) => {
    const proc = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Firecracker API ${method} ${path} failed (curl ${code}): ${stderr}`));
        return;
      }

      // Parse HTTP status code from the last line (added by -w)
      const lines = stdout.trimEnd().split("\n");
      const httpStatus = parseInt(lines.pop() || "0", 10);
      const responseBody = lines.join("\n");

      if (httpStatus >= 400) {
        // Extract error message from Firecracker JSON error response
        let errMsg = responseBody;
        try {
          const parsed = JSON.parse(responseBody);
          errMsg = parsed.fault_message || parsed.message || responseBody;
        } catch { /* use raw body */ }
        reject(new Error(`Firecracker API ${method} ${path} returned ${httpStatus}: ${errMsg}`));
        return;
      }

      try {
        resolve(responseBody ? JSON.parse(responseBody) : null);
      } catch {
        resolve(responseBody);
      }
    });
  });
}

// --- Networking helpers ---

function createTap(tapName: string, vmIp: string): void {
  const tapCreate = process.env.TAP_CREATE || "/opt/firecracker/bin/create-tap";
  if (existsSync(tapCreate)) {
    execSync(`"${tapCreate}" "${tapName}" "${vmIp}"`, { stdio: "pipe" });
  } else {
    // Inline TAP creation
    try { execSync(`ip link delete "${tapName}" 2>/dev/null`, { stdio: "pipe" }); } catch { /* ok */ }
    execSync(`ip tuntap add dev "${tapName}" mode tap`, { stdio: "pipe" });
    execSync(`ip link set "${tapName}" master ${process.env.BRIDGE_IF || "br0"}`, { stdio: "pipe" });
    execSync(`ip link set "${tapName}" up`, { stdio: "pipe" });
  }

  // Flush stale ARP for this VM IP. When a previous VM used the same IP,
  // the host ARP cache retains the old MAC, causing ~4s of unreachability.
  try { execSync(`ip neigh flush dev ${process.env.BRIDGE_IF || "br0"} to ${vmIp} 2>/dev/null`, { stdio: "pipe" }); } catch { /* ok */ }
}

function destroyTap(tapName: string): void {
  const tapDestroy = process.env.TAP_DESTROY || "/opt/firecracker/bin/destroy-tap";
  if (existsSync(tapDestroy)) {
    try { execSync(`"${tapDestroy}" "${tapName}"`, { stdio: "pipe" }); } catch { /* ok */ }
  } else {
    try { execSync(`ip link delete "${tapName}" 2>/dev/null`, { stdio: "pipe" }); } catch { /* ok */ }
  }
}

function addDnat(hostPort: number, vmIp: string, vmPort: number): void {
  // Remove any existing rule first to prevent duplicates (iptables -A appends
  // unconditionally, and iptables -D only removes one instance at a time).
  removeDnat(hostPort, vmIp, vmPort);

  const dnatAdd = process.env.DNAT_ADD || "/opt/firecracker/bin/add-dnat";
  if (existsSync(dnatAdd)) {
    execSync(`"${dnatAdd}" "${hostPort}" "${vmIp}" "${vmPort}"`, { stdio: "pipe" });
  } else {
    execSync(`iptables -t nat -A PREROUTING -p tcp --dport ${hostPort} -j DNAT --to-destination ${vmIp}:${vmPort}`, { stdio: "pipe" });
    execSync(`iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport ${hostPort} -j DNAT --to-destination ${vmIp}:${vmPort}`, { stdio: "pipe" });
  }
}

export function removeDnat(hostPort: number, vmIp: string, vmPort: number): void {
  const dnatRemove = process.env.DNAT_REMOVE || "/opt/firecracker/bin/remove-dnat";
  if (existsSync(dnatRemove)) {
    try { execSync(`"${dnatRemove}" "${hostPort}" "${vmIp}" "${vmPort}"`, { stdio: "pipe" }); } catch { /* ok */ }
  } else {
    try { execSync(`iptables -t nat -D PREROUTING -p tcp --dport ${hostPort} -j DNAT --to-destination ${vmIp}:${vmPort}`, { stdio: "pipe" }); } catch { /* ok */ }
    try { execSync(`iptables -t nat -D OUTPUT -p tcp -d 127.0.0.1 --dport ${hostPort} -j DNAT --to-destination ${vmIp}:${vmPort}`, { stdio: "pipe" }); } catch { /* ok */ }
  }
}

// --- IPv6 Firewall (per-VM ip6tables chains) ---

export interface FirewallRule {
  proto: "tcp" | "udp";
  port: number;
  source: string;
  description?: string;
}

export function applyIpv6FirewallRules(slug: string, vmIpv6: string | null | undefined, rules: FirewallRule[]): void {
  if (!vmIpv6) return;

  const chain = `numavm-${slug}`;

  // Create chain (ignore if exists) then flush it
  try { execSync(`ip6tables -N ${chain} 2>/dev/null`, { stdio: "pipe" }); } catch { /* exists */ }
  execSync(`ip6tables -F ${chain}`, { stdio: "pipe" });

  // Ensure FORWARD jump exists for this VM's IPv6 address
  try {
    execSync(`ip6tables -C FORWARD -d ${vmIpv6} -j ${chain} 2>/dev/null`, { stdio: "pipe" });
  } catch {
    execSync(`ip6tables -I FORWARD -d ${vmIpv6} -j ${chain}`, { stdio: "pipe" });
  }

  // Always allow ICMPv6 (NDP, path MTU discovery)
  execSync(`ip6tables -A ${chain} -p icmpv6 -j ACCEPT`, { stdio: "pipe" });

  // Allow established/related connections
  execSync(`ip6tables -A ${chain} -m state --state RELATED,ESTABLISHED -j ACCEPT`, { stdio: "pipe" });

  // Per-rule ACCEPT entries
  for (const rule of rules) {
    const src = rule.source || "::/0";
    execSync(`ip6tables -A ${chain} -p ${rule.proto} --dport ${rule.port} -s ${src} -j ACCEPT`, { stdio: "pipe" });
  }

  // Default deny
  execSync(`ip6tables -A ${chain} -j DROP`, { stdio: "pipe" });
}

export function removeIpv6FirewallRules(slug: string, vmIpv6: string | null | undefined): void {
  if (!vmIpv6) return;

  const chain = `numavm-${slug}`;

  // Remove FORWARD jump
  try { execSync(`ip6tables -D FORWARD -d ${vmIpv6} -j ${chain} 2>/dev/null`, { stdio: "pipe" }); } catch { /* ok */ }

  // Flush and delete chain
  try { execSync(`ip6tables -F ${chain} 2>/dev/null`, { stdio: "pipe" }); } catch { /* ok */ }
  try { execSync(`ip6tables -X ${chain} 2>/dev/null`, { stdio: "pipe" }); } catch { /* ok */ }
}

// --- IPv6 NAT (DNAT/SNAT for pool-based allocation) ---

/** Detect the default network interface (e.g. enp1s0, eth0). */
function getDefaultInterface(): string {
  try {
    return execSync("ip -6 route show default | awk '{print $5}' | head -1", { stdio: "pipe" }).toString().trim()
      || execSync("ip route show default | awk '{print $5}' | head -1", { stdio: "pipe" }).toString().trim()
      || "eth0";
  } catch { return "eth0"; }
}

/**
 * Add DNAT + SNAT rules to map a public IPv6 address to an internal ULA address.
 * Also adds the public IPv6 as a /128 on the external interface so the host
 * responds to NDP neighbor solicitations from the upstream router.
 */
export function addIpv6Nat(publicIpv6: string, ulaIpv6: string): void {
  // Add public IPv6 to external interface for NDP reachability
  const extIf = getDefaultInterface();
  try { execSync(`ip -6 addr add ${publicIpv6}/128 dev ${extIf} 2>/dev/null`, { stdio: "pipe" }); } catch { /* already exists */ }

  try {
    execSync(`ip6tables -t nat -C PREROUTING -d ${publicIpv6} -j DNAT --to-destination ${ulaIpv6} 2>/dev/null`, { stdio: "pipe" });
  } catch {
    try { execSync(`ip6tables -t nat -A PREROUTING -d ${publicIpv6} -j DNAT --to-destination ${ulaIpv6}`, { stdio: "pipe" }); } catch { /* ok */ }
  }
  try {
    execSync(`ip6tables -t nat -C POSTROUTING -s ${ulaIpv6} -j SNAT --to-source ${publicIpv6} 2>/dev/null`, { stdio: "pipe" });
  } catch {
    try { execSync(`ip6tables -t nat -A POSTROUTING -s ${ulaIpv6} -j SNAT --to-source ${publicIpv6}`, { stdio: "pipe" }); } catch { /* ok */ }
  }
}

/**
 * Remove ALL DNAT + SNAT rules for a public↔ULA mapping.
 * When keepAddress is false (default), also removes the public IPv6 from the
 * external interface. Pass keepAddress=true during snapshot so the wake proxy
 * can still receive connections on the address while the VM is asleep.
 * Loops to handle duplicates that accumulated from prior restores.
 */
export function removeIpv6Nat(publicIpv6: string, ulaIpv6: string, keepAddress = false): void {
  for (let i = 0; i < 20; i++) {
    try { execSync(`ip6tables -t nat -D PREROUTING -d ${publicIpv6} -j DNAT --to-destination ${ulaIpv6}`, { stdio: "pipe" }); } catch { break; }
  }
  for (let i = 0; i < 20; i++) {
    try { execSync(`ip6tables -t nat -D POSTROUTING -s ${ulaIpv6} -j SNAT --to-source ${publicIpv6}`, { stdio: "pipe" }); } catch { break; }
  }

  if (!keepAddress) {
    const extIf = getDefaultInterface();
    try { execSync(`ip -6 addr del ${publicIpv6}/128 dev ${extIf} 2>/dev/null`, { stdio: "pipe" }); } catch { /* ok */ }
  }
}

// --- Lifecycle ---

export async function createAndStartVM(params: CreateVMParams): Promise<string> {
  const {
    slug, name, appPort, sshPort, opencodePort,
    ghRepo, ghToken, githubUsername, sshKeys, opencodePassword,
    openaiApiKey, anthropicApiKey,
    vsockCid, vmIp, vmIpv6, vmIpv6Internal,
    vcpuCount = getDefaultVcpu(),
    memSizeMib = getDefaultMem(),
    diskSizeGib = 5,
    image,
    extraKernelArgs,
    onProgress,
  } = params;

  const progress = onProgress || (() => {});

  const socketPath = join(getSocketDir(), `fc-${slug}.sock`);
  const tapDev = `tap-${slug}`;
  const dataDir = join(getDataDir(), slug);
  const overlayDir = join(dataDir, "overlay");
  const snapshotDir = join(dataDir, "snapshot");

  progress("Allocating resources");

  // Clean up any stale socket
  if (existsSync(socketPath)) unlinkSync(socketPath);

  // Create per-env directories
  mkdirSync(overlayDir, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });

  // Build kernel cmdline with dm.* params
  // Base64-encode SSH keys to avoid whitespace issues in cmdline
  const allKeys = [sshKeys, getInternalSshPubKey()].filter(Boolean).join("\n") + "\n";
  const sshKeysB64 = Buffer.from(allKeys).toString("base64");

  const envNameB64 = Buffer.from(name || slug).toString("base64");

  const kernelArgs = [
    "console=ttyS0",
    "reboot=k",
    "panic=1",
    "pci=off",
    "nomodules",
    "random.trust_cpu=on",
    "i8042.noaux",
    ...(!image || image === "alpine"
      ? ["init=/sbin/numavm-init"]
      : ["init=/lib/systemd/systemd"]),
    `dm.ip=${vmIp}`,
    `dm.gateway=${getVmGateway()}`,
    `dm.dns=8.8.8.8`,
    `dm.vsock_cid=${vsockCid}`,
    `dm.ssh_keys=${sshKeysB64}`,
    `dm.gh_repo=${ghRepo || ""}`,
    `dm.gh_token=${ghToken || ""}`,
    `dm.github_username=${githubUsername || ""}`,
    `dm.opencode_password=${opencodePassword}`,
    `dm.openai_api_key=${openaiApiKey || ""}`,
    `dm.anthropic_api_key=${anthropicApiKey || ""}`,
    `dm.env_name=${envNameB64}`,
    ...((vmIpv6Internal || vmIpv6) ? [`dm.ipv6=${vmIpv6Internal || vmIpv6}`, `dm.ipv6_prefix_len=64`] : []),
    ...(extraKernelArgs || []),
  ].join(" ");

  progress("Starting Firecracker");

  // --- Parallel pre-boot setup ---
  // rootfs_copy, tap_create, env_write, and systemd_run
  // are all independent. Run them concurrently to save ~80ms.

  const vmRootfs = join(dataDir, "rootfs.ext4");
  const fcLogPath = join(dataDir, "firecracker.log");

  const setupTasks: Promise<void>[] = [];

  // Rootfs copy (reflink) + expand to user-requested disk size
  // We add diskSizeGib to the base image size so the user gets that much *free* space.
  // truncate creates a sparse file — no real blocks allocated until the guest writes.
  // The guest runs resize2fs /dev/vda at boot to grow the filesystem to fill the block device.
  if (!existsSync(vmRootfs)) {
    const baseRootfs = resolveRootfsPath(image);
    setupTasks.push(
      (async () => {
        try {
          await execAsync(`cp --reflink=auto "${baseRootfs}" "${vmRootfs}"`);
        } catch {
          await execAsync(`cp "${baseRootfs}" "${vmRootfs}"`);
        }
        await execAsync(`truncate -s +${diskSizeGib}G "${vmRootfs}"`);
      })()
    );
  }

  // TAP device + ARP flush — async
  setupTasks.push(execAsync(
    `${existsSync(process.env.TAP_CREATE || "/opt/firecracker/bin/create-tap")
      ? `"${process.env.TAP_CREATE || "/opt/firecracker/bin/create-tap"}" "${tapDev}" "${vmIp}"`
      : `ip link delete "${tapDev}" 2>/dev/null; ip tuntap add dev "${tapDev}" mode tap && ip link set "${tapDev}" master ${process.env.BRIDGE_IF || "br0"} && ip link set "${tapDev}" up`
    } && ip neigh flush dev ${process.env.BRIDGE_IF || "br0"} to ${vmIp} 2>/dev/null; true`
  ).then(() => {}));

  // Env config file (sync — fast, just a write)
  const envConfig = {
    gh_repo: ghRepo || "",
    gh_token: ghToken || "",
    ssh_keys: sshKeys,
    internal_ssh_key: getInternalSshPubKey(),
    opencode_password: opencodePassword,
    openai_api_key: openaiApiKey || "",
    anthropic_api_key: anthropicApiKey || "",
  };
  writeFileSync(join(dataDir, "env.json"), JSON.stringify(envConfig));

  // Spawn Firecracker via systemd (survives CP restarts) — async
  setupTasks.push(
    execAsync(
      `systemd-run --unit fc-${slug} --description "Firecracker VM ${slug}" ` +
      `${getFcBin()} --api-sock ${socketPath} --log-path ${fcLogPath} --level Debug`
    ).then(() => {})
  );

  await Promise.all(setupTasks);

  // Get the PID from systemd
  let fcPid = 0;
  try {
    fcPid = parseInt(
      execSync(`systemctl show fc-${slug}.service -p MainPID --value`, { stdio: "pipe" }).toString().trim(),
      10,
    );
  } catch { /* ok */ }

  // Wait for socket to be ready
  await waitForSocket(socketPath, 5000);

  progress("Configuring VM");

  // Configure VM via REST API
  // 1. Machine config
  await fcApi(socketPath, "PUT", "/machine-config", {
    vcpu_count: vcpuCount,
    mem_size_mib: memSizeMib,
  });

  // 2. Kernel
  await fcApi(socketPath, "PUT", "/boot-source", {
    kernel_image_path: getKernelPath(),
    boot_args: kernelArgs,
  });

  // 3. Rootfs (expanded to user-requested size in parallel_setup)
  await fcApi(socketPath, "PUT", "/drives/rootfs", {
    drive_id: "rootfs",
    path_on_host: vmRootfs,
    is_root_device: true,
    is_read_only: false,
  });

  // 4. Network
  await fcApi(socketPath, "PUT", "/network-interfaces/eth0", {
    iface_id: "eth0",
    host_dev_name: tapDev,
  });

  // 6. Vsock
  const vsockUdsPath = join(getSocketDir(), `fc-${slug}-vsock.sock`);
  await fcApi(socketPath, "PUT", "/vsock", {
    guest_cid: vsockCid,
    uds_path: vsockUdsPath,
  });

  // 7. Start the VM
  progress("Booting kernel");
  await fcApi(socketPath, "PUT", "/actions", {
    action_type: "InstanceStart",
  });

  // Set up iptables DNAT for port forwarding (SSH handled by ssh-proxy)
  addDnat(appPort, vmIp, 3000);    // app port
  addDnat(opencodePort, vmIp, 5000); // OpenCode port

  // Set up IPv6 DNAT/SNAT if pool-based allocation (public differs from ULA)
  const ipv6Ula = vmIpv6Internal || vmIpv6;
  if (vmIpv6 && ipv6Ula && vmIpv6 !== ipv6Ula) {
    try {
      addIpv6Nat(vmIpv6, ipv6Ula);
    } catch (err) {
      console.error(`[firecracker] Failed to add IPv6 NAT for ${slug}:`, err);
    }
  }

  // Apply IPv6 firewall rules (default-deny) using ULA address (post-DNAT destination)
  if (ipv6Ula) {
    try {
      // Prefer passed-in rules (from CP via multi-node) over reading from local DB
      const rules = params.firewallRules ?? (await import("../db/client.js")).getVMFirewallRules(slug);
      applyIpv6FirewallRules(slug, ipv6Ula, rules);
    } catch (err) {
      console.error(`[firecracker] Failed to apply IPv6 firewall rules for ${slug}:`, err);
    }
  }

  const startedAt = new Date().toISOString();

  // Track the running VM (process is null — managed by systemd)
  runningVMs.set(slug, {
    process: null,
    pid: fcPid,
    socketPath,
    vsockCid,
    vmIp,
    tapDev,
    startedAt,
  });

  // Wait for TCP port 22 to accept connections.
  // Kernel boots in ~400ms, init.sh starts sshd at ~550ms from InstanceStart.
  // TCP poll with 50ms timeout + 25ms sleep = 75ms per cycle catches it quickly.
  // ARP is pre-flushed in createTap() so no stale cache delays.
  progress("Waiting for VM");
  await waitForTcpReady(vmIp, 22, 30000);

  return slug;
}

export async function stopVM(vmId: string): Promise<void> {
  const vm = runningVMs.get(vmId);
  if (!vm) return;

  try {
    // Send CtrlAltDel to gracefully shut down
    await fcApi(vm.socketPath, "PUT", "/actions", {
      action_type: "SendCtrlAltDel",
    });
    // Wait a moment for graceful shutdown
    await sleep(2000);
  } catch { /* ignore */ }

  // Force kill if still running
  killVmProcess(vm, vmId);

  runningVMs.delete(vmId);
}

export async function removeVM(vmId: string): Promise<void> {
  const vm = runningVMs.get(vmId);

  // Stop if running
  if (vm) {
    await stopVM(vmId);
  }

  // Look up VM info from DB if not in memory
  // The caller should pass the env record for cleanup
  // For now, clean up what we can
  const tapDev = `tap-${vmId}`;
  const socketPath = join(getSocketDir(), `fc-${vmId}.sock`);
  const vsockSocket = join(getSocketDir(), `fc-${vmId}-vsock.sock`);

  // Clean up TAP device
  destroyTap(tapDev);

  // Clean up sockets
  if (existsSync(socketPath)) unlinkSync(socketPath);
  if (existsSync(vsockSocket)) try { unlinkSync(vsockSocket); } catch { /* ok */ }
}

/**
 * Remove VM and clean up iptables DNAT rules.
 * Call this instead of removeVM when you have the port/IP info.
 */
export async function removeVMFull(
  vmId: string,
  vmIp: string,
  appPort: number,
  sshPort: number,
  opencodePort: number,
  vmIpv6?: string | null,
  vsockCid?: number,
): Promise<void> {
  await removeVM(vmId);

  // Clean up DNAT rules (SSH handled by ssh-proxy, no DNAT to remove)
  removeDnat(appPort, vmIp, 3000);
  removeDnat(opencodePort, vmIp, 5000);

  // Derive ULA for IPv6 NAT cleanup
  const { cidToVmIpv6 } = await import("./port-allocator.js");
  const ula = vsockCid ? cidToVmIpv6(vsockCid) : null;

  // Clean up IPv6 NAT rules (public↔ULA mapping)
  if (vmIpv6 && ula && vmIpv6 !== ula) {
    removeIpv6Nat(vmIpv6, ula);
  }

  // Clean up IPv6 firewall chain (uses ULA address, or public if no pool)
  removeIpv6FirewallRules(vmId, ula || vmIpv6);
}

export async function inspectVM(vmId: string): Promise<VMStatus> {
  const vm = runningVMs.get(vmId);

  if (vm) {
    return {
      running: true,
      status: "running",
      startedAt: vm.startedAt,
      vsockCid: vm.vsockCid,
    };
  }

  // Check if there's a snapshot
  const snapshotPath = join(getDataDir(), vmId, "snapshot", "vmstate");
  if (existsSync(snapshotPath)) {
    return {
      running: false,
      status: "snapshotted",
      startedAt: null,
      vsockCid: 0,
    };
  }

  return {
    running: false,
    status: "stopped",
    startedAt: null,
    vsockCid: 0,
  };
}

// --- Pause / Resume (without snapshot, for disk copy) ---

export async function pauseVM(vmId: string): Promise<void> {
  const vm = runningVMs.get(vmId);
  if (!vm) throw new Error(`VM ${vmId} is not running`);
  await fcApi(vm.socketPath, "PATCH", "/vm", { state: "Paused" });
  await sleep(200); // let Firecracker quiesce
}

export async function resumeVM(vmId: string): Promise<void> {
  const vm = runningVMs.get(vmId);
  if (!vm) throw new Error(`VM ${vmId} is not running`);
  await fcApi(vm.socketPath, "PATCH", "/vm", { state: "Resumed" });
}

// --- Snapshot / Restore ---

export async function snapshotVM(vmId: string): Promise<void> {
  const vm = runningVMs.get(vmId);
  if (!vm) throw new Error(`VM ${vmId} is not running`);


  const snapshotDir = join(getDataDir(), vmId, "snapshot");
  mkdirSync(snapshotDir, { recursive: true });

  const snapshotPath = join(snapshotDir, "vmstate");
  const memPath = join(snapshotDir, "memory");

  // 1. Pause the VM (PATCH /vm with state: Paused)
  await fcApi(vm.socketPath, "PATCH", "/vm", {
    state: "Paused",
  });

  // Small delay to let Firecracker fully quiesce before snapshotting
  await sleep(200);

  // 2. Create snapshot
  await fcApi(vm.socketPath, "PUT", "/snapshot/create", {
    snapshot_path: snapshotPath,
    mem_file_path: memPath,
    snapshot_type: "Full",
  });

  // 3. Verify snapshot files were actually written
  if (!existsSync(snapshotPath) || !existsSync(memPath)) {
    throw new Error(`Snapshot files not found after create for VM ${vmId}`);
  }

  // 4. Kill Firecracker process
  killVmProcess(vm, vmId);

  // 5. Clean up TAP device and DNAT rules (re-added on restore)
  destroyTap(vm.tapDev);

  // 5b. Remove IPv4 DNAT + IPv6 NAT/firewall (re-added on restore)
  try {
    const { findVMById } = await import("../db/client.js");
    const { cidToVmIpv6 } = await import("./port-allocator.js");
    const vmRecord = findVMById(vmId);
    if (vmRecord) {
      // IPv4 DNAT — must be removed so wake-proxy can intercept while snapshotted
      removeDnat(vmRecord.app_port, vm.vmIp, 3000);
      removeDnat(vmRecord.opencode_port, vm.vmIp, 5000);

      // IPv6 NAT + firewall — keep address on interface so wake-proxy stays reachable
      const ula = cidToVmIpv6(vm.vsockCid);
      if (vmRecord.vm_ipv6 && ula && vmRecord.vm_ipv6 !== ula) {
        removeIpv6Nat(vmRecord.vm_ipv6, ula, true);
      }
      removeIpv6FirewallRules(vmId, ula || vmRecord.vm_ipv6);
    }
  } catch (err) {
    console.error(`[firecracker] Failed to clean up NAT/firewall on snapshot for ${vmId}:`, err);
  }

  // 6. Clean up sockets
  if (existsSync(vm.socketPath)) unlinkSync(vm.socketPath);
  const vsockSocket = join(getSocketDir(), `fc-${vmId}-vsock.sock`);
  if (existsSync(vsockSocket)) try { unlinkSync(vsockSocket); } catch { /* ok */ }

  runningVMs.delete(vmId);
}

export async function restoreVM(
  vmId: string,
  vsockCid: number,
  vmIp: string,
  appPort: number,
  sshPort: number,
  opencodePort: number,
): Promise<void> {

  const snapshotDir = join(getDataDir(), vmId, "snapshot");
  const snapshotPath = join(snapshotDir, "vmstate");
  const memPath = join(snapshotDir, "memory");

  if (!existsSync(snapshotPath) || !existsSync(memPath)) {
    throw new Error(`No snapshot found for VM ${vmId}`);
  }

  const socketPath = join(getSocketDir(), `fc-${vmId}.sock`);
  const tapDev = `tap-${vmId}`;

  // Clean up stale socket
  if (existsSync(socketPath)) unlinkSync(socketPath);

  // 1. Create TAP device
  createTap(tapDev, vmIp);

  // 2. Spawn Firecracker as a transient systemd service so it survives CP restarts
  const fcLogPath = join(join(getDataDir(), vmId), "firecracker.log");
  execSync(
    `systemd-run --unit fc-${vmId} --description "Firecracker VM ${vmId}" ` +
    `${getFcBin()} --api-sock ${socketPath} --log-path ${fcLogPath} --level Debug`,
    { stdio: "pipe" },
  );

  let fcPid = 0;
  try {
    fcPid = parseInt(
      execSync(`systemctl show fc-${vmId}.service -p MainPID --value`, { stdio: "pipe" }).toString().trim(),
      10,
    );
  } catch { /* ok */ }

  await waitForSocket(socketPath, 5000);

  // 3. Load snapshot
  await fcApi(socketPath, "PUT", "/snapshot/load", {
    snapshot_path: snapshotPath,
    mem_backend: {
      backend_path: memPath,
      backend_type: "File",
    },
  });

  // 4. Resume VM (PATCH /vm with state: Resumed)
  await fcApi(socketPath, "PATCH", "/vm", {
    state: "Resumed",
  });

  // 5. Re-add DNAT rules (SSH handled by ssh-proxy, no DNAT needed)
  addDnat(appPort, vmIp, 3000);
  addDnat(opencodePort, vmIp, 5000);

  // Re-apply IPv6 NAT + firewall rules from DB
  try {
    const { findVMById, getVMFirewallRules } = await import("../db/client.js");
    const { cidToVmIpv6 } = await import("./port-allocator.js");
    const vmRecord = findVMById(vmId);
    const ula = cidToVmIpv6(vsockCid);
    if (vmRecord?.vm_ipv6 && ula && vmRecord.vm_ipv6 !== ula) {
      addIpv6Nat(vmRecord.vm_ipv6, ula);
    }
    const firewallTarget = ula || vmRecord?.vm_ipv6;
    if (firewallTarget) {
      const rules = getVMFirewallRules(vmId);
      applyIpv6FirewallRules(vmId, firewallTarget, rules);
    }
  } catch (err) {
    console.error(`[firecracker] Failed to apply IPv6 rules on restore for ${vmId}:`, err);
  }

  const startedAt = new Date().toISOString();

  // Track the restored VM (process is null — managed by systemd)
  runningVMs.set(vmId, {
    process: null,
    pid: fcPid,
    socketPath,
    vsockCid,
    vmIp,
    tapDev,
    startedAt,
  });

  // Restored VMs don't re-run init.sh, so no vsock signal — use TCP poll directly
  await waitForTcpReady(vmIp, 22, 15000);

  // Clean up snapshot files after successful restore
  try {
    unlinkSync(snapshotPath);
    unlinkSync(memPath);
  } catch { /* ok */ }

}

// --- Process management ---

function killVmProcess(vm: { process: ChildProcess | null; pid: number }, vmId?: string): void {
  // Try to stop the systemd transient service first
  if (vmId) {
    try { execSync(`systemctl stop fc-${vmId}.service 2>/dev/null`, { stdio: "pipe", timeout: 5000 }); return; } catch { /* fall through */ }
  }
  if (vm.process && !vm.process.killed) {
    vm.process.kill("SIGTERM");
  } else if (vm.pid) {
    try { process.kill(vm.pid, "SIGTERM"); } catch { /* already dead */ }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile in-memory VM state with running Firecracker processes.
 * Called on startup to re-adopt VMs that survived a control plane restart.
 */
export async function reconcileRunningVMs(): Promise<void> {
  const { db } = await import("../db/client.js");
  const { cidToVmIpv6 } = await import("./port-allocator.js");

  const runningVMsList = db.prepare(
    "SELECT id, vm_ip, vm_ipv6, firewall_rules, vsock_cid, app_port, ssh_port, opencode_port FROM vms WHERE status = 'running'"
  ).all() as { id: string; vm_ip: string; vm_ipv6: string | null; firewall_rules: string | null; vsock_cid: number; app_port: number; ssh_port: number; opencode_port: number }[];

  if (runningVMsList.length === 0) return;

  console.log(`[reconcile] Found ${runningVMsList.length} VM(s) with status 'running', checking for live processes...`);

  for (const vm of runningVMsList) {
    const socketPath = join(getSocketDir(), `fc-${vm.id}.sock`);
    const tapDev = `tap-${vm.id}`;

    // Find the Firecracker PID for this VM
    let pid: number | null = null;
    try {
      const out = execSync(`pgrep -f "firecracker.*fc-${vm.id}\\.sock"`, { stdio: "pipe" }).toString().trim();
      const pids = out.split("\n").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
      if (pids.length > 0) pid = pids[0];
    } catch { /* no matching process */ }

    if (pid && isProcessAlive(pid)) {
      // Re-adopt this VM
      runningVMs.set(vm.id, {
        process: null,
        pid,
        socketPath,
        vsockCid: vm.vsock_cid,
        vmIp: vm.vm_ip,
        tapDev,
        startedAt: new Date().toISOString(), // approximate
      });

      // Re-establish iptables DNAT rules (SSH handled by ssh-proxy, no DNAT needed)
      addDnat(vm.app_port, vm.vm_ip, 3000);
      addDnat(vm.opencode_port, vm.vm_ip, 5000);

      // Re-apply IPv6 NAT + firewall rules
      const ula = cidToVmIpv6(vm.vsock_cid);
      if (vm.vm_ipv6 && ula && vm.vm_ipv6 !== ula) {
        try {
          addIpv6Nat(vm.vm_ipv6, ula);
        } catch (err) {
          console.error(`[reconcile] Failed to add IPv6 NAT for ${vm.id}:`, err);
        }
      }
      const firewallTarget = ula || vm.vm_ipv6;
      if (firewallTarget) {
        try {
          const rules: FirewallRule[] = vm.firewall_rules ? JSON.parse(vm.firewall_rules) : [];
          applyIpv6FirewallRules(vm.id, firewallTarget, rules);
        } catch (err) {
          console.error(`[reconcile] Failed to apply IPv6 firewall rules for ${vm.id}:`, err);
        }
      }

      console.log(`[reconcile] Re-adopted VM ${vm.id} (PID ${pid}), DNAT rules restored`);
    } else {
      // Process is dead — mark as stopped
      const { updateVMStatus } = await import("../db/client.js");
      updateVMStatus(vm.id, "stopped");
      console.log(`[reconcile] VM ${vm.id} process not found, marked as stopped`);
    }
  }
}

// --- Utilities ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(socketPath)) return;
    await sleep(50);
  }
  throw new Error(`Firecracker socket ${socketPath} not ready after ${timeoutMs}ms`);
}

async function waitForTcpReady(ip: string, port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const sock = netCreateConnection({ host: ip, port, timeout: 50 });
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => { sock.destroy(); resolve(false); });
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
    });
    if (connected) return;
    await sleep(5);
  }
  console.warn(`[firecracker] ${ip}:${port} not ready after ${timeoutMs}ms (continuing anyway)`);
}

/**
 * Get the vsock CID for a running VM. Returns 0 if not running.
 */
export function getVsockCid(vmId: string): number {
  return runningVMs.get(vmId)?.vsockCid || 0;
}

/**
 * Get the VM IP for a running VM. Returns empty string if not running.
 */
export function getVmIp(vmId: string): string {
  return runningVMs.get(vmId)?.vmIp || "";
}

/**
 * Check if a VM is currently running (in-memory).
 */
export function isVmRunning(vmId: string): boolean {
  return runningVMs.has(vmId);
}

/**
 * Destroy all running VMs (for graceful shutdown).
 */
export async function destroyAllVMs(): Promise<void> {
  for (const [vmId] of runningVMs) {
    try {
      await stopVM(vmId);
      destroyTap(`tap-${vmId}`);
    } catch { /* best effort */ }
  }
  runningVMs.clear();
}
