-- 0002_managed_domains.sql — Tenancy: managed_domains (Phase 1)
-- Creates the managed_domains table. This table is owned by the tenancy module
-- (per .claude/rules/architecture.md §Persistence ownership).
--
-- R-DATA-001: Domain names are case-insensitive (COLLATE NOCASE).
-- ManagedDomain invariant: name is UNIQUE. New domains start as 'active'.
-- outbound_connection_id is nullable — FK added when provider_connections exists (CAP-014).
CREATE TABLE IF NOT EXISTS managed_domains (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL COLLATE NOCASE,
  status                  TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  outbound_connection_id  TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS managed_domains_name_unique
  ON managed_domains(name COLLATE NOCASE);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_managed_domains.sql');
