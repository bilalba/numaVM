import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// --- Config (lazy reads for ESM import hoisting) ---

function getFcBin() { return process.env.FC_BIN || "/opt/firecracker/bin/firecracker"; }
function getKernelPath() { return process.env.FC_KERNEL || "/opt/firecracker/kernel/vmlinux"; }
function getRootfsPath() { return process.env.FC_ROOTFS || "/opt/firecracker/rootfs/base.ext4"; }
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
  vcpuCount?: number;
  memSizeMib?: number;
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

// --- Lifecycle ---

export async function createAndStartVM(params: CreateVMParams): Promise<string> {
  const {
    slug, name, appPort, sshPort, opencodePort,
    ghRepo, ghToken, githubUsername, sshKeys, opencodePassword,
    openaiApiKey, anthropicApiKey,
    vsockCid, vmIp,
    vcpuCount = getDefaultVcpu(),
    memSizeMib = getDefaultMem(),
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

  // Create writable rootfs overlay (copy-on-write via Firecracker's overlay support)
  // Firecracker doesn't natively support overlayfs for rootfs, so we use a per-VM
  // writable copy. The base rootfs is shared read-only; we create a thin writable layer.
  const vmRootfs = join(dataDir, "rootfs.ext4");
  if (!existsSync(vmRootfs)) {
    // Create a sparse copy — uses reflinks on supported filesystems, falls back to cp
    try {
      execSync(`cp --reflink=auto "${getRootfsPath()}" "${vmRootfs}"`, { stdio: "pipe" });
    } catch {
      execSync(`cp "${getRootfsPath()}" "${vmRootfs}"`, { stdio: "pipe" });
    }
  }

  progress("Creating rootfs overlay");

  // Create TAP device
  createTap(tapDev, vmIp);

  // Write env config to a file that init.sh can read
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

  // Build kernel cmdline with dm.* params
  // Base64-encode SSH keys to avoid whitespace issues in cmdline
  const sshKeysB64 = Buffer.from(
    sshKeys + "\n" + getInternalSshPubKey()
  ).toString("base64");

  const envNameB64 = Buffer.from(name || slug).toString("base64");

  const kernelArgs = [
    "console=ttyS0",
    "reboot=k",
    "panic=1",
    "pci=off",
    "nomodules",
    "random.trust_cpu=on",
    "i8042.noaux",
    "init=/sbin/numavm-init",
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
  ].join(" ");

  progress("Starting Firecracker");

  // Spawn Firecracker as a transient systemd service so it survives CP restarts.
  // `systemd-run` (without --scope) forks the command as an independent service unit
  // with its own cgroup, then exits immediately. The FC process lives on.
  const fcLogPath = join(dataDir, "firecracker.log");
  execSync(
    `systemd-run --unit fc-${slug} --description "Firecracker VM ${slug}" ` +
    `${getFcBin()} --api-sock ${socketPath} --log-path ${fcLogPath} --level Debug`,
    { stdio: "pipe" },
  );

  // systemd-run exits immediately; FC is now managed by systemd
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

  // 3. Rootfs
  await fcApi(socketPath, "PUT", "/drives/rootfs", {
    drive_id: "rootfs",
    path_on_host: vmRootfs,
    is_root_device: true,
    is_read_only: false,
  });

  // 4. Data volume (persistent storage)
  const dataVolume = join(dataDir, "data.ext4");
  if (!existsSync(dataVolume)) {
    // Create a 10GB sparse data volume
    execSync(`dd if=/dev/zero of="${dataVolume}" bs=1 count=0 seek=10G 2>/dev/null`, { stdio: "pipe" });
    execSync(`mkfs.ext4 -F -q "${dataVolume}"`, { stdio: "pipe" });
  }
  await fcApi(socketPath, "PUT", "/drives/data", {
    drive_id: "data",
    path_on_host: dataVolume,
    is_root_device: false,
    is_read_only: false,
  });

  // 5. Network
  await fcApi(socketPath, "PUT", "/network-interfaces/eth0", {
    iface_id: "eth0",
    host_dev_name: tapDev,
  });

  // 6. Vsock
  await fcApi(socketPath, "PUT", "/vsock", {
    guest_cid: vsockCid,
    uds_path: join(getSocketDir(), `fc-${slug}-vsock.sock`),
  });

  // 7. Start the VM
  progress("Booting kernel");
  await fcApi(socketPath, "PUT", "/actions", {
    action_type: "InstanceStart",
  });

  // Set up iptables DNAT for port forwarding (SSH handled by ssh-proxy)
  addDnat(appPort, vmIp, 3000);    // app port
  addDnat(opencodePort, vmIp, 5000); // OpenCode port

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

  // Wait for VM to be ready (SSH accessible over bridge network)
  progress("Waiting for SSH");
  await waitForVmSsh(vmIp, 30000);

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
): Promise<void> {
  await removeVM(vmId);

  // Clean up DNAT rules (SSH handled by ssh-proxy, no DNAT to remove)
  removeDnat(appPort, vmIp, 3000);
  removeDnat(opencodePort, vmIp, 5000);
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

  // 5. Clean up TAP device and DNAT rules (caller handles DNAT)
  destroyTap(vm.tapDev);

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

  // Wait for SSH over bridge network
  await waitForVmSsh(vmIp, 15000);

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

  const runningVMsList = db.prepare(
    "SELECT id, vm_ip, vsock_cid, app_port, ssh_port, opencode_port FROM vms WHERE status = 'running'"
  ).all() as { id: string; vm_ip: string; vsock_cid: number; app_port: number; ssh_port: number; opencode_port: number }[];

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

async function waitForVmSsh(vmIp: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const keyPath = getInternalSshKeyPath();

  while (Date.now() - start < timeoutMs) {
    try {
      execSync(
        `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ` +
        `-o ConnectTimeout=2 -o LogLevel=ERROR ` +
        `-i "${keyPath}" dev@${vmIp} echo ok`,
        { stdio: "pipe", timeout: 5000 },
      );
      return; // SSH is ready
    } catch {
      await sleep(500);
    }
  }
  // Don't throw — VM may still be booting but SSH not ready yet
  console.warn(`[firecracker] VM ${vmIp}: SSH not ready after ${timeoutMs}ms (continuing anyway)`);
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
