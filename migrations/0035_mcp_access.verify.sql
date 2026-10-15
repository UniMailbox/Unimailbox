SELECT '0035_disabled_configuration_available' AS assertion, COUNT(*) = 1 AS pass FROM mcp_configuration WHERE id='system' AND revision >= 0 AND enabled IN (0,1) AND allow_send IN (0,1) AND requests_per_minute BETWEEN 1 AND 120;
SELECT '0035_tables' AS assertion, COUNT(*) = 4 AS pass FROM sqlite_master WHERE type='table' AND name IN ('mcp_configuration','mcp_tokens','mcp_token_mailboxes','mcp_rate_windows');
SELECT '0035_hashed_token' AS assertion, COUNT(*) = 1 AS pass FROM pragma_table_info('mcp_tokens') WHERE name='token_hash' AND "notnull"=1;
SELECT '0035_tracking' AS assertion, COUNT(*) = 1 AS pass FROM d1_migrations WHERE name='0035_mcp_access.sql';
PRAGMA foreign_key_check;
