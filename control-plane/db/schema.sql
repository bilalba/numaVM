CREATE TABLE IF NOT EXISTS envs (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  gh_repo           TEXT NOT NULL,
  gh_token          TEXT NOT NULL,
  container_id      TEXT,
  vm_ip             TEXT,
  vsock_cid         INTEGER UNIQUE,
  vm_pid            INTEGER,
  snapshot_path     TEXT,
  app_port          INTEGER UNIQUE,
  ssh_port          INTEGER UNIQUE,
  opencode_port     INTEGER UNIQUE,
  opencode_password TEXT,
  pages_port        INTEGER UNIQUE,
  status            TEXT NOT NULL DEFAULT 'creating'
                    CHECK(status IN ('creating', 'running', 'stopped', 'paused', 'snapshotted', 'error')),
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
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
