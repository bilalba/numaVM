# NumaVM

Remote Agent Workbench — a platform where each VM is a Firecracker microVM with persistent storage, a GitHub-backed repo, a public subdomain (gated by OAuth), idle shutdown via snapshots, and the ability to drive Codex, Claude Code, and OpenCode from a web dashboard.

## Architecture

See `PLATFORM_PLAN.md` for the full architecture document.

**Key components:**
- **Auth Service** (`auth/`) — Port 4000. Fastify + GitHub/Google OAuth + email magic links + JWT sessions
- **Control Plane** (`control-plane/`) — Port 4001. VM CRUD, Firecracker orchestration, Caddy route management, Stripe billing, agent bridges
- **Dashboard** (`dashboard/`) — Port 4002. React SPA with agent chat UI, terminal, file browser, settings
- **Admin Dashboard** (`admin/`) — Port 4003. React SPA for platform observability (users, VMs, sessions, events, traffic). See `docs/admin-dashboard.md`
- **CLI** (`cli/`) — Command-line tool for VM management and SSH access
- **Caddy** — Reverse proxy with wildcard TLS, `forward_auth` to auth service
- **VMs** (`vm/`) — Alpine Linux Firecracker microVMs with Node.js, SSH (TCP over bridge network), Codex, Claude Code, OpenCode
- **Idle Shutdown** — VMs are snapshotted after 2min of no network activity (configurable), restored sub-second on next request

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript, ESM modules
- **Framework**: Fastify 5
- **Auth**: `arctic` (OAuth), `jose` (JWT), `better-sqlite3`
- **Isolation**: Firecracker microVMs with TCP SSH over bridge network for host↔guest exec
- **GitHub**: `octokit` for repo creation and API access
- **Billing**: Stripe Checkout + Customer Portal
- **Dev**: `tsx` for TypeScript execution
- **Database**: SQLite (`platform.db` at project root, shared between auth and control-plane)

## Project Structure

```
numavm/
├── auth/                # Auth service (port 4000)
│   ├── server.ts        # Fastify entry point
│   ├── session.ts       # JWT sign/verify, cookie helpers
│   ├── verify.ts        # Caddy forward_auth endpoint
│   ├── oauth/           # GitHub, Google, email magic link routes
│   ├── db/              # SQLite schema + query helpers
│   └── views/           # Login page HTML
├── control-plane/       # Control plane API (port 4001)
│   ├── server.ts        # Fastify entry, WebSocket, CORS, auth hooks
│   ├── routes/
│   │   ├── vms.ts       # VM CRUD, pause, clone, status page
│   │   ├── access.ts    # Grant/revoke VM access
│   │   ├── terminal.ts  # WebSocket terminal route
│   │   ├── claude.ts    # Claude Code session listing
│   │   ├── agents.ts    # Agent session CRUD, messaging, WebSocket hub
│   │   ├── files.ts     # File browser + git log
│   │   ├── user.ts      # /me endpoints, SSH keys, GitHub repos
│   │   ├── billing.ts   # Stripe checkout, portal, webhooks
│   │   └── admin.ts     # Admin API routes
│   ├── agents/
│   │   ├── types.ts     # AgentEvent, AgentCommand, AgentBridge interface
│   │   ├── codex-bridge.ts   # Codex JSON-RPC over stdio bridge
│   │   ├── opencode-bridge.ts # OpenCode HTTP+SSE bridge
│   │   ├── ws-hub.ts    # Per-VM WebSocket broadcast hub
│   │   └── manager.ts   # Agent manager (coordinator)
│   ├── terminal/
│   │   └── pty-handler.ts  # node-pty lifecycle over SSH
│   ├── services/
│   │   ├── firecracker.ts  # Firecracker VM lifecycle (create, stop, snapshot, restore)
│   │   ├── ssh-proxy.ts    # SSH proxy for CLI access
│   │   ├── idle-monitor.ts # TAP traffic monitoring + auto-snapshot
│   │   ├── wake.ts         # Restore snapshotted VMs on demand (quota-aware)
│   │   ├── caddy.ts        # Caddy admin API route management
│   │   ├── health.ts       # Health check stats
│   │   └── docker.ts       # Container utilities
│   ├── ssh-api/         # SSH TUI interface
│   │   ├── dispatcher.ts
│   │   ├── tui.ts
│   │   └── commands/
│   │       ├── vms.ts   # VM management commands
│   │       └── meta.ts  # help, version, etc.
│   └── db/              # vms + agent_sessions + agent_messages + admin_events tables
├── dashboard/           # React SPA (port 4002)
│   ├── src/
│   │   ├── pages/       # VMList, VMDetail, Deploy, Plan, Settings, LinkSshKey
│   │   ├── components/  # TerminalTab, ClaudeCodeTab, AgentTab, FilesTab, AccessPanel, SshKeysPanel
│   │   ├── hooks/       # useTerminal, useAgentSocket
│   │   └── lib/         # api client, time helpers
│   ├── index.html
│   └── vite.config.ts
├── admin/               # Admin dashboard SPA (port 4003)
│   ├── src/
│   │   ├── pages/       # Overview, Users, VMs, Sessions, Events, Traffic
│   │   ├── components/  # Header, Sidebar, StatsCard, DataTable, Toast
│   │   └── lib/         # admin api client, time helpers
│   ├── index.html
│   └── vite.config.ts
├── cli/                 # CLI tool
│   └── src/
│       ├── index.ts     # Entry point
│       └── commands/    # auth, vms, ssh, status
├── vm/                  # Firecracker VM rootfs + init
│   ├── build-rootfs.sh  # Builds Alpine ext4 base image
│   └── init.sh          # VM PID 1 init script
├── infra/               # Host setup + deploy infrastructure
│   ├── setup-host.sh    # One-time host provisioning
│   ├── firecracker.conf # Path config for Firecracker binaries + kernel
│   └── systemd/         # systemd unit files for production services
├── deploy.sh            # One-command deploy script
├── .rsyncignore         # Rsync exclude list (protects SQLite WAL, .env, node_modules)
├── Caddyfile            # Reverse proxy config
└── platform.db          # SQLite database (auto-created)
```

## Production Deployment

**Deploy script**: `./deploy.sh` is the single entry point for all deploys. It writes `version.json` (git hash + timestamp), builds the dashboard, rsyncs (using `.rsyncignore` to protect SQLite WAL files and `.env`), runs `npm install` on the server, restarts services via systemd, and runs smoke tests.

```bash
./deploy.sh                    # Full deploy (build + sync + restart all)
./deploy.sh --skip-build       # Skip dashboard + admin build
./deploy.sh --dashboard-only   # Only restart dashboard
./deploy.sh --admin-only       # Only restart admin dashboard
./deploy.sh --auth-only        # Only restart auth
./deploy.sh --cp-only          # Only restart control plane
./deploy.sh --install-services # One-time: install systemd units
```

**Services** are managed via systemd: `numavm-auth`, `numavm-control-plane`, `numavm-dashboard`, `numavm-admin`. Unit files in `infra/systemd/`. All services auto-restart on failure (`RestartSec=5`). Logs via `journalctl -u numavm-auth` etc.

**Version tracking**: Both auth and control plane read `version.json` at startup and include it in their `/health` endpoint responses.

See `DEPLOYMENT.md` for the full deployment guide. See `INTERNAL.md` (gitignored) for operational runbook.

**Quick reference**: The control plane must run as **root** (needs TAP/iptables). Set `DEV_MODE=true` in `.env` to bypass OAuth when running without Caddy.

## Development

```bash
npm install
npx node-gyp rebuild --directory=node_modules/node-pty  # Required for Node 24+

# Start services (each in its own terminal)
cd auth && npm run dev
cd control-plane && npm run dev
cd dashboard && npm run dev
cd admin && npm run dev
```

**Environment variables**: Copy `.env.example` to `.env` and fill in values. Both services load the root `.env` via `dotenv`.

### Local dev setup (without Caddy)

- Dashboard: `http://localhost:4002` — set `VITE_API_URL=//localhost:4001` in `dashboard/.env`
- Admin: `http://localhost:4003` — set `VITE_API_URL=//localhost:4001` in `admin/.env`. Requires `is_admin=1` on user
- Control plane: `http://localhost:4001` — auto-allows CORS from `localhost:4002` and `localhost:4003` when `BASE_DOMAIN=localhost`
- Auth bypass: When `BASE_DOMAIN=localhost`, the control plane skips Caddy `forward_auth` and uses a fake `dev-user` identity
- Firecracker: Requires bare-metal Linux with /dev/kvm. Set `DATA_DIR` in `.env`. Dev on macOS requires a Linux VM
- GitHub: Set `GH_PAT` for auto-creating repos, or provide an existing `owner/repo` when creating VMs

### Known dev issues

- **node-pty prebuilds don't work with Node 24+**: Must rebuild from source via `npx node-gyp rebuild --directory=node_modules/node-pty`
- **ESM import hoisting**: Module-level `process.env` reads happen before `dotenv` loads. Use lazy reads (functions instead of `const`). See `control-plane/services/firecracker.ts` for the pattern.
- **React StrictMode double-mount**: Terminal and WebSocket hooks must handle cleanup carefully. The `useTerminal` hook creates/destroys everything in a single effect.
- **Control plane needs root on production**: TAP devices, iptables DNAT, and Firecracker process spawning all require root. Use `sudo -E` to preserve env vars.
- **DEV_MODE=true for non-Caddy deployments**: When running without Caddy's `forward_auth`, set `DEV_MODE=true` in `.env` to use the dev-user auth bypass.
- **OpenSSH 10+ rejects locked accounts**: Alpine's `adduser -D` creates accounts with `!` in `/etc/shadow` (locked). Fixed in `init.sh` and `build-rootfs.sh` by changing `!` to `*`.
- **Caddy admin API requires Origin header**: Node.js `fetch` doesn't send `Origin`. The `caddy.ts` service adds it to all requests.
- **Host needs `vhost_vsock` kernel module**: `sudo modprobe vhost_vsock`. Persisted via `/etc/modules-load.d/vhost-vsock.conf`.

## Conventions

- Use ESM (`import`/`export`), not CommonJS
- Use `.js` extensions in TypeScript imports (NodeNext resolution)
- Fastify route handlers are organized in separate files and registered via `register*Routes(app)` functions
- Database queries use prepared statements via `better-sqlite3`
- OAuth state is stored in short-lived httpOnly cookies
- Session JWT is stored in `__session` cookie scoped to the base domain
- Control plane reads `X-User-Id` and `X-User-Email` headers injected by Caddy's `forward_auth`
- Both services share `platform.db` (SQLite WAL mode supports concurrent access)
- Each service owns its own tables (auth: `users`, `sessions`, `vm_access`; control-plane: `vms`, `agent_sessions`, `agent_messages`, `admin_events`, `vm_traffic`) but may read across
- VM slug format: `vm-XXXXXX` (6 random alphanumeric chars)
- `DATA_DIR` env var controls VM data storage (default: `/data/envs` on production)

## Control Plane API Endpoints

```
GET    /health                           Health check + version

# VM management
POST   /vms                              Create VM (name, optional gh_repo, mem_size_mib)
GET    /vms                              List user's VMs
GET    /vms/quota                        RAM quota (used/max/plan/valid_mem_sizes)
GET    /vms/:id                          VM details (auto-wakes snapshotted VMs)
DELETE /vms/:id                          Destroy VM + cleanup data dir (owner only)
POST   /vms/:id/pause                    Snapshot/pause VM
POST   /vms/:id/clone                    Clone VM (copy disk, start new)
GET    /vms/:id/status-page              Caddy fallback HTML (triggers wake)
GET    /vms/:id/ssh-keys-status          Check if SSH keys synced to VM
POST   /vms/:id/sync-ssh-keys            Sync SSH keys to running VM

# Access control
POST   /vms/:id/access                   Grant/revoke access (owner only)
GET    /vms/:id/access                   List users with access

# Terminal
GET    /vms/:id/terminal                 WebSocket terminal (?session=<name>, ?cols=, ?rows=)
GET    /vms/:id/terminal/sessions        List tmux sessions
DELETE /vms/:id/terminal/sessions/:name  Kill tmux session

# Claude Code
GET    /vms/:id/claude/sessions          List Claude Code sessions from VM

# Agent sessions (Codex + OpenCode)
POST   /vms/:id/agents/:type/sessions    Start agent session
GET    /vms/:id/agents/:type/sessions    List sessions by type
GET    /vms/:id/sessions/:sid            Get session + message history
POST   /vms/:id/sessions/:sid/message    Send message (with effort/approvalPolicy/sandboxPolicy)
POST   /vms/:id/sessions/:sid/stop       Interrupt agent
POST   /vms/:id/sessions/:sid/approval   Respond to approval
POST   /vms/:id/sessions/:sid/revert     Revert file changes (OpenCode)
POST   /vms/:id/sessions/:sid/unrevert   Restore reverted changes (OpenCode)
DELETE /vms/:id/sessions/:sid            Archive session
GET    /vms/:id/ws                       WebSocket for agent event streaming

# Agent auth + config
GET    /vms/:id/codex/auth/status        Check Codex auth (?refresh=true)
POST   /vms/:id/codex/auth/login         Start Codex login (apikey or chatgpt device code)
POST   /vms/:id/codex/auth/logout        Logout from Codex
GET    /vms/:id/codex/models             List Codex models
GET    /vms/:id/codex/threads            List Codex threads
GET    /vms/:id/opencode/providers       List OpenCode providers + models

# Files
GET    /vms/:id/files                    List files (?path=)
GET    /vms/:id/files/read               Read file content (?path=)
GET    /vms/:id/files/download           Download file (?path=)
GET    /vms/:id/git/log                  Git commit log (?limit=)

# User
GET    /me                               Current user info
GET    /me/ssh-keys                      Get SSH keys (custom + GitHub)
PUT    /me/ssh-keys                      Save custom SSH public keys
GET    /me/github                        GitHub connection status
DELETE /me/github                        Disconnect GitHub
GET    /me/repos                         List GitHub repos (?q=, ?page=)
POST   /me/repos                         Create GitHub repo

# SSH key linking (from SSH TUI)
GET    /link-ssh/:token                  Get pending SSH key info
GET    /link-ssh/:token/status           Poll confirmation status
POST   /link-ssh/:token                  Confirm SSH key linking

# Billing (Stripe)
POST   /billing/checkout                 Create Stripe Checkout session
POST   /billing/portal                   Create Stripe Customer Portal session
GET    /billing/subscription             Get subscription status + plan
POST   /billing/webhook                  Stripe webhook handler

# Admin (require is_admin)
GET    /admin/stats                      Overview numbers
GET    /admin/users                      All users with vm_count + provider
GET    /admin/vms                        All VMs with owner info
GET    /admin/vms/:id                    Detailed VM info
GET    /admin/traffic                    Live TAP RX/TX for running VMs
GET    /admin/traffic/summary            Traffic totals per VM (?hours=)
GET    /admin/traffic/:id/history        Time-series traffic for VM (?hours=)
GET    /admin/sessions                   All agent sessions (?limit=)
GET    /admin/events                     Admin events (?limit=, ?type=)
GET    /admin/health                     Extended health + resources
```

## Database Tables

| Table | Owned By | Purpose |
|-------|----------|---------|
| `users` | auth | User accounts. Columns added at runtime: `is_admin`, `plan`, `ssh_public_keys`, `github_token`, `stripe_customer_id`, `trial_started_at` |
| `sessions` | auth | JWT session records (defined but not actively used — JWT is cookie-based) |
| `vm_access` | auth (schema), control-plane (writes) | Role-based access: owner/editor/viewer per VM per user |
| `vms` | control-plane | VM records: id, name, owner_id, ports, vm_ip, vsock_cid, snapshot_path, gh_repo, status, mem_size_mib |
| `agent_sessions` | control-plane | Agent session records: vm_id, agent_type (codex/opencode), thread_id, title, cwd, status |
| `agent_messages` | control-plane | Conversation history: role, content, metadata per session |
| `admin_events` | control-plane | Audit log: VM lifecycle events, agent events, user activity |
| `vm_traffic` | control-plane | Per-VM network traffic deltas recorded every poll cycle, auto-pruned after 7 days |

## Plans + Quotas

- **free**: max 256 MiB total RAM, 1 GiB disk, 1 GB data transfer, valid VM sizes: 256 MiB
- **base**: max 1536 MiB total RAM, valid VM sizes: 256, 512, 768, 1024, 1280, 1536 MiB
- New users get a 3-day **base trial** (`trial_started_at`). After expiry, lazy-downgraded to free.
- Only `running` and `creating` VMs count against RAM quota. Snapshotted VMs are free.
- `QuotaExceededError` thrown by `wake.ts` when restoring would exceed quota. Handled gracefully in all auto-wake routes.
- Stripe integration: `/billing/checkout` → `/billing/portal` → webhook updates `plan` in DB.

## Agent Integration

### Codex Bridge (`control-plane/agents/codex-bridge.ts`)
- JSON-RPC 2.0 over stdio via SSH to `codex app-server` in VM
- Protocol docs: https://developers.openai.com/codex/app-server/
- Lifecycle: `initialize` → `thread/start` → `turn/start` → streaming events → `turn/interrupt`
- Approval handling: server-initiated JSON-RPC requests forwarded to dashboard, user responds, bridge sends response back
- Auth bridge: persistent app-server per VM for `account/read`, `account/login/start`, `account/logout`
- ChatGPT OAuth uses `codex login --device-auth` (app-server OAuth redirect to localhost doesn't work in VMs)

### OpenCode Bridge (`control-plane/agents/opencode-bridge.ts`)
- HTTP REST + SSE to VM's OpenCode server (port 5000, via iptables DNAT)
- Auth: HTTP basic auth (`opencode` / per-VM `OPENCODE_SERVER_PASSWORD`)
- SSE format: data-only (no `event:` lines), event type in `data.type`, payload in `data.properties`
- Message format: `{ parts: [{ type: "text", text }] }`

### Shared Infrastructure
- **WebSocket hub** (`ws-hub.ts`): Per-VM broadcast of normalized agent events to dashboard
- **Agent manager** (`manager.ts`): Coordinates bridges, DB persistence, session lifecycle, auto-titles sessions
- Bridges are in-memory — control plane restart loses active sessions

## VM Creation Flow (POST /vms)

1. Validate body (`name` required, optional `gh_repo`, `mem_size_mib`)
2. Check RAM quota (only running/creating VMs count)
3. Generate slug: `vm-` + 6 random alphanumeric chars
4. Allocate ports + vsock CID + VM IP from DB
5. Create GitHub repo via Octokit (or use provided `gh_repo`). Without `GH_PAT` or `gh_repo`, returns 400.
6. Fetch user's SSH keys (GitHub + custom)
7. Insert VM record (status: `creating`) + grant owner access
8. Background: create + start Firecracker VM (rootfs, TAP, vsock, iptables DNAT)
   - Waits for SSH readiness via TCP to VM bridge IP (up to 30s)
   - On failure: rolls back DB records + deletes data directory
9. Register Caddy route (non-fatal)
10. Update status to `running`

## VM Init Behavior

The init script (`vm/init.sh`, PID 1 via `/sbin/numavm-init`) is fault-tolerant:
- Parses `dm.*` kernel cmdline params for VM config
- Configures networking (eth0 with static IP from kernel cmdline)
- Unlocks `dev` user account (`dev:!:` → `dev:*:` in shadow) for OpenSSH 10+
- TCP sshd on port 22, vsock listener via socat (kept for future use)
- Git clone is best-effort (falls back to empty local repo)
- OpenCode server starts in background
- SSH keys injected from base64-encoded kernel cmdline param (user + internal)
- Graceful shutdown on SIGTERM

## Idle Shutdown + Wake-on-Request

- **Idle Monitor** (`idle-monitor.ts`): Polls TAP traffic every 30s. If < 20KB transferred in 2min (configurable via `IDLE_TIMEOUT_MS`, `IDLE_THRESHOLD_BYTES`), snapshots the VM.
- **Wake Service** (`wake.ts`): `ensureVMRunning(vmId)` restores from snapshot. Called by terminal, agent, file, and VM detail routes. Coalesces concurrent requests. Checks RAM quota before restoring.
- **Status Page**: When a request hits a snapshotted VM via Caddy, triggers wake and auto-refreshes. Shows quota error if applicable.
- **Dashboard**: Shows status badges on VM cards. Pause navigates to list immediately (fire-and-forget API call) to prevent WebSocket/terminal connections from re-waking the VM.

## Future Work / Known Issues

- **Agent bridge resilience**: In-memory bridges lost on restart. Consider reconnecting to existing processes.
- **Snapshot compression**: Memory snapshots are ~`mem_size_mib` each. Consider compression.
- **Jailer integration**: Run Firecracker in chroot/cgroup jail for security hardening.
- **Codex app-server OAuth**: localhost redirect doesn't work in VMs, falls back to CLI device auth.
