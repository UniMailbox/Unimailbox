-- Expand-and-contract migration. Add reviewed SQL below.
PRAGMA foreign_keys = ON;

-- M1 cut (issue #18, formerly blueprint's 0010_mvp_minimum.sql):
-- neutralise the active side-effects of 0007 (attachment dedup pipeline)
-- and 0009 (scheduled-send flag surface) without rewriting the app
-- callers that still reference 0007's columns. Companion migrations:
--   0002 → trimmed by 0010_mvp_minimum_seed.sql (issue #16, PR #32).
--   0004 → trimmed inline by issue #17.
--   This file handles the physical-schema deactivation.
--
-- What gets DROPPED vs left dormant:
--   * DROP — the two attachment triggers from 0001, the backfill job
--     entry, the attachment_files rows, and the two 0007 indexes that
--     are no longer reachable. All four are runtime constructs that
--     side-effect behaviour or just clutter.
--   * LEFT DORMANT — the `file_id` / `md5` columns added by 0007 on
--     attachment_uploads / message_attachments, and the
--     `created_via_schedule` column added by 0009 on outbound_jobs.
--     ~17 callsites in apps/worker/src reference these columns; rather
--     than rewrite every caller (out of scope for the M1 cut) we keep
--     them inert. M6 (issue #27, attachment dedup) and M7 (issue #28,
--     scheduled send) re-read these columns and restore the runtime
--     behaviour without further schema work.
--
-- Idempotency: trigger / index drops use IF EXISTS, the DELETE steps
-- are naturally idempotent. The column-presence assumption is that
-- the standard chain includes 0001..0009 before 0011; running this
-- file against a partial chain is intentionally out of scope.

-- 0007 surface — attachment dedup
DROP TRIGGER IF EXISTS validate_attachment_upload;
DROP TRIGGER IF EXISTS consume_attachment_upload;

-- 0007 indexes — orphaned once the columns (and their consumers) are
-- cut from the runtime path. M6 resurrection (issue #27) recreates
-- them. We drop the two that reference dormant columns; the
-- `idx_message_attachments_filename` index references the live
-- `filename` column and stays.
DROP INDEX IF EXISTS idx_attachment_files_md5_size;
DROP INDEX IF EXISTS idx_message_attachments_md5;

-- Drop the legacy-attachment MD5 backfill enqueued by 0007.
DELETE FROM maintenance_jobs WHERE job_key = 'attachment-md5-backfill';

-- 0007 surface — drop the dedup catalog contents. The attachment_files
-- schema is preserved (🟡 per blueprint §3.1) but empty in M1.
DELETE FROM attachment_files;
