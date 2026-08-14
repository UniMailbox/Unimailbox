-- migrations/0010_blocklist_and_role_policies.sql — D-CAP-021 / CAP-035.
-- Adds inbound blocklist (R-INBOUND-005) and per-role policies (R-INBOUND-006).
--
-- Rules enforced:
--   R-INBOUND-005  Blocklist matches on subject, content, and from. Three `kind`
--                  values: 'subject' | 'content' | 'from'. Pattern is a
--                  case-insensitive substring (no regex in v1 — substring
--                  only per Decision Q1).
--   R-INBOUND-006  Per-role availDomain and banEmail policies. banEmail matches
--                  exact email, `@domain`, or `*`. availDomain matches
--                  `@domain`. Empty availDomain list means allow all (BF-100).
--   R-DATA-005     RELAXATION: ban_email_patterns_json and
--                  avail_domain_patterns_json are TEXT JSON. DEFERRED: BF-099/100
--                  patterns are syntactic-only; no per-element business query.
--                  Plan to normalize in a follow-up capability that audits all
--                  JSON-in-text columns at once (CAP-036 JSON-AUDIT — to be
--                  scheduled).
--   R-AUTHZ-005    Admin identity from user_roles (role_id FK below).
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the schema change (see 0001_initial.md §F1).

CREATE TABLE IF NOT EXISTS blocklist_entries (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('subject', 'content', 'from')),
  pattern     TEXT    NOT NULL CHECK (length(pattern) BETWEEN 1 AND 512),
  created_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Listing the active blocklist (admin GET /api/v1/admin/blocklist) reads
-- ORDER BY created_at DESC; the index supports that without a full scan.
CREATE INDEX IF NOT EXISTS blocklist_entries_created_at_idx
  ON blocklist_entries(created_at);

-- ----------------------------------------------------------------------------
-- role_policies — one row per role. banEmail + availDomain patterns are
-- stored as TEXT JSON for v1 (R-DATA-005 relaxation; see comment above).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_policies (
  role_id                    TEXT    PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
  ban_email_patterns_json    TEXT    NOT NULL DEFAULT '[]' CHECK (length(ban_email_patterns_json) <= 65536),
  avail_domain_patterns_json TEXT    NOT NULL DEFAULT '[]' CHECK (length(avail_domain_patterns_json) <= 65536),
  updated_by                 TEXT    REFERENCES users(id) ON DELETE SET NULL,
  updated_at                 TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0010_blocklist_and_role_policies.sql');