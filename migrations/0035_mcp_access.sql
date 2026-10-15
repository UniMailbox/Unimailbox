-- Disabled until an administrator enables the endpoint.
CREATE TABLE IF NOT EXISTS mcp_configuration (
  id TEXT PRIMARY KEY CHECK (id = 'system'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  allow_send INTEGER NOT NULL DEFAULT 0 CHECK (allow_send IN (0, 1)),
  requests_per_minute INTEGER NOT NULL DEFAULT 30 CHECK (requests_per_minute BETWEEN 1 AND 120),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT OR IGNORE INTO mcp_configuration (id) VALUES ('system');
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  allow_draft INTEGER NOT NULL CHECK (allow_draft IN (0, 1)),
  allow_send INTEGER NOT NULL CHECK (allow_send IN (0, 1)),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_tokens_user ON mcp_tokens(user_id, created_at);
CREATE TABLE IF NOT EXISTS mcp_token_mailboxes (
  token_id TEXT NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  PRIMARY KEY (token_id, mailbox_id)
);
CREATE TABLE IF NOT EXISTS mcp_rate_windows (
  token_id TEXT PRIMARY KEY REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0)
);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0035_mcp_access.sql');
