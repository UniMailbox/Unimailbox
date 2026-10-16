SELECT '0038_receipts_table' AS assertion, COUNT(*) = 1 AS pass FROM sqlite_master WHERE type='table' AND name='inbound_receipts';
SELECT '0038_receipts_indexes' AS assertion, COUNT(*) = 4 AS pass FROM sqlite_master WHERE type='index' AND name IN ('inbound_receipts_pending_idx', 'inbound_receipts_processing_idx', 'inbound_receipts_completed_idx', 'inbound_receipts_incomplete_age_idx');
SELECT '0038_receipts_states' AS assertion, COUNT(*) = 0 AS pass FROM inbound_receipts WHERE status NOT IN ('pending', 'processing', 'completed');
SELECT '0038_receipts_references' AS assertion, COUNT(*) = 0 AS pass FROM inbound_receipts r LEFT JOIN mailboxes m ON m.id=r.mailbox_id WHERE m.id IS NULL;
SELECT '0038_receipts_completion' AS assertion, COUNT(*) = 0 AS pass FROM inbound_receipts r LEFT JOIN messages m ON m.id=r.id WHERE r.status='completed' AND m.id IS NULL;
SELECT '0038_receipts_registered' AS assertion, COUNT(*) = 1 AS pass FROM d1_migrations WHERE name='0038_inbound_receipts.sql';
