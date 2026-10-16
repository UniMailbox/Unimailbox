SELECT '0040_mail_query_indexes' AS assertion, COUNT(*)=3 AS pass FROM sqlite_master WHERE type='index' AND name IN ('outbound_jobs_created_at_idx','inbound_receipts_created_at_idx','editor_asset_usages_resource_idx');
SELECT '0040_registered' AS assertion, COUNT(*)=1 AS pass FROM d1_migrations WHERE name='0040_mail_analytics_indexes.sql';
