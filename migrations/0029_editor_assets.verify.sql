SELECT '0029_asset_tables' AS assertion, COUNT(*) = 2 AS pass
  FROM sqlite_master
 WHERE type = 'table' AND name IN ('editor_assets', 'editor_asset_usages');

SELECT '0029_durable_usage_fk' AS assertion, COUNT(*) = 1 AS pass
  FROM pragma_foreign_key_list('editor_asset_usages')
 WHERE "table" = 'editor_assets' AND "from" = 'asset_id' AND on_delete = 'RESTRICT';

SELECT '0029_asset_indexes' AS assertion, COUNT(*) = 2 AS pass
  FROM sqlite_master
 WHERE type = 'index' AND name IN ('editor_assets_pending', 'editor_assets_owner');

SELECT '0029_pending_quota_trigger' AS assertion, COUNT(*) = 1 AS pass
  FROM sqlite_master
 WHERE type = 'trigger' AND name = 'editor_assets_pending_quota';

SELECT '0029_tracking_row' AS assertion, COUNT(*) = 1 AS pass
  FROM d1_migrations WHERE name = '0029_editor_assets.sql';
