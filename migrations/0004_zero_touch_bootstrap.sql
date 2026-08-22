PRAGMA foreign_keys = ON;

-- M1 cut (see docs/architecture/mvp-blueprint.md §3.3 and issue #17):
-- the checkpoint catalog is created but no rows are seeded. The MCP/tracing
-- surface that consumes these rows is wired in M5 (issue #26). Leaving the
-- table empty keeps the schema in place so 0011_mvp_minimum.sql
-- (formerly 0010 per blueprint) can restore the seed without recreating it.
CREATE TABLE configuration_checkpoints (
  checkpoint_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'configured', 'verified', 'failed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

UPDATE installation_state
SET installation_version = 2,
    current_step = CASE
      WHEN status = 'complete' THEN 'complete'
      ELSE 'admin_bootstrap'
    END,
    completed_steps_json = CASE
      WHEN status = 'complete' THEN '["admin_bootstrap"]'
      ELSE '[]'
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;
