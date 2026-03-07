# NumaVM — EC2 Deployment Guide

This document covers deploying NumaVM on a bare-metal/EC2 instance with Firecracker support.

## Production Instance Requirements

- **Architecture**: aarch64 (or x86_64), Ubuntu 24.04 recommended
- **Minimum**: 4 cores, 8GB RAM (more for concurrent VMs)
- **KVM**: Must have `/dev/kvm` available (bare-metal or nested virtualization)

## Services Running

| Service | Port | Run As | Command |
|---------|------|--------|---------|
| Auth | 4000 | ubuntu | `npx tsx auth/server.ts` |
| Control Plane | 4001 | root (needs TAP/iptables) | `sudo -E npx tsx control-plane/server.ts` |
| Dashboard | 4002 | ubuntu | `npx serve -s dist -l 4002 --cors` |

**Important**: The control plane MUST run as root because it creates TAP devices, iptables DNAT rules, and spawns Firecracker processes.

## Installed Components

| Component | Path | Version |
|-----------|------|---------|
| Firecracker | `/opt/firecracker/bin/firecracker` | v1.10.1 |
| Jailer | `/opt/firecracker/bin/jailer` | v1.10.1 |
| Kernel | `/opt/firecracker/kernel/vmlinux` | 6.1.102 (from `firecracker-ci/v1.9/aarch64/`) |
| Rootfs | `/opt/firecracker/rootfs/base.ext4` | 976MB Alpine 3.21 ext4 |
| TAP helpers | `/opt/firecracker/bin/{create,destroy}-tap` | — |
| DNAT helpers | `/opt/firecracker/bin/{add,remove}-dnat` | — |
| Caddy | `/usr/bin/caddy` | v2.11.1 (installed, not yet configured) |
| Node.js (host) | `/usr/bin/node` | v22.22.0 |
| socat (host) | `/usr/bin/socat` | v1.8.0.0 |
| Bridge | `br0` at `172.16.0.1/16` | — |
| Data dir | `/data/envs` | — |

## VM Rootfs Contents

Alpine 3.21 with:
- **Node.js 24** (from Alpine edge, with matching libssl3/libcrypto3)
- **Codex CLI** (`@openai/codex`) — installed globally
- **Claude Code CLI** (`@anthropic-ai/claude-code`) — installed globally
- **OpenCode** (`/root/.opencode/bin/opencode`, symlinked to `/usr/local/bin/opencode`)
- **PM2** process manager
- SSH, git, Python 3, build-base, socat, tmux, curl, jq, iptables

## Environment Variables (`.env`)

```bash
JWT_SECRET=<random-hex>          # Generate with: openssl rand -hex 32
BASE_DOMAIN=your-host.example.com
DATA_DIR=/data/envs
AUTH_PORT=4000
DEV_MODE=true    # Bypasses OAuth, uses fake dev-user identity

# Optional — fill in for full functionality:
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
RESEND_API_KEY=
GH_PAT=          # For auto-creating GitHub repos on env creation
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

### DEV_MODE=true

When `DEV_MODE=true`, the control plane skips Caddy `forward_auth` and auto-creates a `dev-user` identity. This is required when running without Caddy or without OAuth configured.

### Dashboard `.env`

```bash
VITE_API_URL=//your-host.example.com:4001
```

Must be rebuilt (`cd dashboard && npm run build`) after changing this value.

## Deployment Steps (from scratch)

### 1. Transfer files
```bash
rsync -avz --exclude node_modules --exclude '*.db' --exclude .data --exclude .claude \
  /path/to/numavm/ numavm:~/numavm/
```

### 2. Install system dependencies
```bash
ssh numavm
sudo apt-get install -y build-essential python3 socat
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Load vhost_vsock kernel module (required for Firecracker vsock device)
sudo modprobe vhost_vsock
echo 'vhost_vsock' | sudo tee /etc/modules-load.d/vhost-vsock.conf
```

### 3. Run host setup (Firecracker, bridge, NAT)
```bash
cd ~/numavm && sudo bash infra/setup-host.sh
```

### 4. Download kernel 6.1 (replaces the broken 4.14 fallback)
```bash
sudo curl -fsSL \
  'https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.9/aarch64/vmlinux-6.1.102' \
  -o /opt/firecracker/kernel/vmlinux
```

**Critical**: The setup script's primary kernel URL (v1.10 CI) returns 404. The fallback downloads kernel 4.14 which is too old for the Alpine rootfs. Must manually download 6.1 from v1.9 CI.

### 5. Build VM rootfs
```bash
cd ~/numavm/vm && sudo bash build-rootfs.sh
```

Takes ~2-3 minutes. Installs Alpine packages + Node.js + agent CLIs.

### 6. Install npm dependencies
```bash
cd ~/numavm && npm install
```

### 7. Fix data dir permissions
```bash
sudo chown -R ubuntu:ubuntu /data/envs
```

### 8. Configure .env
See "Environment Variables" section above.

### 9. Build dashboard
```bash
cd ~/numavm/dashboard && npm run build
```

### 10. Start services
```bash
# Auth (as regular user)
cd ~/numavm && nohup npx tsx auth/server.ts > /tmp/auth.log 2>&1 &

# Control plane (as root — needs TAP/iptables)
cd ~/numavm && sudo -E nohup npx tsx control-plane/server.ts > /tmp/control-plane.log 2>&1 &

# Dashboard (static file server)
cd ~/numavm/dashboard && nohup npx serve -s dist -l 4002 --cors > /tmp/dashboard.log 2>&1 &
```

### 11. AWS Security Group

Open these inbound ports:
- **22** — SSH
- **4000-4002** — Auth, Control Plane, Dashboard
- **80, 443** — Caddy (when configured)
- **10001-10100** — VM app ports
- **20001-20100** — VM SSH ports

## Known Issues & Fixes Applied

### Kernel 4.14 too old
The Firecracker CI S3 bucket doesn't have v1.10 kernels. The fallback URL downloads kernel 4.14.174 which causes `Attempted to kill init!` panics because the Alpine rootfs binaries need newer syscalls. **Fix**: Download kernel 6.1.102 from the v1.9 CI path.

### Alpine edge Node.js 24 OpenSSL mismatch
Alpine edge's Node.js 24 package is built against a newer OpenSSL that provides `EVP_MD_CTX_get_size_ex`, but the base Alpine 3.21 `libssl3` doesn't have it. **Fix**: Upgrade `libssl3` and `libcrypto3` from edge *before* installing Node.js (see `build-rootfs.sh`).

### init.sh `ip link set eth0 up` crash
The init script used `set -e` and `ip link set eth0 up` without error handling, causing a kernel panic if eth0 doesn't exist yet. **Fix**: Added `2>/dev/null || true`.

### CORS for non-localhost
The control plane only allowed CORS from `localhost:4002` or `app.${BASE_DOMAIN}`. When accessing via IP or hostname on port 4002 (without Caddy), CORS was blocked. **Fix**: CORS now uses dynamic origin validation — accepts any origin containing the `BASE_DOMAIN` or any origin on port 4002 (to support IP-based access like `http://<server-ip>:4002`).

### Control plane needs root
Creating TAP devices, iptables rules, and spawning Firecracker all require root. Running as regular user causes `EACCES` and `TUNSETIFF: Operation not permitted` errors.

### `/data/envs` permissions
Created by root during `setup-host.sh` but the control plane (even when running as root) creates subdirectories. Ensure the directory is accessible.

### OpenSSH 10+ rejects locked accounts
Alpine's `adduser -D` creates user accounts with `!` in `/etc/shadow` (locked). OpenSSH 10.2 (in Alpine edge) rejects pubkey authentication for locked accounts, even with `UsePAM no`. **Fix**: `init.sh` runs `sed -i 's/^dev:!:/dev:*:/' /etc/shadow` at boot. Also fixed in `build-rootfs.sh` so new base images don't have this issue.

### Firecracker vsock not usable via AF_VSOCK from host
`socat VSOCK-CONNECT:${cid}:22` uses the kernel's `AF_VSOCK` socket family, but Firecracker exposes its vsock through a Unix domain socket (`/tmp/fc-{slug}-vsock.sock`) with a custom `CONNECT <port>\n` / `OK <cid>\n` handshake protocol. The AF_VSOCK approach fails with "No such device". **Fix**: Switched all VM exec to TCP SSH over the bridge network (`172.16.0.x`). The `vsock-ssh.ts` functions now connect directly to the VM's bridge IP instead of using a vsock proxy command.

### `vhost_vsock` kernel module not loaded
The `vhost_vsock` module must be loaded for Firecracker's vsock device to work. Without it, VM creation succeeds but vsock UDS sockets are non-functional. **Fix**: `sudo modprobe vhost_vsock` + persisted in `/etc/modules-load.d/vhost-vsock.conf`.

### `socat` missing on host
The host Ubuntu instance didn't have `socat` installed. While no longer needed for vsock SSH proxy (switched to TCP), it's used inside VMs for the vsock listener and useful for debugging. **Fix**: `sudo apt install socat`.

### Caddy admin API 403 "not allowed from origin ''"
Node.js `fetch()` doesn't send an `Origin` header by default. Caddy's admin API requires one and returns 403 without it. **Fix**: Added `Origin: ${caddyAdmin}` header to all Caddy admin API requests in `caddy.ts`.

## Patching the Rootfs Without Full Rebuild

To update files inside the rootfs without rebuilding from scratch:
```bash
sudo bash -c '
MOUNTDIR=$(mktemp -d)
LOOP=$(losetup --find --show /opt/firecracker/rootfs/base.ext4)
mount $LOOP $MOUNTDIR
# Make your changes, e.g.:
cp /home/ubuntu/numavm/vm/init.sh $MOUNTDIR/opt/numavm/init.sh
chmod +x $MOUNTDIR/opt/numavm/init.sh
umount $MOUNTDIR
losetup -d $LOOP
rmdir $MOUNTDIR
'
```

## Firecracker Kernel Sources

Pre-built kernels are hosted at:
```
https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v{VERSION}/{ARCH}/vmlinux-{KERNEL}
```

Available versions (as of March 2026):
- `v1.5` through `v1.9` — have aarch64 kernels
- `v1.10` — **does NOT exist** in S3
- For aarch64, use `vmlinux-6.1.102` from v1.9

To list available kernels:
```bash
curl -s 'https://s3.amazonaws.com/spec.ccfc.min/?prefix=firecracker-ci/v1.9/aarch64/vmlinux' \
  | grep -oP '<Key>[^<]+'
```

## VM SSH Exec Architecture

The control plane executes commands inside VMs via SSH over the bridge network:

```
Control Plane → SSH (tcp) → 172.16.0.x:22 → VM sshd → command
```

- **Auth**: Internal ed25519 keypair at `/data/envs/.ssh/numavm_internal`
- **User**: Commands run as `dev` (UID 1000, sudo NOPASSWD)
- **Functions** (`control-plane/services/vsock-ssh.ts`):
  - `execInVM(vmIp, cmd)` — run a command, return stdout
  - `spawnPtyOverVsock(vmIp, cmd, cols, rows)` — interactive PTY session (terminal)
  - `spawnProcessOverVsock(vmIp, cmd)` — long-running process with stdio pipes (agent bridges)
- **Readiness check**: After VM start, `waitForVmSsh(vmIp, timeout)` polls SSH until the VM responds (typically 2-5s)

**Note**: The file is still named `vsock-ssh.ts` and functions still have "vsock" in their names for historical reasons. They actually use TCP SSH to the VM's bridge IP.

## Logs

- Auth: `/tmp/auth.log`
- Control Plane: `/tmp/control-plane.log`
- Dashboard: `/tmp/dashboard.log`
- Firecracker per-VM: `/data/envs/{slug}/firecracker.log`
