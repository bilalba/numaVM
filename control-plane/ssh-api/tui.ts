import type { ServerChannel } from "ssh2";
import type { SshUser } from "../services/ssh-key-lookup.js";
import { customAlphabet, nanoid } from "nanoid";
import { getDatabase, getVMEngine, getReverseProxy } from "../adapters/providers.js";
import { fetchSshKeys } from "../services/github.js";
import { registerPendingKey } from "../routes/user.js";

const generateSlug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);
const DEFAULT_DISK_SIZE = 1;

// ANSI escape codes
const ESC = "\x1b";
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const WHITE = `${ESC}[37m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const CLEAR_LINE = `${ESC}[2K`;
const HOME = `${ESC}[H`;

function moveTo(row: number, col: number): string {
  return `${ESC}[${row};${col}H`;
}

function clearBelow(): string {
  return `${ESC}[J`;
}

interface MenuItem {
  label: string;
  description: string;
  action: () => Promise<void> | void;
}

function getBaseDomain(): string {
  return process.env.BASE_DOMAIN || "localhost";
}

/**
 * Write a full frame to the channel in a single write call.
 * Builds the entire screen content as a string, then flushes once — no flicker.
 */
function writeFrame(channel: ServerChannel, lines: string[]): void {
  let buf = HOME;
  for (const line of lines) {
    buf += CLEAR_LINE + line + "\r\n";
  }
  buf += clearBelow();
  channel.write(buf);
}

/**
 * Show interactive TUI for authenticated users.
 */
export async function showAuthenticatedTui(channel: ServerChannel, user: SshUser, firstEntry = true): Promise<void> {
  const name = user.name || user.email;

  const mainMenu: MenuItem[] = [
    { label: "New VM", description: "Create a new VM", action: () => showCreateVM(channel, user) },
    { label: "My VMs", description: "List and connect to your VMs", action: () => showVMList(channel, user) },
    { label: "Account Info", description: "View your account details", action: () => showAccountInfo(channel, user) },
    { label: "Help", description: "Show available SSH commands", action: async () => { await showHelp(channel); return showAuthenticatedTui(channel, user, false); } },
    { label: "Quit", description: "Disconnect", action: () => exitTui(channel) },
  ];

  if (firstEntry) {
    channel.write(ALT_SCREEN_ON + HIDE_CURSOR);
  }
  await showMenu(channel, `Welcome, ${name}`, mainMenu, () => exitTui(channel));
}

function exitTui(channel: ServerChannel): void {
  channel.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  channel.exit(0);
  channel.close();
}

/**
 * Show interactive TUI for unauthenticated users (SSH key not recognized).
 * Collects email, shows verification link, polls until confirmed.
 */
export async function showUnauthenticatedTui(
  channel: ServerChannel,
  keyFingerprint: string,
  keyAlgo?: string,
  keyData?: Buffer,
): Promise<string> {
  const token = nanoid(16);
  const domain = getBaseDomain();

  channel.write(ALT_SCREEN_ON + HIDE_CURSOR);

  // Step 1: Welcome + ask for email
  channel.write(HOME + clearBelow());
  channel.write(`\r\n  ${BOLD}${CYAN}NUMAVM${RESET}${DIM}: get a VM over ssh${RESET}\r\n`);
  channel.write(`  To get started, please verify your email.\r\n`);
  channel.write(`\r\n`);
  channel.write(`  Please enter your email address: `);
  channel.write(SHOW_CURSOR);

  const email = await readLine(channel);
  channel.write(HIDE_CURSOR);

  if (!email || !email.includes("@")) {
    const errLines = [
      "",
      `  ${BOLD}${CYAN}NUMAVM${RESET}`,
      "",
      `  Invalid email address. Please try again.`,
      "",
    ];
    writeFrame(channel, errLines);
    await sleep(2000);
    exitTui(channel);
    return token;
  }

  // Step 2: Register the pending key with email
  if (keyAlgo && keyData) {
    const pubKeyStr = `${keyAlgo} ${keyData.toString("base64")} linked-via-ssh`;
    registerPendingKey(token, pubKeyStr, keyFingerprint, email);
  }

  // Step 3: Show verification link and poll
  const linkUrl = `https://app.${domain}/link-ssh?token=${token}`;

  const verifyLines = [
    "",
    `  ${BOLD}${CYAN}NUMAVM${RESET}`,
    "",
    `  Verify your email: ${GREEN}${linkUrl}${RESET}`,
    `  ${DIM}Waiting for verification...${RESET}`,
    "",
  ];
  writeFrame(channel, verifyLines);

  // Poll for confirmation
  const confirmed = await pollForConfirmation(channel, token, domain);

  if (confirmed) {
    const successLines = [
      "",
      `  ${BOLD}${CYAN}NUMAVM${RESET}`,
      "",
      `  ${GREEN}✓ Email verified successfully!${RESET}`,
      "",
      `  Your SSH key has been linked to your account.`,
      `  Reconnect to access your VMs.`,
      "",
      `  ${DIM}Disconnecting...${RESET}`,
      "",
    ];
    writeFrame(channel, successLines);
    await sleep(3000);
  }

  exitTui(channel);
  return token;
}

/**
 * Read a line of text input from the channel.
 */
function readLine(channel: ServerChannel): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let closed = false;

    function onData(data: Buffer) {
      const str = data.toString();

      for (const ch of str) {
        // Enter
        if (ch === "\r" || ch === "\n") {
          channel.removeListener("data", onData);
          resolve(buf.trim());
          return;
        }
        // Ctrl+C
        if (ch === "\x03") {
          channel.removeListener("data", onData);
          resolve("");
          return;
        }
        // Backspace
        if (ch === "\x7f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            channel.write("\b \b");
          }
          continue;
        }
        // Printable chars
        if (ch >= " " && ch <= "~") {
          buf += ch;
          channel.write(ch);
        }
      }
    }

    channel.on("data", onData);
    channel.on("close", () => {
      if (!closed) {
        closed = true;
        channel.removeListener("data", onData);
        resolve("");
      }
    });
  });
}

/**
 * Poll the link-ssh status endpoint until confirmed or timeout.
 */
async function pollForConfirmation(channel: ServerChannel, token: string, domain: string): Promise<boolean> {
  const apiBase = `http://localhost:4001`; // internal API
  const maxWaitMs = 10 * 60 * 1000; // 10 minutes
  const pollIntervalMs = 2000;
  const startTime = Date.now();
  let cancelled = false;

  // Listen for Ctrl+C to cancel
  const cancelHandler = (data: Buffer) => {
    if (data.toString() === "\x03") {
      cancelled = true;
    }
  };
  channel.on("data", cancelHandler);

  while (!cancelled && Date.now() - startTime < maxWaitMs) {
    try {
      const res = await fetch(`${apiBase}/link-ssh/${token}/status`);
      if (res.ok) {
        const body = await res.json() as { confirmed: boolean };
        if (body.confirmed) {
          channel.removeListener("data", cancelHandler);
          return true;
        }
      } else {
        // Token expired
        channel.removeListener("data", cancelHandler);
        return false;
      }
    } catch {
      // API unreachable — keep trying
    }
    await sleep(pollIntervalMs);
  }

  channel.removeListener("data", cancelHandler);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function showMenu(
  channel: ServerChannel,
  title: string,
  items: MenuItem[],
  onExit: () => void,
): Promise<void> {
  let selected = 0;

  function render() {
    const lines: string[] = [""];
    // Support multi-line titles (split on \n)
    for (const tl of title.split("\n")) {
      lines.push(`  ${BOLD}${CYAN}${tl}${RESET}`);
    }
    lines.push("");

    for (let i = 0; i < items.length; i++) {
      if (i === selected) {
        lines.push(`${GREEN}  ▸ ${BOLD}${WHITE}${items[i].label}${RESET}  ${DIM}${items[i].description}${RESET}`);
      } else {
        lines.push(`${DIM}    ${items[i].label}${RESET}`);
      }
    }

    lines.push("");
    lines.push(`  ${DIM}↑/↓ navigate  ↵ select  q quit${RESET}`);

    writeFrame(channel, lines);
  }

  render();

  return new Promise<void>((resolve) => {
    function onData(data: Buffer) {
      const key = data.toString();

      if (key === "\x03" || key === "q" || key === "Q") {
        channel.removeListener("data", onData);
        onExit();
        resolve();
        return;
      }

      // Arrow up / k
      if (key === `${ESC}[A` || key === "k") {
        selected = (selected - 1 + items.length) % items.length;
        render();
        return;
      }

      // Arrow down / j
      if (key === `${ESC}[B` || key === "j") {
        selected = (selected + 1) % items.length;
        render();
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        channel.removeListener("data", onData);
        const action = items[selected].action();
        if (action instanceof Promise) {
          action.then(resolve).catch(() => resolve());
        } else {
          resolve();
        }
        return;
      }
    }

    channel.on("data", onData);

    channel.on("close", () => {
      channel.removeListener("data", onData);
      resolve();
    });
  });
}

async function showVMList(channel: ServerChannel, user: SshUser): Promise<void> {
  const vms = getDatabase().findVMsByUser(user.userId);

  const items: MenuItem[] = [
    { label: "+ New VM", description: "Create a new VM", action: () => showCreateVM(channel, user) },
  ];

  if (vms.length === 0) {
    items.push({
      label: "← Back",
      description: "Return to main menu",
      action: () => showAuthenticatedTui(channel, user, false),
    });
    await showMenu(channel, "My VMs\n  No VMs yet", items, () => showAuthenticatedTui(channel, user, false));
    return;
  }

  for (const vm of vms) {
    items.push({
      label: `${vm.name} ${DIM}(${vm.id})${RESET}`,
      description: statusBadge(vm.status),
      action: () => showVMDetail(channel, user, vm.id),
    });
  }

  items.push({
    label: "← Back",
    description: "Return to main menu",
    action: () => showAuthenticatedTui(channel, user, false),
  });

  await showMenu(channel, "My VMs", items, () => showAuthenticatedTui(channel, user, false));
}

async function showCreateVM(channel: ServerChannel, user: SshUser): Promise<void> {
  const baseDomain = getBaseDomain();
  const userPlan = getDatabase().getUserPlan(user.userId);

  // Check quota before prompting
  const currentRam = getDatabase().getUserProvisionedRam(user.userId);
  const minMem = Math.min(...userPlan.valid_mem_sizes);
  if (currentRam + minMem > userPlan.max_ram_mib) {
    const lines = [
      "",
      `  ${BOLD}New VM${RESET}`,
      "",
      `  ${YELLOW}RAM quota exceeded (${currentRam}/${userPlan.max_ram_mib} MiB used).${RESET}`,
      `  Stop a VM or upgrade your plan.`,
      "",
      `  ${DIM}Press any key to go back...${RESET}`,
    ];
    writeFrame(channel, lines);
    await waitForKey(channel);
    return showAuthenticatedTui(channel, user, false);
  }

  // Step 1: Name
  channel.write(HOME + clearBelow());
  channel.write(`\r\n  ${BOLD}${CYAN}New VM${RESET}\r\n\r\n`);
  channel.write(`  Name: `);
  channel.write(SHOW_CURSOR);
  const name = await readLine(channel);
  channel.write(HIDE_CURSOR);

  if (!name || name.length < 1 || name.length > 64) {
    const lines = ["", `  ${YELLOW}Name is required (1-64 chars). Cancelled.${RESET}`, ""];
    writeFrame(channel, lines);
    await sleep(1500);
    return showAuthenticatedTui(channel, user, false);
  }

  // Step 2: Advanced options (optional)
  const currentDisk = getDatabase().getUserProvisionedDisk(user.userId);
  const availableMem = userPlan.valid_mem_sizes.filter(
    (m: number) => currentRam + m <= userPlan.max_ram_mib,
  );
  const availableDisk = userPlan.valid_disk_sizes.filter(
    (d: number) => currentDisk + d <= userPlan.max_disk_gib,
  );
  const defaultMem = availableMem.includes(256) ? 256 : availableMem[0] || 256;
  const defaultDisk = availableDisk.includes(DEFAULT_DISK_SIZE) ? DEFAULT_DISK_SIZE : availableDisk[0] || DEFAULT_DISK_SIZE;
  let memSizeMib = defaultMem;
  let diskSizeGib = defaultDisk;

  // Ask if user wants to configure resources
  let configureResources = false;
  const configItems: MenuItem[] = [
    {
      label: `Use defaults (${defaultMem} MiB RAM, ${defaultDisk} GiB disk)`,
      description: "",
      action: () => { configureResources = false; },
    },
    {
      label: "Configure RAM & disk",
      description: "",
      action: () => { configureResources = true; },
    },
  ];
  await showMenu(channel, `New VM: ${name}\n  Resources`, configItems, () => { memSizeMib = 0; });
  if (memSizeMib === 0) {
    return showAuthenticatedTui(channel, user, false);
  }

  if (configureResources) {
    // RAM selection
    if (availableMem.length > 1) {
      let memSelected = false;
      const memItems: MenuItem[] = availableMem.map((m: number) => ({
        label: `${m} MiB`,
        description: m === defaultMem ? "default" : "",
        action: () => { memSizeMib = m; memSelected = true; },
      }));
      await showMenu(channel, `New VM: ${name}\n  Select RAM`, memItems, () => { memSelected = false; });
      if (!memSelected) {
        return showAuthenticatedTui(channel, user, false);
      }
    }

    // Disk selection
    if (availableDisk.length > 1) {
      let diskSelected = false;
      const diskItems: MenuItem[] = availableDisk.map((d: number) => ({
        label: `${d} GiB`,
        description: d === defaultDisk ? "default" : "",
        action: () => { diskSizeGib = d; diskSelected = true; },
      }));
      await showMenu(channel, `New VM: ${name}\n  Select disk size`, diskItems, () => { diskSelected = false; });
      if (!diskSelected) {
        return showAuthenticatedTui(channel, user, false);
      }
    }
  }

  // Step 3: GitHub repo (optional)
  channel.write(HOME + clearBelow());
  channel.write(`\r\n  ${BOLD}${CYAN}New VM: ${name}${RESET}\r\n`);
  channel.write(`  ${DIM}Memory: ${memSizeMib} MiB | Disk: ${diskSizeGib} GiB${RESET}\r\n\r\n`);
  channel.write(`  GitHub repo ${DIM}(owner/repo, Enter to skip)${RESET}: `);
  channel.write(SHOW_CURSOR);
  const repoInput = await readLine(channel);
  channel.write(HIDE_CURSOR);
  const repoFullName = repoInput && repoInput.includes("/") ? repoInput : null;

  // GitHub token check
  const dbUser = getDatabase().findUserById(user.userId);
  const ghToken = dbUser?.github_token || process.env.GH_PAT || null;
  if (repoFullName && !ghToken) {
    const lines = [
      "",
      `  ${YELLOW}GitHub not connected. Connect your GitHub account first to use repo cloning.${RESET}`,
      "",
      `  ${DIM}Press any key to go back...${RESET}`,
    ];
    writeFrame(channel, lines);
    await waitForKey(channel);
    return showAuthenticatedTui(channel, user, false);
  }

  // Step 4: Create
  const creatingLines = [
    "",
    `  ${BOLD}${CYAN}Creating VM...${RESET}`,
    "",
    `  Name:    ${name}`,
    `  Memory:  ${memSizeMib} MiB`,
    `  Disk:    ${diskSizeGib} GiB`,
    ...(repoFullName ? [`  Repo:    ${repoFullName}`] : []),
    "",
    `  ${DIM}Starting VM, this may take 30-60 seconds...${RESET}`,
    "",
  ];
  writeFrame(channel, creatingLines);

  const slug = `vm-${generateSlug()}`;
  const { appPort, sshPort, opencodePort, vsockCid, vmIp } = getVMEngine().allocateResources();

  // Fetch SSH keys
  const keyParts: string[] = [];
  if (dbUser?.github_username) {
    const ghKeys = await fetchSshKeys(dbUser.github_username);
    if (ghKeys) keyParts.push(ghKeys);
  }
  if (dbUser?.ssh_public_keys) {
    keyParts.push(dbUser.ssh_public_keys);
  }
  const sshKeys = keyParts.join("\n");

  const opencodePassword = generateSlug() + generateSlug() + generateSlug() + generateSlug();

  getDatabase().insertVM({
    id: slug,
    name,
    owner_id: user.userId,
    gh_repo: repoFullName,
    gh_token: ghToken,
    container_id: null,
    vm_ip: vmIp,
    vsock_cid: vsockCid,
    vm_pid: null,
    snapshot_path: null,
    app_port: appPort,
    ssh_port: sshPort,
    opencode_port: opencodePort,
    opencode_password: opencodePassword,
    status: "creating",
    status_detail: null,
    mem_size_mib: memSizeMib,
    disk_size_gib: diskSizeGib,
    image: "alpine",
    image_version: 1,
  });
  getDatabase().grantAccess(slug, user.userId, "owner");

  try {
    const vmId = await getVMEngine().createAndStartVM({
      slug,
      name,
      appPort,
      sshPort,
      opencodePort,
      ghRepo: repoFullName || undefined,
      ghToken: ghToken || undefined,
      githubUsername: dbUser?.github_username || undefined,
      sshKeys,
      opencodePassword,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      vsockCid,
      vmIp,
      memSizeMib,
    });
    getDatabase().updateVMInfo(slug, vmId, vmIp, vsockCid, null);
  } catch (err: any) {
    getDatabase().revokeAllAccess(slug);
    getDatabase().deleteVM(slug);
    const errLines = [
      "",
      `  ${BOLD}New VM${RESET}`,
      "",
      `  ${YELLOW}Failed to create VM: ${err.message}${RESET}`,
      "",
      `  ${DIM}Press any key to go back...${RESET}`,
    ];
    writeFrame(channel, errLines);
    await waitForKey(channel);
    return showAuthenticatedTui(channel, user, false);
  }

  getDatabase().updateVMStatus(slug, "running");

  try { await getReverseProxy().addRoute(slug, appPort); } catch { /* non-fatal */ }
  getDatabase().emitAdminEvent("vm.created", slug, user.userId, { name, mem_size_mib: memSizeMib, ...(repoFullName ? { repo: repoFullName } : {}), source: "ssh-tui" });

  // Success screen
  const successItems: MenuItem[] = [
    {
      label: "Connect now",
      description: `ssh ${slug}@ssh.${baseDomain}`,
      action: () => {
        // Exit TUI and show connection info
        channel.write(SHOW_CURSOR + ALT_SCREEN_OFF);
        channel.write(`\r\nConnect with: ${CYAN}ssh ${slug}@ssh.${baseDomain}${RESET}\r\n`);
        channel.exit(0);
        channel.close();
      },
    },
    {
      label: "Back to menu",
      description: "Return to main menu",
      action: () => showAuthenticatedTui(channel, user, false),
    },
  ];

  const title = [
    `VM Created`,
    ``,
    `  ${GREEN}✓${RESET} ${BOLD}${name}${RESET} ${DIM}(${slug})${RESET}`,
    `  URL:  ${CYAN}https://${slug}.${baseDomain}${RESET}`,
    `  SSH:  ${CYAN}ssh ${slug}@ssh.${baseDomain}${RESET}`,
  ].join("\n");

  await showMenu(channel, title, successItems, () => showAuthenticatedTui(channel, user, false));
}

async function showVMDetail(channel: ServerChannel, user: SshUser, vmId: string): Promise<void> {
  const vm = getDatabase().findVMsByUser(user.userId).find((e: any) => e.id === vmId);
  if (!vm) {
    return showVMList(channel, user);
  }

  const lines = [
    "",
    `  ${BOLD}${vm.name}${RESET} ${DIM}${vm.id}${RESET}`,
    "",
    `  Status:  ${statusBadge(vm.status)}`,
    `  Role:    ${vm.role}`,
    `  RAM:     ${vm.mem_size_mib} MiB`,
    `  URL:     ${CYAN}https://${vm.id}.${getBaseDomain()}${RESET}`,
    `  SSH:     ${CYAN}ssh ${vm.id}@ssh.${getBaseDomain()}${RESET}`,
    "",
    `  ${DIM}Press any key to go back...${RESET}`,
  ];
  writeFrame(channel, lines);

  await waitForKey(channel);
  return showVMList(channel, user);
}

async function showAccountInfo(channel: ServerChannel, user: SshUser): Promise<void> {
  const lines = [
    "",
    `  ${BOLD}Account Info${RESET}`,
    "",
    `  Email:    ${user.email}`,
  ];
  if (user.name) lines.push(`  Name:     ${user.name}`);
  if (user.githubUsername) lines.push(`  GitHub:   ${user.githubUsername}`);
  lines.push(`  Plan:     ${user.plan}`);
  lines.push(`  User ID:  ${DIM}${user.userId}${RESET}`);
  lines.push("");
  lines.push(`  ${DIM}Press any key to go back...${RESET}`);

  writeFrame(channel, lines);
  await waitForKey(channel);
  return showAuthenticatedTui(channel, user, false);
}

async function showHelp(channel: ServerChannel): Promise<void> {
  const lines = [
    "",
    `  ${BOLD}SSH API Commands${RESET}`,
    "",
    `  ${CYAN}ssh ssh.numavm.com new --name <n>${RESET}           Create new VM`,
    `  ${CYAN}ssh ssh.numavm.com vms${RESET}                     List VMs`,
    `  ${CYAN}ssh ssh.numavm.com vms create --name <n>${RESET}   Create new VM`,
    `  ${CYAN}ssh ssh.numavm.com vms <id>${RESET}                VM details`,
    `  ${CYAN}ssh ssh.numavm.com vms <id> start${RESET}          Start/wake VM`,
    `  ${CYAN}ssh ssh.numavm.com vms <id> stop${RESET}           Snapshot VM`,
    `  ${CYAN}ssh ssh.numavm.com vms <id> delete${RESET}         Delete VM`,
    `  ${CYAN}ssh ssh.numavm.com whoami${RESET}                   Account info (JSON)`,
    `  ${CYAN}ssh ssh.numavm.com help${RESET}                     This help`,
    "",
    `  ${BOLD}VM shell access:${RESET}`,
    `  ${CYAN}ssh <vm-id>@ssh.numavm.com${RESET}                 Interactive shell`,
    `  ${CYAN}ssh <vm-id>@ssh.numavm.com <command>${RESET}       Run command in VM`,
    "",
    `  ${DIM}Press any key to go back...${RESET}`,
  ];
  writeFrame(channel, lines);
  await waitForKey(channel);
}

function statusBadge(status: string): string {
  switch (status) {
    case "running": return `${GREEN}● running${RESET}`;
    case "snapshotted": return `${YELLOW}◉ snapshotted${RESET}`;
    case "paused": return `${YELLOW}◉ paused${RESET}`;
    case "creating": return `${CYAN}◌ creating${RESET}`;
    default: return `${DIM}○ ${status}${RESET}`;
  }
}

function waitForKey(channel: ServerChannel): Promise<void> {
  return new Promise((resolve) => {
    function onData() {
      channel.removeListener("data", onData);
      resolve();
    }
    channel.on("data", onData);
    channel.on("close", () => {
      channel.removeListener("data", onData);
      resolve();
    });
  });
}
