SELECT '0032_cleanup_column' AS assertion, COUNT(*) = 1 AS pass FROM pragma_table_info('attachment_uploads') WHERE name='cleanup_completed_at' AND type='TEXT' AND "notnull"=0;
SELECT '0032_cleanup_index' AS assertion, COUNT(*) = 1 AS pass FROM sqlite_master WHERE type='index' AND name='attachment_uploads_cleanup_pending_idx' AND sql LIKE '%cleanup_completed_at IS NULL%';
SELECT '0032_tracking' AS assertion, COUNT(*) = 1 AS pass FROM d1_migrations WHERE name='0032_attachment_cleanup.sql';
PRAGMA foreign_key_check;
