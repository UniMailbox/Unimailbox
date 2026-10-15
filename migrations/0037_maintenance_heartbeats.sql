-- Bounded operational snapshots; failed task names remain relational (R-DATA-005).
CREATE TABLE IF NOT EXISTS maintenance_heartbeats (
  cadence TEXT PRIMARY KEY CHECK (cadence IN ('frequent', 'hourly', 'daily')),
  request_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  legacy_imported INTEGER NOT NULL DEFAULT 0 CHECK (legacy_imported IN (0, 1)),
  initialized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS maintenance_heartbeat_failures (
  cadence TEXT NOT NULL REFERENCES maintenance_heartbeats(cadence) ON DELETE CASCADE,
  task_name TEXT NOT NULL,
  PRIMARY KEY (cadence, task_name)
);
INSERT OR IGNORE INTO maintenance_heartbeats(cadence) VALUES ('frequent'), ('hourly'), ('daily');
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0037_maintenance_heartbeats.sql');
