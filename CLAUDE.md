# DeployMagi

Remote Agent Workbench — a platform where each environment is a Firecracker microVM with persistent storage, a GitHub-backed repo, a public subdomain (gated by OAuth), idle shutdown via snapshots, and the ability to drive Codex, Claude Code, and OpenCode from a web dashboard.

## Architecture

See `PLATFORM_PLAN.md` for the full architecture document.

**Key components:**
- **Auth Service** (`auth/`) — Port 4000. Fastify + GitHub/Google OAuth + email magic links + JWT sessions
- **Control Plane** (`control-plane/`) — Port 4001. Env CRUD, Firecracker VM orchestration, Caddy route management, GitHub repo creation via Octokit
- **Dashboard** (`dashboard/`) — Port 4002. React SPA with agent chat UI, terminal, auth dialogs
- **Caddy** — Reverse proxy with wildcard TLS, `forward_auth` to auth service
- **Env VMs** (`vm/`) — Alpine Linux Firecracker microVMs with Node.js, SSH (TCP over bridge network), Codex, Claude Code, OpenCode
- **Idle Shutdown** — VMs are snapshotted after 15min of no network activity, restored sub-second on next request

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript, ESM modules
- **Framework**: Fastify 5
- **Auth**: `arctic` (OAuth), `jose` (JWT), `better-sqlite3`
- **Isolation**: Firecracker microVMs with TCP SSH over bridge network for host↔guest exec
- **GitHub**: `octokit` for repo creation and API access
- **Dev**: `tsx` for TypeScript execution
- **Database**: SQLite (`platform.db` at project root, shared between auth and control-plane)

## Project Structure

```
deploymagi/
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
│   │   ├── envs.ts      # Env CRUD + status page
│   │   ├── access.ts    # Grant/revoke env access
│   │   ├── terminal.ts  # WebSocket terminal route
│   │   ├── claude.ts    # Claude Code session listing
│   │   └── agents.ts    # Agent session CRUD, messaging, WebSocket hub
│   ├── agents/
│   │   ├── types.ts     # AgentEvent, AgentCommand, AgentBridge interface
│   │   ├── codex-bridge.ts   # Codex JSON-RPC over stdio bridge
│   │   ├── opencode-bridge.ts # OpenCode HTTP+SSE bridge
│   │   ├── ws-hub.ts    # Per-env WebSocket broadcast hub
│   │   └── manager.ts   # Agent manager (coordinator)
│   ├── terminal/
│   │   └── pty-handler.ts  # node-pty lifecycle management
│   ├── services/
│   │   ├── firecracker.ts  # Firecracker VM lifecycle (create, stop, snapshot, restore)
│   │   ├── vsock-ssh.ts    # SSH exec layer — TCP SSH to VM bridge IP (replaces docker exec)
│   │   ├── idle-monitor.ts # TAP traffic monitoring + auto-snapshot
│   │   ├── wake.ts         # Restore snapshotted VMs on demand
│   │   ├── caddy.ts        # Caddy admin API route management
│   │   ├── github.ts       # Octokit repo creation + SSH key fetch
│   │   ├── health.ts       # Health check stats
│   │   └── port-allocator.ts  # Port + vsock CID + VM IP allocation
│   └── db/              # envs + agent_sessions + agent_messages tables
├── dashboard/           # React SPA (port 4002)
│   ├── src/
│   │   ├── pages/       # EnvList, EnvDetail
│   │   ├── components/  # TerminalTab, ClaudeCodeTab, AgentTab, ChatMessage, ApprovalCard
│   │   ├── hooks/       # useTerminal, useAgentSocket
│   │   └── lib/         # api client, time helpers
│   ├── index.html
│   └── vite.config.ts
├── vm/                  # Firecracker VM rootfs + init
│   ├── build-rootfs.sh  # Builds Alpine ext4 base image
│   └── init.sh          # VM PID 1 init script
├── infra/               # Host setup
│   ├── setup-host.sh    # One-time host provisioning (Firecracker, kernel, bridge, NAT)
│   └── firecracker.conf # Path config for Firecracker binaries + kernel
├── docker/              # [DEPRECATED] Docker-based env container (being removed)
├── Caddyfile            # Reverse proxy config
└── platform.db          # SQLite database (auto-created)
```

## Production Deployment

See `DEPLOYMENT.md` for the full deployment guide including:
- Step-by-step deployment from scratch
- Known issues and fixes (kernel version, OpenSSL, CORS, permissions)
- How to patch the rootfs without full rebuild
- Firecracker kernel download sources

**Quick reference**: The control plane must run as **root** (needs TAP/iptables). Set `DEV_MODE=true` in `.env` to bypass OAuth when running without Caddy.

## Development

```bash
# Install dependencies (all workspaces)
npm install

# Rebuild node-pty native module (required for Node 24+)
npx node-gyp rebuild --directory=node_modules/node-pty

# Build the VM rootfs image (first time only, or after vm/ changes)
# Requires: bare-metal Linux with /dev/kvm
sudo ./infra/setup-host.sh          # one-time host setup
sudo ./vm/build-rootfs.sh           # build Alpine rootfs

# Start auth service (with hot reload)
cd auth && npm run dev

# Start control plane (with hot reload)
cd control-plane && npm run dev

# Start dashboard (with hot reload)
cd dashboard && npm run dev

# Or start without hot reload
cd auth && npm start
cd control-plane && npm start
```

**Environment variables**: Copy `.env.example` to `.env` and fill in values. Both services load the root `.env` via `dotenv`.

### Local dev setup (without Caddy)

The dashboard, control plane, and auth service run on separate ports locally. No Caddy is needed for dev:

- Dashboard: `http://localhost:4002` — set `VITE_API_URL=//localhost:4001` in `dashboard/.env`
- Control plane: `http://localhost:4001` — auto-allows CORS from `localhost:4002` when `BASE_DOMAIN=localhost`
- Auth bypass: When `BASE_DOMAIN=localhost`, the control plane skips Caddy `forward_auth` and uses a fake `dev-user` identity
- Firecracker: Requires bare-metal Linux with /dev/kvm. Set `DATA_DIR` in `.env` to a local path. Dev on macOS requires a Linux VM for Firecracker
- GitHub: Set `GH_PAT` for auto-creating repos, or provide an existing `owner/repo` when creating envs. Without either, env creation will fail gracefully with a clear error message

### Known dev issues

- **node-pty prebuilds don't work with Node 24+**: Must rebuild from source via `npx node-gyp rebuild --directory=node_modules/node-pty`
- **ESM import hoisting**: Module-level `process.env` reads happen before `dotenv` loads. Services that need env vars at import time use lazy reads (functions instead of `const`). See `control-plane/services/firecracker.ts` for the pattern.
- **React StrictMode double-mount**: Terminal and WebSocket hooks must handle cleanup carefully to avoid duplicate connections. The `useTerminal` hook creates/destroys everything in a single effect to prevent this.
- **Firecracker kernel v1.10 missing from S3**: The `setup-host.sh` primary kernel URL returns 404. It falls back to kernel 4.14 which is too old for Alpine 3.21. Must manually download kernel 6.1 from the v1.9 CI path (see `DEPLOYMENT.md`).
- **Control plane needs root on production**: TAP devices, iptables DNAT, and Firecracker process spawning all require root. Use `sudo -E` to preserve env vars.
- **DEV_MODE=true for non-Caddy deployments**: When running without Caddy's `forward_auth`, set `DEV_MODE=true` in `.env` to use the dev-user auth bypass (works with any `BASE_DOMAIN`, not just `localhost`).
- **OpenSSH 10+ rejects locked accounts**: Alpine's `adduser -D` creates accounts with `!` in `/etc/shadow` (locked). OpenSSH 10+ rejects pubkey auth for locked accounts even with `UsePAM no`. Fixed in `init.sh` and `build-rootfs.sh` by changing `!` to `*` in shadow.
- **Firecracker vsock not usable via AF_VSOCK**: Firecracker exposes vsock through a UDS with a custom CONNECT handshake, not the kernel's `AF_VSOCK`. `socat VSOCK-CONNECT` doesn't work. SSH exec uses TCP over the bridge network instead (`vsock-ssh.ts` connects to `vm_ip` directly).
- **Host needs `socat` installed**: Even though we no longer use vsock for SSH exec, socat is still used inside VMs for the vsock listener. Install on host too if you ever need it for debugging: `sudo apt install socat`.
- **Host needs `vhost_vsock` kernel module**: Must be loaded for Firecracker vsock device support: `sudo modprobe vhost_vsock`. Persisted via `/etc/modules-load.d/vhost-vsock.conf`.
- **Caddy admin API requires Origin header**: Node.js `fetch` doesn't send an `Origin` header. Caddy's admin API rejects requests without one. The `caddy.ts` service adds `Origin: ${caddyAdmin}` to all requests.

## Conventions

- Use ESM (`import`/`export`), not CommonJS
- Use `.js` extensions in TypeScript imports (NodeNext resolution)
- Fastify route handlers are organized in separate files and registered via `register*Routes(app)` functions
- Database queries use prepared statements via `better-sqlite3`
- OAuth state is stored in short-lived httpOnly cookies
- Session JWT is stored in `__session` cookie scoped to the base domain
- Control plane reads `X-User-Id` and `X-User-Email` headers injected by Caddy's `forward_auth`
- Both services share `platform.db` (SQLite WAL mode supports concurrent access)
- Each service owns its own tables (auth: `users`, `sessions`, `env_access`; control-plane: `envs`) but may read across

## Control Plane API Endpoints

```
GET    /health              Health check
POST   /envs                Create environment (name required, optional gh_repo)
GET    /envs                List user's environments
GET    /envs/:id            Environment details + live VM status
DELETE /envs/:id            Destroy environment (owner only)
POST   /envs/:id/access     Grant/revoke access (owner only)
GET    /envs/:id/access     List users with access
GET    /envs/:id/status-page HTML fallback for Caddy 502/503
GET    /envs/:id/terminal   WebSocket upgrade for xterm.js web terminal
GET    /envs/:id/claude/sessions  List Claude Code sessions from VM
POST   /envs/:id/agents/:type/sessions  Start new agent session (codex/opencode)
GET    /envs/:id/agents/:type/sessions  List agent sessions
GET    /envs/:id/sessions/:sid          Get session with message history
POST   /envs/:id/sessions/:sid/message  Send message to agent
POST   /envs/:id/sessions/:sid/stop     Interrupt agent
POST   /envs/:id/sessions/:sid/approval Respond to approval request
DELETE /envs/:id/sessions/:sid          Archive session
GET    /envs/:id/ws                     WebSocket for streaming agent events
GET    /envs/:id/codex/auth/status      Check Codex auth status (via app-server account/read)
POST   /envs/:id/codex/auth/login       Start Codex login (ChatGPT device code or API key)
POST   /envs/:id/codex/auth/logout      Logout from Codex
```

## Database Tables

| Table | Owned By | Purpose |
|-------|----------|---------|
| `users` | auth | User accounts (GitHub, Google, email). Includes `github_username` for SSH key lookup |
| `sessions` | auth | JWT session records (defined but not actively used — JWT is cookie-based) |
| `env_access` | auth (schema), control-plane (writes) | Role-based access: owner/editor/viewer per env per user |
| `envs` | control-plane | Environment records: slug, ports, VM ID, vsock CID, VM IP, snapshot path, GitHub repo, status |
| `agent_sessions` | control-plane | Agent session records: env, type (codex/opencode), thread ID, status |
| `agent_messages` | control-plane | Conversation history: role, content, metadata per session |

## Implementation Progress

See `PLATFORM_PLAN.md` §Implementation Plan for the full 5-week roadmap.

### Phase 1: Infrastructure + Auth — COMPLETE
- VPS provisioning, Docker, Caddy, Node 22, SQLite setup
- Auth service: GitHub OAuth, Google OAuth (PKCE), email magic links
- JWT session cookies scoped to `.BASE_DOMAIN`
- Caddy `forward_auth` wired to `/verify` endpoint
- Login page with dark theme (Tailwind)

### Phase 2: Control Plane + Containers → Firecracker VMs — COMPLETE
- Control plane API on port 4001 with all env CRUD endpoints
- Firecracker VM lifecycle via REST API (create, start, stop, snapshot, restore)
- Port allocation: app (10001+), SSH (20001+), OpenCode (30001+), vsock CID (3+)
- Dynamic Caddy route registration/removal via admin API
- GitHub repo creation via Octokit + SSH key fetching from `github.com/{username}.keys`
- Status page HTML fallback for Caddy 502/503 (also triggers wake for snapshotted VMs)
- Access management (grant/revoke roles)
- `github_username` column added to users table for SSH key lookup
- VM rootfs: Alpine Linux ext4 image (`vm/build-rootfs.sh`)
- VM init: PID 1 script with network config, SSH (TCP), account unlock, git clone, OpenCode server (`vm/init.sh`)
- Host setup: Firecracker binary, kernel, bridge interface, NAT, TAP helpers (`infra/setup-host.sh`)

### Phase 3: Web Terminal + Claude Code — COMPLETE
- Web terminal: `node-pty` + `@fastify/websocket` in control-plane, xterm.js client in dashboard
- `control-plane/terminal/pty-handler.ts`: PTY lifecycle over SSH (create, resize, cleanup, graceful shutdown)
- `control-plane/routes/terminal.ts`: WebSocket route `GET /envs/:id/terminal` with auth + access check
- `control-plane/routes/claude.ts`: `GET /envs/:id/claude/sessions` reads session metadata via SSH exec
- `@fastify/cors` added for cross-origin dashboard API calls
- Dashboard (`dashboard/`): React 19 + Vite + Tailwind CSS 4 SPA on port 4002
  - Env list page with create form, env detail page with Terminal and Claude Code tabs
  - xterm.js terminal with WebSocket, auto-reconnect, resize support
  - Claude Code tab: SSH command + copy, auth instructions, recent sessions list
- Cookie domain fix: `__session` cookie now sets `domain: "localhost"` in dev for cross-subdomain access
- MOTD added to container entrypoint with quick-start instructions
- `ANTHROPIC_API_KEY` persisted in container's `~/.env`

### Phase 4: Agent Bridge — Codex + OpenCode — COMPLETE
- **Codex bridge** (`control-plane/agents/codex-bridge.ts`): JSON-RPC 2.0 over stdio via SSH
  - Protocol reference: https://developers.openai.com/codex/app-server/
  - Full lifecycle: `initialize` + `initialized` handshake → `thread/start` → `turn/start` (with `input` array) → streaming events → `turn/interrupt`
  - Event mapping: `item/agentMessage/delta` → message.delta, `item/started`/`item/completed` for tool calls + file changes
  - Approval handling: Server sends JSON-RPC requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`), bridge forwards to dashboard, user responds, bridge sends JSON-RPC response back
  - Auth: `account/read` checks status, `account/login/start { type: "apikey" }` for API key login. ChatGPT login uses `codex login --device-auth` CLI over SSH (app-server OAuth needs localhost redirect which doesn't work in VMs)
  - Auth bridge: `AgentManager.getCodexAuthBridge()` maintains a persistent app-server process per env for auth operations, separate from session bridges
- **OpenCode bridge** (`control-plane/agents/opencode-bridge.ts`): HTTP REST + SSE to VM's OpenCode server (via iptables DNAT port forwarding)
  - Session CRUD via HTTP, SSE event stream for real-time updates
  - Auth via HTTP basic auth with username `opencode` and per-env `OPENCODE_SERVER_PASSWORD`
  - SSE format: data-only (no `event:` lines), event type is `data.type`, payload is in `data.properties`
  - Message format: `{ parts: [{ type: "text", text }] }` (not `{ content }`)
  - Event mapping: `message.part.delta` → message.delta (streaming), `message.part.updated` (type=text) → message.completed, `session.status` (status.type) → turn lifecycle
  - Model info: Emits `session.info` events with `modelID` and `providerID` from `message.updated` events
- **Shared types** (`control-plane/agents/types.ts`): AgentEvent (includes `session.info` for model display), AgentCommand, AgentBridge interface
- **WebSocket hub** (`control-plane/agents/ws-hub.ts`): Per-env broadcast of normalized agent events
- **Agent manager** (`control-plane/agents/manager.ts`): Coordinates bridges, DB persistence, WebSocket hub
  - Session lifecycle: create → send messages → interrupt → archive/delete
  - Dual-write: persists messages in `agent_messages` + broadcasts via WebSocket
  - Auto-titles sessions from first assistant response
  - Auth bridge management: persistent Codex app-server per env for auth operations
- **DB tables**: `agent_sessions` (id, env_id, agent_type, thread_id, title, status) + `agent_messages` (id, session_id, role, content, metadata)
- **API routes** (`control-plane/routes/agents.ts`): Full CRUD + WebSocket + Codex auth endpoints
- **Dashboard**: Codex + OpenCode tabs with chat UI, session sidebar, streaming messages, tool call cards, approval prompts
  - `useAgentSocket` hook for WebSocket connection + event handling
  - `AgentTab` component (shared for both agent types) with model info display in header
  - `ChatMessage` + `StreamingMessage` + `ApprovalCard` components
  - Codex auth dialog: "Sign in with ChatGPT" (device code flow) or "Use API Key" options

### Phase 5: Dashboard + Polish — IN PROGRESS
- [x] Graceful env creation without `GH_PAT` (clear error message, optional `gh_repo` field)
- [x] Container failure rollback (cleans up DB records so ports are freed for retry)
- [x] Dev mode auth bypass for local development
- [x] SSH exec switched from vsock to TCP over bridge network (Firecracker vsock UDS incompatible with `AF_VSOCK`)
- [x] OpenSSH 10+ locked account fix (`dev:!:` → `dev:*:` in shadow)
- [x] CORS dynamic origin validation (accepts IP-based and hostname-based dashboard access on port 4002)
- [x] Caddy admin API Origin header fix (Node.js `fetch` doesn't send `Origin`)
- [x] Host `vhost_vsock` kernel module persistence (`/etc/modules-load.d/vhost-vsock.conf`)
- [x] Host `socat` package installed
- [ ] Access control UI (share by email)
- [ ] Error handling improvements (agent session errors surface to UI)
- [ ] Health monitoring
- [ ] Onboarding flow
- [ ] File browser tab

## Agent Integration Details

### Codex App-Server Protocol
- Docs: https://developers.openai.com/codex/app-server/
- Auth docs: https://developers.openai.com/codex/auth/
- The app-server JSON-RPC provides `account/read`, `account/login/start`, `account/logout` for auth
- `account/login/start { type: "chatgpt" }` returns an OAuth redirect URL to `localhost:1455/auth/callback` — this doesn't work in containers, so ChatGPT login falls back to CLI `codex login --device-auth`
- `account/login/start { type: "apikey", apiKey: "sk-..." }` works through the app-server
- Server-initiated requests (approvals) have both `id` and `method` — must respond with a JSON-RPC response using the same `id`
- Notifications have `method` but no `id`

### OpenCode HTTP API
- OpenCode runs as `opencode serve --port 5000 --hostname 0.0.0.0` inside VMs
- Auth: HTTP basic auth with username `opencode` and password from `OPENCODE_SERVER_PASSWORD` env var
- `POST /session` — create session
- `POST /session/{id}/message` — send message with `{ parts: [{ type: "text", text }] }`
- `GET /session/{id}` — get session details
- `GET /session` — list sessions
- `GET /event` — SSE stream (data-only format, type in JSON payload)
- OpenCode installs to `/root/.opencode/bin/opencode` — symlinked to `/usr/local/bin/opencode` in the rootfs build

## Future Work / Known Issues

- **Codex app-server OAuth**: The app-server's ChatGPT OAuth flow uses a localhost redirect (`localhost:1455/auth/callback`) that doesn't work inside VMs. Investigate if the redirect URI can be configured, or if a proxy approach could make it work natively instead of falling back to CLI device auth.
- **OpenCode config**: OpenCode's model/provider configuration inside VMs needs investigation. Currently uses whatever default model OpenCode selects. Users may want to configure this.
- **Agent bridge resilience**: Bridges are in-memory — control plane restart loses all active sessions. Consider reconnecting to existing app-server/OpenCode processes on restart.
- **VM rootfs size**: Current Alpine rootfs is ~1GB. Could be optimized further by removing unused packages.
- **Jailer integration**: Run Firecracker processes in chroot/cgroup jail for security hardening.
- **Snapshot compression**: VM memory snapshots are ~512MB each (= mem_size_mib). Consider compression or deduplication.
- **Host crash recovery**: In-memory VM state is lost on control plane restart. On startup, should scan for running Firecracker processes and reconcile with DB.
- **Port allocation**: Currently uses simple incrementing ports from DB. Could run out or conflict if envs are rapidly created/destroyed.
- **OpenCode install method**: The `curl | bash` install is fragile. Pin a specific version and install to a known path.
- **Vsock SSH (future optimization)**: Currently using TCP SSH over bridge network. Could switch to proper vsock by writing a ProxyCommand that connects to Firecracker's UDS socket and performs the `CONNECT <port>\n` / `OK <cid>\n` handshake. Would eliminate TCP/IP overhead. See Firecracker vsock docs for the UDS protocol.
- **Caddy not fully configured**: Caddy is installed but still has the default Caddyfile. The admin API route registration works but Caddy isn't serving env subdomains yet. Need a proper Caddyfile with wildcard domains + forward_auth.
- **Services not systemd-managed**: Auth, control plane, and dashboard run as backgrounded `nohup` processes. Should create systemd units for auto-restart and proper logging.

## Env Creation Flow (POST /envs)

For reference, the full orchestration in `control-plane/routes/envs.ts`:
1. Validate body (`name` required, optional `gh_repo`)
2. Generate slug: `env-` + 6 random alphanumeric chars
3. Allocate ports + vsock CID + VM IP from DB
4. Create GitHub repo via Octokit (or use provided `gh_repo`). If no `GH_PAT` and no `gh_repo`, returns 400 with clear error.
5. Fetch user's GitHub SSH keys from `github.com/{username}.keys`
6. Insert env record (status: `creating`) + grant owner access
7. Create + start Firecracker VM (rootfs, TAP, vsock device, iptables DNAT, kernel cmdline)
   - Waits for SSH readiness via TCP to VM bridge IP (up to 30s timeout)
   - On failure: rolls back DB records (deletes env + access) so ports/CIDs are freed for retry
8. Register Caddy route via admin API (non-fatal)
9. Update status to `running`
10. Return `{ id, url, repo_url, ssh_command, ssh_port, status }`

## VM Init Behavior

The init script (`vm/init.sh`, executed as PID 1 via `/sbin/deploymagi-init`) is fault-tolerant:
- Parses `dm.*` kernel cmdline params for env config (IP, SSH keys, repo, API keys)
- Configures networking (eth0 with static IP from kernel cmdline)
- Unlocks `dev` user account (`sed -i 's/^dev:!:/dev:*:/' /etc/shadow`) — required because OpenSSH 10+ rejects pubkey auth for locked accounts
- SSH: TCP sshd on port 22 + vsock SSH listener via socat (vsock listener kept for future use)
- Control plane connects to VMs via TCP SSH over the bridge network (172.16.0.x), not vsock
- If `GH_REPO`/`GH_TOKEN` are empty or git clone fails, creates an empty local git repo instead of crashing
- OpenCode server starts via `nohup` in background
- App startup (`npm start` / `python3 app.py`) is best-effort with `|| true`
- SSH keys injected from base64-encoded kernel cmdline param
- Internal SSH key (for control plane SSH exec) injected alongside user keys
- Graceful shutdown on SIGTERM (stops PM2, kills background processes)

## Idle Shutdown + Wake-on-Request

- **Idle Monitor** (`control-plane/services/idle-monitor.ts`): Polls TAP device traffic counters every 30s. If no network activity for 15min (configurable), snapshots the VM and frees resources.
- **Wake Service** (`control-plane/services/wake.ts`): `ensureVMRunning(envId)` restores from snapshot if needed. Called by terminal, agent, and file routes. Coalesces concurrent wake requests.
- **Status Page**: When a request hits a snapshotted env via Caddy, the status page triggers a wake in the background and auto-refreshes every 3s.
- **Dashboard**: Shows "snapshotted" / "paused" badges on env cards, and a "waking up" banner when connecting to a sleeping env.
