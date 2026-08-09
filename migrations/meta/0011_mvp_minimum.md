# 0011 mvp minimum

- Purpose: Strip the M1-irrelevant physical-schema artefacts left behind by `0007_attachment_file_catalog.sql` and `0009_outbound_jobs_scheduled_origin.sql`. Companion to `0010_mvp_minimum_seed.sql` (issue #16 / PR #32) and the inline trim of `configuration_checkpoints` seeds in `0004_zero_touch_bootstrap.sql` (issue #17).
- Compatibility window: Worker releases from installation version 1 onward. The mutations are idempotent for repeated apply on a state already migrated through this file; re-applying on an instance that never ran 0007/0009 will surface the absent-column `ALTER` as a D1 error, which is intentional.
- Expected duration: under 100 ms on a populated D1 (single-shot DDL plus a small DELETE).
- Backfill: none. The MD5 backfill enqueued by 0007 (`maintenance_jobs` row keyed `attachment-md5-backfill`) is removed in the same statement so a future M6 resurrection (issue #27) can re-enqueue cleanly.
- Verification: `migrations/meta/0011_mvp_minimum.verify.sql` queries `sqlite_master` + `pragma_table_info` to assert that the dropped triggers, the dropped columns, and the empty dedup table are all in place.
- Recovery: fix forward with a new migration; never edit this file after release.

Carries forward the deprecated filename note from PR #32: this was originally `0010_mvp_minimum.sql` per the blueprint; #16 took the 0010 slot, so this file uses `0011`. The post-M1 blueprint freeze (issue #22) catches up the references.
