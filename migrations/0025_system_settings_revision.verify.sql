-- migrations/0025_system_settings_revision.verify.sql — CAP-069.

SELECT '0025_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0025_system_settings_revision.sql';

SELECT '0025_revision_row_shape' AS assertion,
  COUNT(*) = 1 AS pass
FROM system_settings
WHERE key = 'settings_revision'
  AND value = '1'
  -- Settings updates advance this compare-and-swap timestamp. The seed
  -- timestamp is only an initial-state expectation, not a live invariant.
  AND datetime(updated_at) IS NOT NULL
  AND updated_at >= '1970-01-01 00:00:00';
