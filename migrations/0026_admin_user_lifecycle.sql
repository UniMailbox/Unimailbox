-- migrations/0026_admin_user_lifecycle.sql
-- CAP-A1: application-owned user lifecycle.
--
-- Password lifecycle state belongs to the canonical users table. Values are
-- UTC instants (SQLite text timestamps use YYYY-MM-DD HH:mm:ss UTC, matching
-- the rest of the application schema).

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
  CHECK (must_change_password IN (0, 1));

ALTER TABLE users ADD COLUMN initial_password_expires_at TEXT;

CREATE INDEX IF NOT EXISTS users_initial_password_expiry_idx
  ON users(must_change_password, initial_password_expires_at);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0026_admin_user_lifecycle.sql');
