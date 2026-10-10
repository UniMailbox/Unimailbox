# 0031 — own-account preferences

- Purpose: add relational per-user display preferences, optional default mailbox
  and private-avatar metadata. No existing user or mailbox rows are rewritten.
- Compatibility: additive table; deploy migration before the application. New
  application schema sentinel requires 0031. No data backfill is required; reads
  supply defaults until an account saves preferences.
- Verification: run `0031_user_preferences.verify.sql` as read commands and inspect
  its four passing assertions plus empty `PRAGMA foreign_key_check` results. The
  test-kit migration loader and Worker sentinel include 0031.
- Staging: exported D1 backup before applying only this pending migration. Do not
  replay historical migrations or the default config's placeholder bindings.
- Recovery: retain the additive table for a source rollback. A database restore
  is an explicit operation from the verified backup/Time Travel after assessing
  subsequent writes. Do not automatically drop the table or delete R2 objects.
