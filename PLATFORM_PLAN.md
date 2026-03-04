# Remote Agent Workbench — Complete MVP Plan

## Vision

A platform where each **environment** is an always-on Docker container with persistent storage, a GitHub-backed repo, a public subdomain (gated by OAuth), and the ability to drive **Codex**, **Claude Code**, and **OpenCode** from a web dashboard — with full conversation history.

---

## Architecture

```
                         *.envs.yourdomain.dev
                                 │
                           ┌─────▼─────┐
                           │   Caddy    │  Wildcard TLS
                           │  (proxy)   │  forward_auth → auth service
                           └──┬──┬──┬──┘
                              │  │  │
          ┌───────────────────┘  │  └───────────────────┐
          ▼                      ▼                      ▼
   auth.yourdomain.dev    api.yourdomain.dev    env-{slug}.yourdomain.dev
   ┌──────────────┐       ┌──────────────┐       ┌──────────────────────┐
   │ Auth Service  │       │ Control Plane│       │ Docker Container     │
   │              │       │              │       │                      │
   │ GitHub OAuth │       │ Env CRUD     │       │  /data/repo (git)    │
   │ Google OAuth │       │ Agent bridge │       │  Codex app-server    │
   │ Email magic  │       │ Caddy mgmt   │       │  OpenCode serve      │
   │ Session mgmt │       │ GitHub API   │       │  Claude Code (CLI)   │
   │ ACL check    │       │ WebSocket hub│       │  SSH server :22      │
   └──────────────┘       │ Web terminal │       │  App server :4000    │
                          └──────────────┘       └──────────────────────┘
                                 │
                           ┌─────▼─────┐
                           │  SQLite    │
                           └───────────┘
```

---

## Agent Integration Strategy

Each of the three coding agents has a different integration model, chosen to match what actually works:

| Agent | Integration | Dashboard UX | Auth Model |
|---|---|---|---|
| **Codex** | app-server protocol (JSON-RPC over stdio) | Rich chat UI with streaming, approvals, history | Platform provides OPENAI_API_KEY |
| **OpenCode** | HTTP API + SSE (`opencode serve`) | Rich chat UI with streaming, approvals, history | Platform provides API keys |
| **Claude Code** | SSH access + web terminal (xterm.js) | Full terminal in browser, connection details, session list | User brings own key or runs `claude /login` |

**Why Claude Code gets SSH instead of an API integration**: The Claude Agent SDK spawns a CLI subprocess that needs auth. Anthropic explicitly prohibits third parties from offering claude.ai login via the SDK. OAuth tokens don't refresh in non-interactive mode. Rather than fighting these constraints, we give users native terminal access — which gives them Claude Code's *full* feature set: interactive mode, slash commands, MCP servers, subagents, everything.

---

## Component Breakdown

### 1. Auth Service (`auth.yourdomain.dev`)

**Purpose**: Vercel-style OAuth. Users log in once, get a session cookie scoped to `*.yourdomain.dev`, and every env subdomain is gated through it.

**OAuth Providers**:
- **GitHub OAuth App** — `GET /auth/github` → redirect to GitHub → callback → session
- **Google OAuth** (via Google Cloud Console) — `GET /auth/google` → redirect → callback → session
- **Email magic link** — `POST /auth/email` sends a signed link → `GET /auth/email/verify?token=...` → session

**Session Model**:
- On success, set a signed cookie (`__session`) as a JWT with `{user_id, email, exp}`
- Cookie domain: `.yourdomain.dev` (covers all subdomains)
- `Secure; HttpOnly; SameSite=Lax`

**Verification Endpoint** (for Caddy `forward_auth`):
- `GET /verify` — reads cookie, validates JWT, checks if user has access to the requested env (extracted from `X-Forwarded-Host`). Returns `200` + user headers or `401`.
- On `401`, Caddy redirects to `/login?redirect=<original_url>`

**Database Tables**:
```sql
users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  github_id   TEXT,
  google_id   TEXT,
  avatar_url  TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
)

sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  expires_at  DATETIME NOT NULL
)

env_access (
  env_id      TEXT REFERENCES envs(id),
  user_id     TEXT REFERENCES users(id),
  role        TEXT CHECK(role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (env_id, user_id)
)
```

**Tech**: Node.js (Fastify) + `arctic` (lightweight OAuth library) + `jose` (JWT) + SQLite via `better-sqlite3`.

---

### 2. Caddy (Reverse Proxy + TLS)

**Wildcard DNS**: `*.yourdomain.dev → VPS_IP`

**TLS**: Wildcard cert via DNS-01 challenge (Cloudflare or Route53).

**Routing Strategy**: Use Caddy's admin API (`localhost:2019`) to dynamically inject routes when envs are created/destroyed.

**Base Caddyfile**:
```
{
    admin localhost:2019
}

auth.yourdomain.dev {
    reverse_proxy localhost:4000
}

api.yourdomain.dev {
    forward_auth localhost:4000 {
        uri /verify
        copy_headers X-User-Id X-User-Email
    }
    reverse_proxy localhost:4001
}

app.yourdomain.dev {
    forward_auth localhost:4000 {
        uri /verify
        copy_headers X-User-Id X-User-Email
    }
    reverse_proxy localhost:4002
}
```

**Dynamic routing**: When env `env-abc123` is created on port 10001, POST a route config to Caddy's admin API. On upstream failure (502/503), rewrite to the control plane's status page. Detection at request time, zero extra processes.

---

### 3. Control Plane API (`api.yourdomain.dev`)

**Tech**: Node.js (Fastify) + SQLite + `dockerode` + Octokit + Caddy admin API.

**Core Tables**:
```sql
envs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_id        TEXT REFERENCES users(id),
  gh_repo         TEXT NOT NULL,
  gh_token        TEXT NOT NULL,
  container_id    TEXT,
  app_port        INTEGER UNIQUE,
  ssh_port        INTEGER UNIQUE,
  opencode_port   INTEGER UNIQUE,
  status          TEXT DEFAULT 'running',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
)

agent_sessions (
  id            TEXT PRIMARY KEY,
  env_id        TEXT REFERENCES envs(id),
  agent_type    TEXT CHECK(agent_type IN ('codex', 'opencode')),
  thread_id     TEXT,
  title         TEXT,
  status        TEXT DEFAULT 'idle',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME
)

agent_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES agent_sessions(id),
  role          TEXT CHECK(role IN ('user', 'assistant', 'system', 'tool')),
  content       TEXT NOT NULL,
  metadata      TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

**REST Endpoints**:
```
Env Management:
  POST   /envs                  Create env
  GET    /envs                  List envs for user
  GET    /envs/:id              Env details + status
  DELETE /envs/:id              Destroy env
  POST   /envs/:id/access       Grant/revoke user access
  GET    /envs/:id/status-page  HTML status page (Caddy fallback)

Agent Operations (Codex + OpenCode):
  POST   /envs/:id/agents/:type/sessions  Start new agent session
  GET    /envs/:id/agents/:type/sessions  List sessions
  GET    /envs/:id/sessions/:sid          Get session with history
  POST   /envs/:id/sessions/:sid/message  Send message
  POST   /envs/:id/sessions/:sid/stop     Interrupt agent
  DELETE /envs/:id/sessions/:sid          Archive session

Claude Code (info only):
  GET    /envs/:id/claude/sessions        List sessions from container

Terminal:
  GET    /envs/:id/terminal               WebSocket for xterm.js

Realtime:
  GET    /envs/:id/ws                     WebSocket for agent events
```

**Env Creation Flow**:
1. Generate slug: `env-` + 6 random alphanumeric chars
2. Allocate ports: app (10001+), SSH (20001+), OpenCode API (30001+)
3. Create GitHub repo via Octokit (from template or empty)
4. Fetch user's GitHub SSH keys via `https://github.com/{username}.keys`
5. `docker run` with volume, port mappings, env vars
6. Register Caddy route via admin API
7. Insert env + owner access into SQLite
8. Return `{ id, url, repo_url, ssh_command, ssh_port }`

---

### 4. Agent Bridge Layer

#### 4a. Codex (via app-server protocol)

**Integration**:
```
Control Plane <-> docker exec -i env-{slug} codex app-server
                     |-- stdin/stdout JSONL (JSON-RPC 2.0)
```

**Lifecycle per session**:
1. Spawn `codex app-server` inside the container via `docker exec -i`
2. Send `initialize` → `initialized` handshake
3. `thread/start` creates a conversation (with model, cwd, sandbox config)
4. `turn/start` sends user messages, streams events back
5. Receive `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `turn/completed`
6. `thread/read` with `includeTurns: true` retrieves full history
7. `thread/list` paginates through past conversations
8. `turn/interrupt` cancels in-flight work

**Approval handling**: Codex sends `requestApproval` events. Bridge forwards to dashboard via WebSocket, user clicks approve/decline, bridge responds back.

**Thread persistence**: Codex persists threads as JSONL files on disk. History survives restarts.

#### 4b. OpenCode (via serve + HTTP API)

**Integration**:
```
Container boots -> opencode serve --port 5000 --hostname 0.0.0.0
Control Plane <-> HTTP to container:{opencode_port}
Dashboard     <-> SSE from container:{opencode_port}/event
```

**OpenCode API endpoints** (built-in):
- `POST /session` — create session
- `POST /session/{id}/message` — send message
- `GET /session/{id}` — get session with history
- `GET /event` — SSE stream for real-time events
- `GET /session` — list sessions

**Auth**: `OPENCODE_SERVER_PASSWORD` env var, HTTP basic auth.

**Session persistence**: OpenCode stores sessions in SQLite internally.

#### 4c. Claude Code (via SSH + Web Terminal)

**SSH Access**:
```
ssh dev@yourdomain.dev -p {ssh_port}
cd ~/repo && claude
```

**Web Terminal**:
```
Dashboard (xterm.js) → WebSocket → Control Plane → docker exec -it {slug} su - dev
```

The control plane runs a WebSocket-to-PTY bridge using `node-pty`.

**SSH key auto-provisioning**: On env creation, fetch user's GitHub SSH keys from `https://github.com/{username}.keys` and inject into `authorized_keys`.

**Claude Code auth**: Users either set `ANTHROPIC_API_KEY` (persisted in `/data/.env`) or run `claude /login` interactively in the terminal.

**Session history**: Claude Code stores sessions in `~/.claude/projects/`. Dashboard reads metadata via `docker exec` for the session list. Actual interaction is terminal-only.

**Dashboard Claude Code tab**:
```
┌──────────────────────────────────────────────────────┐
│  Claude Code                                         │
│                                                      │
│  Connect via SSH:                                    │
│  ssh dev@yourdomain.dev -p 20001          [Copy]     │
│                                                      │
│  Or click the Terminal tab for a browser terminal.   │
│                                                      │
│  Your GitHub SSH keys are pre-configured.            │
│  Run `claude` in ~/repo to start.                    │
│                                                      │
│  Auth: Set ANTHROPIC_API_KEY in your shell, or run   │
│  `claude /login` to authenticate interactively.      │
│                                                      │
│  ┌─ Recent Sessions ─────────────────────────────┐   │
│  │  • "Fix auth middleware" — 2 hours ago        │   │
│  │  • "Add user endpoints" — yesterday           │   │
│  │  • "Refactor database layer" — 3 days ago     │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

---

### 5. Web Terminal (xterm.js)

**Architecture**:
```
Browser (xterm.js + fit addon + web-links addon)
    |
    WebSocket (wss://api.yourdomain.dev/envs/{slug}/terminal)
    |
Control Plane (node-pty)
    |
Container (bash as user 'dev', cwd ~/repo)
```

**Server-side**:
```js
wss.on('connection', (ws, req) => {
  const slug = extractSlug(req);
  const pty = spawn('docker', ['exec', '-it', slug, 'su', '-', 'dev'], {
    name: 'xterm-256color', cols: 80, rows: 24
  });
  pty.onData(data => ws.send(data));
  ws.on('message', msg => {
    const parsed = JSON.parse(msg);
    if (parsed.type === 'input') pty.write(parsed.data);
    if (parsed.type === 'resize') pty.resize(parsed.cols, parsed.rows);
  });
  ws.on('close', () => pty.kill());
});
```

**Used for**: Running Claude Code, general shell access, debugging, anything terminal-based.

---

### 6. Env Container Image

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    curl git nodejs npm python3 python3-pip \
    build-essential jq wget unzip \
    openssh-server sudo \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

# SSH server
RUN mkdir /var/run/sshd
RUN sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
RUN sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

# Non-root user
RUN useradd -m -s /bin/bash dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
RUN mkdir -p /home/dev/.ssh && chmod 700 /home/dev/.ssh

# Codex CLI
RUN npm install -g @openai/codex

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# OpenCode
RUN curl -fsSL https://opencode.ai/install | bash

# Process manager
RUN npm install -g pm2

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /data
EXPOSE 22 4000 5000
ENTRYPOINT ["/entrypoint.sh"]
```

**entrypoint.sh**:
```bash
#!/bin/bash
set -e

# SSH Setup
echo "${SSH_AUTHORIZED_KEYS}" > /home/dev/.ssh/authorized_keys
chmod 600 /home/dev/.ssh/authorized_keys
chown -R dev:dev /home/dev/.ssh
/usr/sbin/sshd

# Git config
su - dev -c 'git config --global user.email "agent@yourdomain.dev"'
su - dev -c 'git config --global user.name "Agent"'

# Clone or pull repo
if [ ! -d /data/repo/.git ]; then
  git clone "https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git" /data/repo
  chown -R dev:dev /data/repo
else
  cd /data/repo && git pull --ff-only || true
fi

ln -sf /data/repo /home/dev/repo
chown -R dev:dev /data

# Persist env vars for SSH sessions
cat > /home/dev/.env <<EOF
export GH_REPO="${GH_REPO}"
export GH_TOKEN="${GH_TOKEN}"
export OPENAI_API_KEY="${OPENAI_API_KEY}"
EOF
echo 'source ~/.env 2>/dev/null' >> /home/dev/.bashrc
chown dev:dev /home/dev/.env /home/dev/.bashrc

# Start OpenCode server
su - dev -c "OPENCODE_SERVER_PASSWORD='${OPENCODE_PASSWORD}' \
  opencode serve --port 5000 --hostname 0.0.0.0 &"

# Start app if it exists
cd /data/repo
export PORT=4000
if [ -f package.json ]; then
  su - dev -c 'cd /data/repo && npm install 2>/dev/null && pm2 start npm --name app -- start' || true
elif [ -f requirements.txt ]; then
  pip install -r requirements.txt --break-system-packages 2>/dev/null
  [ -f app.py ] && su - dev -c 'cd /data/repo && pm2 start "python3 app.py" --name app' || true
fi

tail -f /dev/null
```

---

### 7. Web Dashboard (`app.yourdomain.dev`)

React SPA. Primary interface for managing envs and interacting with agents.

**Environment Detail** (`/env/:slug`):
```
┌──────────────────────────────────────────────────────┐
│  env-abc123  ·  my-saas-app                          │
│  https://env-abc123.yourdomain.dev  [Visit] [GitHub] │
├──────────────────────────────────────────────────────┤
│  [Codex] [OpenCode] [Claude Code] [Terminal] [Files] │
├──────────────────────────────────────────────────────┤
│                                                      │
│  (tab content)                                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Tab: Codex / OpenCode** — Rich chat UI with session selector, streaming messages, tool call expansions, file diffs, approval cards, message input.

**Tab: Claude Code** — Info panel with SSH command, auth instructions, recent session list.

**Tab: Terminal** — Full xterm.js terminal. Run `claude`, `codex`, `opencode`, or anything.

**Tab: Files** — Repo file browser with tree view and git history.

**Tech**: React + Tailwind + xterm.js + WebSocket.

---

### 8. Unified Event Protocol (Codex + OpenCode only)

```typescript
type AgentEvent =
  | { type: 'session.started'; sessionId: string; agentType: 'codex' | 'opencode' }
  | { type: 'turn.started'; turnId: string }
  | { type: 'turn.completed'; turnId: string; status: string }
  | { type: 'message.delta'; text: string }
  | { type: 'message.completed'; text: string }
  | { type: 'tool.started'; tool: string; input: any }
  | { type: 'tool.output.delta'; text: string }
  | { type: 'tool.completed'; tool: string; result: any }
  | { type: 'file.changed'; path: string; diff: string }
  | { type: 'approval.requested'; id: string; action: string; detail: any }
  | { type: 'plan.updated'; steps: PlanStep[] }
  | { type: 'error'; message: string; code?: string }

type AgentCommand =
  | { type: 'message.send'; text: string }
  | { type: 'turn.interrupt' }
  | { type: 'approval.respond'; id: string; decision: 'accept' | 'decline' }
  | { type: 'session.switch'; sessionId: string }
  | { type: 'session.create' }
```

| Source Event     | Codex app-server         | OpenCode HTTP            |
|------------------|--------------------------|--------------------------|
| Text streaming   | item/agentMessage/delta  | message.part.updated SSE |
| Command run      | item/commandExecution/*  | message.part.updated     |
| File change      | item/fileChange/*        | message.part.updated     |
| Approval needed  | item/*/requestApproval   | permission.asked SSE     |
| Turn complete    | turn/completed           | session.status: idle SSE |

Claude Code is terminal-only — not part of this protocol.

---

### 9. Conversation History

**Codex + OpenCode (dual-write)**:
- Agent-native storage inside container (Codex JSONL logs, OpenCode SQLite)
- Platform DB mirrors normalized messages for fast dashboard rendering
- Resume uses native thread/session IDs

**Claude Code (native only)**:
- History lives in `~/.claude/projects/` on the persistent volume
- Dashboard reads session metadata via `docker exec` for the list view
- Actual interaction is terminal-only, no dual-write needed

---

## Implementation Plan

### Week 1: Infrastructure + Auth

**Day 1-2**: Provision VPS (Hetzner CX42, ~$20/mo). Install Docker, Caddy, Node 22, SQLite. Wildcard DNS + Caddy wildcard TLS via Cloudflare. Verify HTTPS on any subdomain.

**Day 3-4**: Auth service. GitHub OAuth. Session cookie on `.yourdomain.dev`. `/verify` endpoint. Login page. Test: visit subdomain → login redirect → auth → redirect back.

**Day 5**: Wire Caddy `forward_auth`. Add Google OAuth + email magic links. End-to-end auth gating works.

### Week 2: Control Plane + Containers

**Day 1-2**: Control plane API. Env CRUD. Docker management via `dockerode`. Port allocation (app, SSH, OpenCode).

**Day 3**: Container image. Dockerfile with SSH, Codex, Claude Code, OpenCode. Entrypoint. Test: `docker run` → SSH works → `claude` runs → OpenCode API responds.

**Day 4**: Dynamic Caddy routing + status page fallback.

**Day 5**: GitHub integration. Template repo. Fetch GitHub SSH keys on env create → inject into container.

### Week 3: Web Terminal + Claude Code

**Day 1-2**: Web terminal. `node-pty` + `ws`. xterm.js client. Resize, reconnection. Test: browser terminal → `claude` → full interactive session.

**Day 3**: Claude Code dashboard tab. SSH info, session list from container, auth instructions.

**Day 4-5**: SSH hardening. Key-only auth. Persist API keys in `/data/.env`. MOTD. Full flow test.

### Week 4: Agent Bridge — Codex + OpenCode

**Day 1-2**: Codex bridge. JSON-RPC client. Initialize → thread/start → turn/start. Event parsing. Message storage.

**Day 3**: Codex approvals + history. Forward approvals to WebSocket. Thread list/read.

**Day 4**: OpenCode bridge. HTTP client + SSE. Event normalization. Session management.

**Day 5**: Wire both to dashboard WebSocket. Test streaming for both agents.

### Week 5: Dashboard + Polish

**Day 1-2**: React dashboard. Env cards, detail page, agent panels, terminal tab.

**Day 3**: Conversation history UI. Session sidebar, search.

**Day 4**: Access control. Share by email. Roles. Add collaborator SSH keys.

**Day 5**: Error handling, health monitoring, logging, onboarding.

---

## File Structure on VPS

```
/opt/platform/
├── auth/                       # Port 4000
│   ├── server.ts
│   ├── oauth/ (github.ts, google.ts, email.ts)
│   ├── session.ts, verify.ts
│   └── views/login.html
│
├── control-plane/              # Port 4001
│   ├── server.ts
│   ├── routes/ (envs.ts, agents.ts, sessions.ts)
│   ├── services/ (docker.ts, github.ts, caddy.ts, port-allocator.ts)
│   ├── agents/
│   │   ├── bridge.ts, codex-bridge.ts, opencode-bridge.ts
│   │   └── event-normalizer.ts
│   ├── terminal/pty-handler.ts
│   ├── ws/handler.ts
│   └── db/ (schema.sql, queries.ts)
│
├── dashboard/                  # Port 4002
│   └── src/
│       ├── pages/ (Login, Dashboard, EnvDetail)
│       ├── components/ (AgentPanel, MessageList, ToolCallView,
│       │   DiffView, ApprovalPrompt, SessionSidebar,
│       │   ClaudeCodeTab, TerminalTab, FileBrowser)
│       └── hooks/ (useWebSocket, useAgentSession, useTerminal)
│
├── docker/ (Dockerfile.env, entrypoint.sh)
├── Caddyfile
└── platform.db

/data/envs/
├── env-abc123/repo/
├── env-def456/repo/
└── ...
```

---

## Secrets

```bash
# /opt/platform/.env
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
RESEND_API_KEY=...             # Email magic links
JWT_SECRET=...                 # Session cookies
GH_APP_PRIVATE_KEY=...        # Repo creation
OPENAI_API_KEY=...             # For Codex in containers
CF_API_TOKEN=...               # Caddy DNS challenge
```

`ANTHROPIC_API_KEY` is **not** platform-managed. Users provide their own credentials inside the container via env var or `claude /login`. No licensing issues.

---

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Claude Code via SSH/terminal | Not Agent SDK | SDK auth doesn't work for third-party apps. SSH gives full native experience. |
| Codex via app-server | JSON-RPC over stdio | Purpose-built protocol with threads, streaming, approvals, history. |
| OpenCode via HTTP API | REST + SSE | Built-in server mode, lightweight, persistence included. |
| Web terminal (xterm.js) | In-dashboard | No local SSH client needed. Works from any browser. |
| VPS over cloud VMs | Single Hetzner box | $20/mo, simple, fast iteration. |
| Docker over Firecracker | Docker | MVP speed, upgrade later for isolation. |
| SQLite | Zero ops | Sufficient for single-node MVP. |
| Caddy | Auto-TLS + admin API | Dynamic routes without restarts. |
| Always-on containers | No orchestration | Simpler, no cold starts, stateful. |
| User-managed Anthropic auth | No platform key | Respects licensing, users own their auth. |

---

## NOT in the MVP

- Multi-node / clustering
- Firecracker / microVM isolation
- Kubernetes / Nomad
- Platform-managed Anthropic API keys
- User billing / quotas
- CI/CD pipelines (agents ARE the CI/CD)
- Custom domain per env
- Multi-user collaborative editing
- Agent-to-agent coordination across envs
- File upload from dashboard (use git or terminal)
