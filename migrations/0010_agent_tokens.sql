PRAGMA foreign_keys = ON;

-- Long-lived, scoped credentials that external AI agents present to the
-- first-party MCP server. Distinct from the 15-minute JWT access tokens.
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- PBKDF2(passwordIterations)
  scopes TEXT NOT NULL,                -- JSON array of PERMISSION_KEYS
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_tokens_user ON agent_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_agent_tokens_hash ON agent_tokens(token_hash);

-- Seed the three permission keys introduced by the first-party MCP server.
-- Administrator role gets all three; member role does not (per impl doc,
-- member is intentionally limited to message.* / attachment.read).
INSERT INTO permissions (key, description) VALUES
  ('ai.read', 'Invoke AI read tools (summarize / classify / extract) over authorized mailboxes'),
  ('ai.write', 'Embed and reindex messages for the first-party MCP server'),
  ('schedule.write', 'Create or cancel scheduled sends via MCP tools');

INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('00000000-0000-4000-8000-000000000001', 'ai.read'),
  ('00000000-0000-4000-8000-000000000001', 'ai.write'),
  ('00000000-0000-4000-8000-000000000001', 'schedule.write');