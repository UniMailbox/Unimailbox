SELECT CASE
  WHEN (
    -- The two attachment triggers from 0001 must be absent after 0011.
    SELECT COUNT(*) FROM sqlite_schema
     WHERE type = 'trigger' AND name IN (
       'validate_attachment_upload', 'consume_attachment_upload'
     )
  ) = 0
  -- The two dead indexes (idempotent re-run target).
  AND (
    SELECT COUNT(*) FROM sqlite_schema
     WHERE type = 'index' AND name IN (
       'idx_attachment_files_md5_size',
       'idx_message_attachments_md5'
     )
  ) = 0
  -- The MD5 backfill job enqueued by 0007 must be removed.
  AND (
    SELECT COUNT(*) FROM maintenance_jobs
     WHERE job_key = 'attachment-md5-backfill'
  ) = 0
  -- The dedup catalog is created (🟡 per blueprint §3.1) but empty in M1.
  AND (
    SELECT COUNT(*) FROM attachment_files
  ) = 0
  -- 0010_mvp_minimum_seed.sql is upstream of this file; trust its
  -- acceptance check (5 permissions / 1 role / 5 role_permissions).
  THEN 1
  ELSE 0
END AS migration_verified;
PRAGMA foreign_key_check;
