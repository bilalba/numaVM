CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  github_id   TEXT,
  github_username TEXT,
  google_id   TEXT,
  avatar_url  TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  expires_at  DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS env_access (
  env_id      TEXT,
  user_id     TEXT REFERENCES users(id),
  role        TEXT CHECK(role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (env_id, user_id)
);
