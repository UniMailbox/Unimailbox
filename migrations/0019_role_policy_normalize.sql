-- migrations/0019_role_policy_normalize.sql — CAP-036 (R-DATA-005 strictness for v1).
--
-- Replace the JSON-in-TEXT columns in role_policies with two relational
-- child tables:
--   * role_policy_ban_emails     — one row per (role_id, pattern) for banEmail
--   * role_policy_avail_domains  — one row per (role_id, pattern) for availDomain
--
-- role_policies is rebuilt as metadata-only (role_id PK, updated_by,
-- updated_at). All per-pattern reads query the child tables.
--
-- Backfill uses SQLite's json_each() table-valued function. The
-- `WHERE je.type = 'text'` filter rejects non-string elements
-- defensively (e.g. if a row's JSON ever contained a number — none
-- exists today, but the defensive WHERE keeps the backfill from crashing
-- on such a value). Empty arrays ('[]') yield zero rows.
--
-- The legacy JSON columns are dropped via the rebuild pattern: CREATE
-- new, COPY, DROP old, RENAME. SQLite cannot ALTER TABLE DROP COLUMN
-- reliably across D1's SQLite version. role_policies has no external
-- FK references (it is itself only a child of roles), so DROP TABLE is
-- safe with PRAGMA foreign_keys = ON (R-DATA-004).
--
-- Rules:
--   R-DATA-005     Strict — no JSON-in-TEXT columns remain on role_policies.
--   R-INBOUND-006  Per-role banEmail + availDomain. Patterns stored in
--                  relational child tables; length per pattern is bounded.
--   R-DATA-004     PRAGMA foreign_keys = ON. The rebuild preserves the
--                  role_id → roles(id) ON DELETE CASCADE.
--
-- This migration is destructive (DROP TABLE role_policies, DROP the
-- legacy JSON columns). It is NOT independently rerunnable. Repeat
-- safety comes from the d1_migrations tracking table + the
-- pending-only migration runner.
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations
-- makes apply+track atomic with the schema change.

-- ============================================================================
-- 1. Create the child tables.
-- ============================================================================

CREATE TABLE IF NOT EXISTS role_policy_ban_emails (
  role_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  pattern  TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 254),
  PRIMARY KEY (role_id, pattern)
);

CREATE TABLE IF NOT EXISTS role_policy_avail_domains (
  role_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  pattern  TEXT NOT NULL CHECK (length(pattern) BETWEEN 2 AND 254),
  PRIMARY KEY (role_id, pattern)
);

-- ============================================================================
-- 2. Backfill from the legacy JSON columns.
-- ============================================================================

-- banEmail patterns: filter to text-only values.
INSERT OR IGNORE INTO role_policy_ban_emails (role_id, pattern)
SELECT role_id, je.value
  FROM role_policies, json_each(ban_email_patterns_json) AS je
  WHERE je.type = 'text';

-- availDomain patterns: filter to text-only values.
INSERT OR IGNORE INTO role_policy_avail_domains (role_id, pattern)
SELECT role_id, je.value
  FROM role_policies, json_each(avail_domain_patterns_json) AS je
  WHERE je.type = 'text';

-- ============================================================================
-- 3. Rebuild role_policies as metadata-only.
-- ============================================================================

CREATE TABLE role_policies_new (
  role_id    TEXT PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO role_policies_new (role_id, updated_by, updated_at)
SELECT role_id, updated_by, updated_at FROM role_policies;

DROP TABLE role_policies;

ALTER TABLE role_policies_new RENAME TO role_policies;

-- ============================================================================
-- 4. Migration tracking — atomic with the schema change (F1).
-- ============================================================================

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0019_role_policy_normalize.sql');