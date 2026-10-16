SELECT '0039_attempts_table' AS assertion, COUNT(*)=1 AS pass FROM sqlite_master WHERE type='table' AND name='outbound_send_attempts';
SELECT '0039_retry_column' AS assertion, COUNT(*)=1 AS pass FROM pragma_table_info('outbound_jobs') WHERE name='next_attempt_at';
SELECT '0039_attempt_indexes' AS assertion, COUNT(*)=4 AS pass FROM sqlite_master WHERE type='index' AND name IN ('outbound_one_unresolved_attempt','outbound_attempts_job_idx','outbound_attempts_reconcile_idx','outbound_jobs_next_attempt_idx');
SELECT '0039_attempt_acceptance' AS assertion, COUNT(*)=0 AS pass FROM outbound_send_attempts WHERE status='accepted' AND (provider_message_id IS NULL OR accepted_at IS NULL);
SELECT '0039_attempt_foreign_keys' AS assertion, COUNT(*)=0 AS pass FROM outbound_send_attempts a LEFT JOIN outbound_jobs j ON j.id=a.job_id WHERE j.id IS NULL;
SELECT '0039_unknown_fenced' AS assertion, COUNT(*)=0 AS pass FROM outbound_jobs j WHERE j.status='sending' AND j.error_code='SEND_OUTCOME_UNKNOWN' AND NOT EXISTS(SELECT 1 FROM outbound_send_attempts a WHERE a.job_id=j.id AND a.status IN ('submitted','unknown','accepted'));
SELECT '0039_attempt_registered' AS assertion, COUNT(*)=1 AS pass FROM d1_migrations WHERE name='0039_outbound_send_attempts.sql';
