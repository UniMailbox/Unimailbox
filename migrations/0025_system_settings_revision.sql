-- migrations/0025_system_settings_revision.sql — CAP-069.
--
-- Seed one internal compare-and-swap row in the existing system_settings
-- table. It is not part of the public settings projection; the Worker uses
-- it to reject stale full-document updates atomically.

INSERT INTO system_settings (key, value, updated_at, created_at)
VALUES ('settings_revision', '1', '1970-01-01 00:00:00', '1970-01-01 00:00:00')
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0025_system_settings_revision.sql');
