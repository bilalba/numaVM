# NumaVM

Open-source remote agent workbench. Spin up Firecracker microVMs with persistent storage, GitHub-backed repos, web terminals, and the ability to drive **Codex**, **Claude Code**, and **OpenCode** from a browser.

```
┌─────────────────────────────────────────────────────────────┐
│  Caddy (reverse proxy, wildcard TLS, forward_auth)          │
├──────────┬──────────┬───────────┬───────────┬───────────────┤
│ Auth     │ Control  │ Dashboard │ Admin     │ CLI           │
│ :4000    │ Plane    │ :4002     │ :4003     │               │
│ OAuth    │ :4001    │ React SPA │ React SPA │ SSH + API     │
│ JWT      │ VM CRUD  │ Terminal  │ Users     │               │
│ Sessions │ Agents   │ Agents    │ VMs       │               │
│          │ Files    │ Files     │ Traffic   │               │
├──────────┴──────────┴───────────┴───────────┴───────────────┤
│  Firecracker microVMs (Alpine Linux, SSH, agents)           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                       │
│  │ vm-abc  │ │ vm-def  │ │ vm-ghi  │  ...                  │
│  │ Codex   │ │ Claude  │ │ OpenCode│                       │
│  │ SSH/PTY │ │ Code    │ │         │                       │
│  └─────────┘ └─────────┘ └─────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

## What it does

- **Firecracker microVMs** — each workspace is an isolated Alpine Linux VM with sub-second cold start
- **Agent integration** — run Codex, Claude Code, or OpenCode inside VMs and chat with them from the dashboard
- **Web terminal** — full terminal access in the browser via xterm.js + node-pty over SSH
- **File browser** — browse files, view git history, read/download files from VMs
- **GitHub-backed** — each VM clones a GitHub repo (auto-created or bring your own)
- **Idle shutdown** — VMs snapshot to disk after inactivity, restore on next request
- **Auth-gated access** — per-VM subdomains behind OAuth with role-based sharing (owner/editor/viewer)
- **Admin dashboard** — platform-wide observability: users, VMs, agent sessions, network traffic

---

## Self-hosting guide

NumaVM runs on a single bare-metal Linux machine. A 64GB server can comfortably run 50+ microVMs.

### Requirements

| Requirement | Why |
|---|---|
| **Linux with `/dev/kvm`** | Firecracker needs hardware virtualization. Bare-metal, or EC2 `.metal` / `.bare` instances. |
| **Root access** | Control plane creates TAP devices, iptables rules, and spawns Firecracker processes. |
| **Node.js 22+** | Runtime for all services. |
| **4+ cores, 8+ GB RAM** | Minimum for the platform itself + a few VMs. Each VM uses 256–1536 MiB. |

> **macOS/Windows**: You can develop the web services locally, but VMs require a Linux host with KVM. Use a cloud instance for full testing.

### Step 1: Host setup

Clone the repo and run the host setup script. This downloads Firecracker, creates a bridge network, and configures NAT.

```bash
git clone https://github.com/bilalba/numaVM.git
cd numaVM
sudo bash infra/setup-host.sh
```

This installs:
- Firecracker + jailer binaries (v1.14.2) to `/opt/firecracker/bin/`
- A Linux kernel for VMs to `/opt/firecracker/kernel/vmlinux`
- Bridge interface `br0` at `172.16.0.1/16` with NAT
- TAP and DNAT helper scripts

> **Kernel note**: The setup script's primary kernel URL may 404. If so, manually download a 6.1 kernel:
> ```bash
> sudo curl -fsSL \
>   'https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.9/aarch64/vmlinux-6.1.102' \
>   -o /opt/firecracker/kernel/vmlinux
> ```
> Replace `aarch64` with `x86_64` for Intel/AMD hosts.

### Step 2: Build the VM rootfs

```bash
cd vm && sudo bash build-rootfs.sh
```

This creates a ~1GB Alpine Linux ext4 image at `/opt/firecracker/rootfs/base.ext4` with Node.js, SSH, git, tmux, and the agent CLIs (Codex, Claude Code, OpenCode) pre-installed. Takes 2–3 minutes.

### Step 3: Install dependencies

```bash
cd /path/to/numaVM
npm install

# Node 24+ only — rebuild node-pty from source
npx node-gyp rebuild --directory=node_modules/node-pty
```

### Step 4: Configure environment

```bash
cp .env.example .env
```

**Minimal `.env` for self-hosting** (everything works with just these):

```bash
# Generate with: openssl rand -hex 32
JWT_SECRET=your-random-secret-here

# Skip OAuth — uses a local dev-user identity
DEV_MODE=true

# Where VM data lives
DATA_DIR=/data/envs

# Your email — grants admin access to the admin dashboard
ADMIN_EMAIL=you@example.com
```

That's it for a working setup. No OAuth apps, no Stripe, no Resend, no Caddy needed.

**Optional: add features incrementally:**

```bash
# --- GitHub integration (for auto-creating repos per VM) ---
GH_PAT=ghp_...                          # Personal access token with repo scope

# --- GitHub OAuth login ---
GITHUB_CLIENT_ID=...                     # Create at github.com/settings/developers
GITHUB_CLIENT_SECRET=...                 # Callback URL: https://auth.yourdomain.com/auth/github/callback

# --- Google OAuth login ---
GOOGLE_CLIENT_ID=...                     # Create at console.cloud.google.com
GOOGLE_CLIENT_SECRET=...

# --- Email magic link login (via Resend) ---
RESEND_API_KEY=re_...                    # From resend.com — optional
EMAIL_FROM=YourApp <noreply@yourdomain>  # Sender address

# Without RESEND_API_KEY, magic links print to the auth service console instead
# of being emailed. This works fine for single-user / dev setups.

# --- Agent API keys (passed into VMs) ---
OPENAI_API_KEY=sk-...                    # For Codex
ANTHROPIC_API_KEY=sk-ant-...             # For Claude Code

# --- Stripe billing ---
STRIPE_SECRET_KEY=sk_...                 # Only needed for multi-user SaaS
STRIPE_PUBLISHABLE_KEY=pk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_BASE_PRICE_ID=price_...

# --- Domain + Caddy (for public access with TLS) ---
BASE_DOMAIN=yourdomain.com               # Enables subdomain routing per VM
CADDY_ADMIN_URL=http://localhost:2019
```

### Step 5: Start services

```bash
# Auth service (runs as regular user)
npx tsx auth/server.ts &

# Control plane (must run as root for TAP/iptables/Firecracker)
sudo -E npx tsx control-plane/server.ts &

# Dashboard (development)
cd dashboard && npm run dev &

# Admin panel (development)
cd admin && npm run dev &
```

Open `http://localhost:4002` — you're in.

### Step 6: Create your first VM

From the dashboard, click **Deploy** and provide a name. If `GH_PAT` is set, a GitHub repo is auto-created. Otherwise, provide an existing `owner/repo`.

Or via the API:
```bash
curl -X POST http://localhost:4001/vms \
  -H "Content-Type: application/json" \
  -d '{"name": "my-workspace", "gh_repo": "you/your-repo"}'
```

---

## Deployment tiers

| Tier | Auth | What to configure | Good for |
|---|---|---|---|
| **Local dev** | None (DEV_MODE) | `JWT_SECRET`, `DEV_MODE=true` | Trying it out, development |
| **Single user** | GitHub OAuth | + `GITHUB_CLIENT_ID/SECRET` | Personal server |
| **Small team** | GitHub + Google OAuth | + Google OAuth + `ADMIN_EMAIL` | Private team use |
| **Public SaaS** | Full OAuth + Caddy + Stripe | All env vars + domain + TLS | Hosting for others |

### Auth without third-party services

With `DEV_MODE=true`, no external auth services are needed. The control plane auto-creates a `dev-user` identity. This is the fastest path to a working setup.

When you add GitHub OAuth (just a Client ID + Secret from [github.com/settings/developers](https://github.com/settings/developers)), users can log in with their GitHub accounts. No email service needed.

Email magic links work without Resend too — when `RESEND_API_KEY` is not set, the magic link URL is printed to the auth service console. You copy it from the logs and open it in your browser. Not production-grade, but works for single-user setups.

---

## Production deployment

For the full step-by-step guide, see **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

Quick summary for a fresh Ubuntu 24.04 server:

```bash
# 1. Move host SSH to port 2222 (port 22 is for VM SSH proxy)
sudo sed -i 's/^#Port 22/Port 2222/' /etc/ssh/sshd_config
sudo sed -i 's/ListenStream=22/ListenStream=2222/' /lib/systemd/system/ssh.socket
sudo systemctl daemon-reload && sudo systemctl restart ssh.socket ssh.service

# 2. Format data volume as XFS with reflinks (makes VM creation ~1700x faster)
sudo mkfs.xfs -m reflink=1 /dev/<your-data-disk>
sudo mkdir -p /data && sudo mount /dev/<your-data-disk> /data
echo '/dev/<your-data-disk> /data xfs defaults 0 0' | sudo tee -a /etc/fstab

# 3. Install Node.js 22, tsx, Caddy, build tools
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3 caddy
sudo npm install -g tsx

# 4. Set up Firecracker (bridge, NAT, binaries, kernel)
sudo bash infra/setup-host.sh

# 5. Build rootfs on XFS (so reflinks work for VM copies)
sudo mkdir -p /data/rootfs
sudo bash vm/build-rootfs.sh --distro alpine --output-dir /data/rootfs

# 6. Configure .env (set FC_ROOTFS_DIR=/data/rootfs, not FC_ROOTFS)
cp .env.example .env && vim .env

# 7. Deploy
npm install
./deploy.sh --install-services

# 8. DNS: point *.yourdomain.com at the server
```

**Key architecture detail**: The data volume must be XFS with `reflink=1`. Both base rootfs images (`/data/rootfs/`) and per-VM copies (`/data/envs/`) live on this volume. When the control plane runs `cp --reflink=auto` to create a VM, XFS does a copy-on-write (~1ms) instead of a full 2–4 GB copy (~1.7s).

The control plane dynamically configures Caddy via its admin API — each VM gets a subdomain like `vm-abc123.yourdomain.com` with auth gating via Caddy's `forward_auth`.

---

## Project structure

```
numavm/
├── auth/              # Fastify service — GitHub/Google OAuth, email magic links, JWT sessions
├── control-plane/     # Fastify service — VM CRUD, Firecracker, agent bridges, billing, files
├── dashboard/         # React SPA — user-facing UI (terminal, agents, files, settings)
├── admin/             # React SPA — admin dashboard (users, VMs, sessions, events, traffic)
├── cli/               # CLI tool — `numavm` command for VM management + SSH
├── vm/                # VM image — build-rootfs.sh + init.sh (PID 1 inside VMs)
├── infra/             # Host setup — setup-host.sh, systemd units, firecracker.conf
├── docker/            # Dockerfile for VM base image (alternative to rootfs build)
└── docs/              # Additional documentation
```

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** — Full architecture reference: API endpoints, database schema, agent integration, conventions
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** — Production deployment guide (EC2, systemd, Caddy, deploy.sh)
- **[docs/admin-dashboard.md](./docs/admin-dashboard.md)** — Admin dashboard features and API

## Tech stack

| | |
|---|---|
| **Runtime** | Node.js 22+, TypeScript, ESM |
| **API** | Fastify 5 |
| **Auth** | [arctic](https://github.com/pilcrowOnPaper/arctic) (OAuth), [jose](https://github.com/panva/jose) (JWT) |
| **Database** | SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL mode) |
| **Frontend** | React 19, Vite, Tailwind CSS, xterm.js |
| **Isolation** | [Firecracker](https://github.com/firecracker-microvm/firecracker) microVMs |
| **Proxy** | [Caddy](https://caddyserver.com) (optional for dev, required for production TLS) |
| **Billing** | Stripe (optional) |

## License

[Apache License 2.0](./LICENSE)
