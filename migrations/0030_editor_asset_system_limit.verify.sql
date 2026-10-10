SELECT '0030_storage_ceiling' AS assertion, COUNT(*) = 1 AS pass
  FROM sqlite_master WHERE name = 'editor_assets' AND sql LIKE '%104857600%';
SELECT '0030_usage_fk' AS assertion, COUNT(*) = 1 AS pass
  FROM pragma_foreign_key_list('editor_asset_usages') WHERE "table" = 'editor_assets' AND on_delete = 'RESTRICT';
SELECT '0030_pending_quota' AS assertion, COUNT(*) = 1 AS pass
  FROM sqlite_master WHERE type = 'trigger' AND name = 'editor_assets_pending_quota';
SELECT '0030_tracking' AS assertion, COUNT(*) = 1 AS pass
  FROM d1_migrations WHERE name = '0030_editor_asset_system_limit.sql';
PRAGMA foreign_key_check;
