CREATE TABLE IF NOT EXISTS envs (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  gh_repo           TEXT,
  gh_token          TEXT,
  container_id      TEXT,
  vm_ip             TEXT,
  vsock_cid         INTEGER UNIQUE,
  vm_pid            INTEGER,
  snapshot_path     TEXT,
  app_port          INTEGER UNIQUE,
  ssh_port          INTEGER UNIQUE,
  opencode_port     INTEGER UNIQUE,
  opencode_password TEXT,
  status            TEXT NOT NULL DEFAULT 'creating'
                    CHECK(status IN ('creating', 'running', 'stopped', 'paused', 'snapshotted', 'error')),
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  pages_port        INTEGER UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_envs_owner ON envs(owner_id);
CREATE INDEX IF NOT EXISTS idx_envs_status ON envs(status);

-- Agent sessions (Codex + OpenCode)
CREATE TABLE IF NOT EXISTS agent_sessions (
  id          TEXT PRIMARY KEY,
  env_id      TEXT NOT NULL REFERENCES envs(id),
  agent_type  TEXT NOT NULL CHECK(agent_type IN ('codex', 'opencode')),
  thread_id   TEXT,
  title       TEXT,
  status      TEXT NOT NULL DEFAULT 'idle'
              CHECK(status IN ('idle', 'busy', 'error', 'archived')),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_env ON agent_sessions(env_id);

-- Agent messages (conversation history)
CREATE TABLE IF NOT EXISTS agent_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES agent_sessions(id),
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
  content     TEXT NOT NULL,
  metadata    TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id);

-- VM traffic history (recorded every 5min by idle monitor)
CREATE TABLE IF NOT EXISTS vm_traffic (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  env_id      TEXT NOT NULL,
  rx_bytes    INTEGER NOT NULL,
  tx_bytes    INTEGER NOT NULL,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vm_traffic_env ON vm_traffic(env_id);
CREATE INDEX IF NOT EXISTS idx_vm_traffic_time ON vm_traffic(recorded_at);

-- Admin events (audit log for admin dashboard)
CREATE TABLE IF NOT EXISTS admin_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  env_id     TEXT,
  user_id    TEXT,
  metadata   TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_events_type ON admin_events(type);
CREATE INDEX IF NOT EXISTS idx_admin_events_created ON admin_events(created_at);
