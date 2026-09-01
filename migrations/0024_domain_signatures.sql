-- 0024_domain_signatures.sql — CAP-068.
-- One sanitized signature per managed domain. Content stays relational and
-- scalar; the Worker owns HTML sanitization before this table is written.

CREATE TABLE IF NOT EXISTS domain_signatures (
  id           TEXT PRIMARY KEY,
  domain_id    TEXT NOT NULL REFERENCES managed_domains(id) ON DELETE CASCADE,
  html_content TEXT NOT NULL DEFAULT '',
  text_content TEXT NOT NULL DEFAULT '',
  is_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(html_content) <= 100000),
  CHECK (length(text_content) <= 100000),
  CHECK (length(trim(html_content)) > 0 OR length(trim(text_content)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS domain_signatures_domain_unique
  ON domain_signatures(domain_id);

CREATE INDEX IF NOT EXISTS domain_signatures_enabled_idx
  ON domain_signatures(domain_id, is_enabled);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0024_domain_signatures.sql');
