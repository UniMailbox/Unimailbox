SELECT '0028_table' AS assertion, COUNT(*) = 1 AS pass
  FROM sqlite_master WHERE type = 'table' AND name = 'inbound_message_attachments';

SELECT '0028_message_index' AS assertion, COUNT(*) = 1 AS pass
  FROM sqlite_master WHERE type = 'index' AND name = 'inbound_message_attachments_message_idx';

SELECT '0028_tracking' AS assertion, COUNT(*) = 1 AS pass
  FROM d1_migrations WHERE name = '0028_inbound_attachments.sql';
