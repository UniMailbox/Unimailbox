# 0010 mvp minimum seed

- Purpose: Trim the 22-key seed introduced by `0002_seed_permissions.sql` to the five permission keys the M1 administrator actually carries; drop the `member` role until M2 (issue #23) restores it.
- Compatibility window: Worker releases from installation version 1 onward. The five MVP keys are additive-compatible with the contracts package's `ADMINISTRATOR_PERMISSIONS` set in PR #31.
- Expected duration: under one second on a populated D1 (single `DELETE`/`INSERT OR IGNORE`).
- Backfill: none. Operates on existing rows only.
- Verification: `migrations/meta/0010_mvp_minimum_seed.verify.sql` asserts `permissions` has exactly 5 rows, `roles` has exactly 1 row, and `role_permissions` has exactly 5 rows.
- Recovery: fix forward with a new migration; never edit this file after release.
