# NumaVM — Production Deployment Guide

Complete guide for deploying NumaVM on a fresh server. Tested on Ubuntu 24.04 (aarch64) on AWS EC2 `.metal` instances.

## Server Requirements

| Requirement | Details |
|---|---|
| **OS** | Ubuntu 24.04 LTS (other Linux distros may work but are untested) |
| **Architecture** | aarch64 or x86_64 |
| **KVM** | `/dev/kvm` must exist — bare-metal or `.metal` EC2 instances |
| **CPU / RAM** | 4+ cores, 16+ GB RAM recommended (each VM uses 256–1536 MiB) |
| **Disks** | Root volume (40 GB+) for OS, separate data volume (200 GB+) for VM storage |

### Why a Separate Data Volume?

The data volume **must be XFS with reflinks enabled**. When creating a VM, the host copies a 2–4 GB rootfs image. On ext4, this is a full byte-by-byte copy (~1.7s). On XFS with reflinks, it's a copy-on-write operation (~1ms). This also benefits VM cloning.

Reflinks only work within the same filesystem, so both the base rootfs images and per-VM copies must live on the same XFS mount.

## Step-by-Step Deployment

### 1. Provision the Server

On AWS:
1. Launch a `.metal` instance (e.g., `c7g.metal` for aarch64, `c6i.metal` for x86_64)
2. Root volume: 40 GB gp3 (ext4, for the OS)
3. **Additional volume: 200+ GB gp3** — this becomes `/data` (XFS)
4. Security group: open ports 22, 80, 443, 2222, 4000–4003

### 2. Change SSH to Port 2222

Port 22 is reserved for the VM SSH proxy service. Move the host's SSH to port 2222.

```bash
# Edit sshd config
sudo sed -i 's/^#Port 22/Port 2222/' /etc/ssh/sshd_config

# Ubuntu 24.04 uses socket activation which overrides sshd_config.
# You MUST also update the socket unit:
sudo sed -i 's/ListenStream=22/ListenStream=2222/' /lib/systemd/system/ssh.socket
sudo systemctl daemon-reload
sudo systemctl restart ssh.socket ssh.service

# Verify
sudo ss -tlnp | grep ssh   # should show 2222
```

> **Important**: Update your local `~/.ssh/config` to use `Port 2222` before disconnecting, or you'll lock yourself out.

### 3. Format the Data Volume as XFS

Find the data volume (the unformatted one):

```bash
lsblk
# Look for the unformatted disk, e.g., nvme1n1 (no partitions, no mountpoint)
```

Format and mount:

```bash
sudo mkfs.xfs -m reflink=1 /dev/nvme1n1
sudo mkdir -p /data
sudo mount /dev/nvme1n1 /data

# Persist across reboots
echo '/dev/nvme1n1 /data xfs defaults 0 0' | sudo tee -a /etc/fstab

# Verify
df -hT /data              # should show xfs
xfs_info /data | grep reflink  # should show reflink=1
```

### 4. Install System Dependencies

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# tsx (TypeScript runner)
sudo npm install -g tsx

# Build tools (required for node-pty native module)
sudo apt-get install -y build-essential python3

# Caddy (reverse proxy)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

### 5. Set Up Firecracker (Host Setup)

```bash
git clone https://github.com/bilalba/numaVM.git
cd numaVM/oss
sudo bash infra/setup-host.sh
```

This installs:
- Firecracker + jailer binaries (v1.14.2) to `/opt/firecracker/bin/`
- Linux kernel for VMs to `/opt/firecracker/kernel/vmlinux`
- Bridge interface `br0` at `172.16.0.1/16` with NAT
- TAP and DNAT helper scripts
- Data directory at `/data/envs`

### 6. Build the VM Rootfs

Build the rootfs into `/data/rootfs/` so it's on the same XFS filesystem as VM copies (required for reflinks):

```bash
sudo mkdir -p /data/rootfs
cd vm && sudo bash build-rootfs.sh --distro alpine --output-dir /data/rootfs
```

This creates a ~2 GB Alpine Linux ext4 image with Node.js, SSH, git, tmux, and agent CLIs (Codex, Claude Code, OpenCode) pre-installed. Takes 2–5 minutes.

Verify reflinks work:

```bash
sudo time cp --reflink=always /data/rootfs/alpine-v1.ext4 /data/test-reflink.ext4
# Should complete in <0.1s. If it takes seconds, reflinks aren't working.
sudo rm /data/test-reflink.ext4
```

### 7. Install npm Dependencies

```bash
cd /path/to/numaVM/oss
npm install

# Also install commercial dependencies (if using commercial layer)
cd /path/to/numaVM/commercial
npm install
```

### 8. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Required
JWT_SECRET=$(openssl rand -hex 32)   # Generate a random secret
BASE_DOMAIN=yourdomain.com
DATA_DIR=/data/envs
DEV_MODE=false                        # Set to true if not using OAuth
SECURE_COOKIES=true
AUTH_ORIGIN=https://auth.yourdomain.com

# Firecracker — point to XFS rootfs location
FC_ROOTFS_DIR=/data/rootfs            # NOT FC_ROOTFS (legacy, bypasses XFS optimization)

# Auth (at minimum, set up GitHub OAuth)
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# Optional
GH_PAT=ghp_...                       # For auto-creating repos
OPENAI_API_KEY=sk-...                 # For Codex in VMs
ANTHROPIC_API_KEY=sk-ant-...          # For Claude Code in VMs

# Stripe (only if using commercial layer)
STRIPE_SECRET_KEY=sk_...
STRIPE_PUBLISHABLE_KEY=pk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_BASE_PRICE_ID=price_...
```

> **Important**: Use `FC_ROOTFS_DIR=/data/rootfs` (directory), not the legacy `FC_ROOTFS` (single file path). The legacy var takes precedence and bypasses the XFS reflink optimization.

### 9. Set Up TLS Certificates

If using **Cloudflare proxy** (recommended), create a Cloudflare Origin Certificate:

1. Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate
2. Save the certificate and private key:

```bash
sudo mkdir -p /etc/caddy/ssl
sudo nano /etc/caddy/ssl/yourdomain.com.pem   # Paste certificate
sudo nano /etc/caddy/ssl/yourdomain.com.key   # Paste private key
sudo chmod 600 /etc/caddy/ssl/*.key
```

The control plane dynamically loads Caddy config via its admin API, referencing these cert files.

If **not using Cloudflare**, Caddy will auto-provision Let's Encrypt certificates (requires ports 80/443 open and DNS pointing to the server).

### 10. Configure Caddy

Copy the minimal Caddyfile that enables the admin API (the control plane loads the full config dynamically):

```bash
sudo cp /path/to/numaVM/oss/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

### 11. Deploy and Start Services

Using the deploy script (from your local machine):

```bash
cd commercial    # or oss/ for standalone
./deploy.sh --install-services
```

This:
1. Builds the dashboard and admin SPAs
2. Rsyncs code to the server
3. Runs `npm install` on the server
4. Installs and starts systemd services

Or manually on the server:

```bash
# Install systemd units
sudo cp infra/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable numavm-auth numavm-control-plane numavm-dashboard numavm-admin
sudo systemctl start numavm-auth
sudo systemctl start numavm-control-plane
sudo systemctl start numavm-dashboard
sudo systemctl start numavm-admin
```

### 12. Configure DNS

Point these DNS records at your server's IP:

| Record | Type | Value |
|---|---|---|
| `yourdomain.com` | A | `<server-ip>` |
| `*.yourdomain.com` | A | `<server-ip>` |

If using Cloudflare, enable the proxy (orange cloud) for DDoS protection and caching.

Specific subdomains used:
- `auth.yourdomain.com` → auth service
- `api.yourdomain.com` → control plane API
- `app.yourdomain.com` → dashboard
- `admin.yourdomain.com` → admin dashboard
- `vm-XXXXXX.yourdomain.com` → per-VM subdomains (dynamically created)

### 13. Verify

```bash
# Check all services are running
sudo systemctl status numavm-auth numavm-control-plane numavm-dashboard numavm-admin

# Health checks
curl -sf http://localhost:4000/health | jq .
curl -sf http://localhost:4001/health | jq .

# Verify Caddy loaded the dynamic config
sudo journalctl -u caddy --no-pager -n 10

# Test reflinks work for VM creation
sudo time cp --reflink=always /data/rootfs/alpine-v1.ext4 /data/envs/test.ext4
sudo rm /data/envs/test.ext4
```

---

## Ongoing Deployments

After the initial setup, use the deploy script for updates:

```bash
./deploy.sh                    # Full deploy (build + sync + restart all)
./deploy.sh --skip-build       # Skip dashboard/admin build
./deploy.sh --cp-only          # Only restart control plane
./deploy.sh --auth-only        # Only restart auth
./deploy.sh --dashboard-only   # Only restart dashboard
./deploy.sh --admin-only       # Only restart admin
```

---

## Architecture on Disk

```
Server
├── /opt/firecracker/
│   ├── bin/firecracker          # Firecracker binary
│   ├── bin/jailer               # Jailer binary
│   ├── bin/{create,destroy}-tap # TAP device helpers
│   ├── bin/{add,remove}-dnat    # DNAT helpers
│   └── kernel/vmlinux           # Linux kernel for VMs
├── /data/                       # XFS volume (reflink=1)
│   ├── rootfs/                  # Base rootfs images
│   │   ├── alpine-v1.ext4      # Alpine base image (~2 GB)
│   │   ├── alpine.ext4 → alpine-v1.ext4
│   │   ├── base.ext4 → alpine.ext4
│   │   └── manifest.json
│   └── envs/                    # Per-VM data directories
│       ├── vm-abc123/
│       │   ├── rootfs.ext4      # Reflink copy of base image
│       │   ├── firecracker.log
│       │   └── ...
│       └── .ssh/
│           └── numavm_internal  # Internal SSH keypair
├── /home/ubuntu/numavm/
│   ├── oss/                     # OSS platform code
│   │   ├── platform.db          # SQLite database
│   │   ├── .env                 # Environment config
│   │   └── node_modules/
│   └── commercial/              # Commercial layer (optional)
│       └── node_modules/
└── /etc/caddy/
    ├── Caddyfile                # Minimal config (admin API only)
    └── ssl/
        ├── yourdomain.com.pem   # Origin certificate
        └── yourdomain.com.key   # Private key
```

## Systemd Services

| Service | Port | Runs As | Description |
|---|---|---|---|
| `numavm-auth` | 4000 | root | Auth service (OAuth, JWT, sessions) |
| `numavm-control-plane` | 4001 | root | Control plane (VM CRUD, agents, files) |
| `numavm-dashboard` | 4002 | ubuntu | Dashboard SPA (static file server) |
| `numavm-admin` | 4003 | ubuntu | Admin dashboard SPA |
| `caddy` | 80, 443 | caddy | Reverse proxy (TLS, forward_auth) |

The control plane runs as root because it creates TAP devices, iptables DNAT rules, and spawns Firecracker processes.

Logs: `sudo journalctl -u numavm-control-plane -f`

## AWS Security Group

Open these inbound ports:

| Port | Purpose |
|---|---|
| 2222 | Host SSH (moved from 22) |
| 22 | VM SSH proxy (control plane listens here) |
| 80, 443 | Caddy (HTTP/HTTPS) |
| 4000–4003 | Services (only needed if accessing directly, not through Caddy) |

## Troubleshooting

### SSH port change doesn't take effect (Ubuntu 24.04)

Ubuntu 24.04 uses `ssh.socket` (systemd socket activation) which overrides `sshd_config`. You must update both:

```bash
sudo sed -i 's/ListenStream=22/ListenStream=2222/' /lib/systemd/system/ssh.socket
sudo systemctl daemon-reload
sudo systemctl restart ssh.socket ssh.service
```

### node-pty fails to install

`npm install` fails with `not found: make`. Install build tools:

```bash
sudo apt-get install -y build-essential python3
```

### Caddy reports "no such file or directory" for SSL cert

The control plane's dynamic Caddy config expects TLS certificates at `/etc/caddy/ssl/<domain>.pem` and `.key`. Create a Cloudflare Origin Certificate or use Let's Encrypt (remove the `tls` directive in `caddy.ts` to let Caddy auto-provision).

### Reflink copy fails with "Invalid cross-device link"

Source and destination must be on the same filesystem. Ensure both `/data/rootfs/` (base images) and `/data/envs/` (VM copies) are on the XFS volume. If you're testing with `cp --reflink=always` to `/tmp`, it will fail because `/tmp` is on the root ext4 filesystem.

### VM rootfs copy is slow (~1.7s instead of ~1ms)

1. Check the filesystem: `df -hT /data` should show `xfs`
2. Check reflinks: `xfs_info /data | grep reflink` should show `reflink=1`
3. Check env: `.env` should have `FC_ROOTFS_DIR=/data/rootfs` (not `FC_ROOTFS`)
4. The legacy `FC_ROOTFS` env var takes precedence — remove it if present

### Control plane can't bind port 22

The SSH proxy needs port 22. If the host's sshd is still on port 22, move it to 2222 (see step 2).

### Bridge br0 not persisted after reboot

The `setup-host.sh` script creates a `numavm-bridge.service` that recreates the bridge on boot. Verify it's enabled:

```bash
sudo systemctl is-enabled numavm-bridge.service
```

NAT/iptables rules also need to be persisted. Install `iptables-persistent`:

```bash
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```
