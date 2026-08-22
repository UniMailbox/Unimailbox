# 0014 Better Auth additive substrate

This migration adds the database shape accepted by CAP-042 and ADR-008. Repository SQL remains the
deployment authority; Better Auth schema generation is comparison input only.

## Compatibility and upgrade

- Canonical `users.id`, RBAC references, legacy PBKDF2 columns, and legacy `sessions` remain intact.
- `email_verified` is additive and defaults existing users to unverified. `image` is nullable.
- Existing null or blank `display_name` values are backfilled from the email prefix. Insert/update
  triggers apply the same deterministic, 100-character-capped fallback to future legacy writes.
- Better Auth credentials, cookie sessions, and verification records use separate
  `auth_accounts`, `auth_sessions`, and `auth_verifications` tables.
- New auth-table dates are integer epoch milliseconds. Canonical user dates remain SQLite text.

The Workers migration test applies through 0013, inserts legacy identity/session data, then applies
0014 and proves IDs, passwords, and legacy sessions are unchanged.

## Invariants

- Account and session ownership cascades from canonical users.
- `(issuer, account_id)` and session tokens are unique.
- A deterministic insert trigger retains the newest ten auth sessions per user by
  `created_at DESC, id DESC`.
- Updating an account password revokes that user's auth sessions in the same SQLite statement
  transaction.
- Incrementing an exhausted registration key raises `CAP042_REGISTRATION_KEY_EXHAUSTED`, causing
  the surrounding D1 batch to roll back.

## Repeat and rollback

The migration runner uses `d1_migrations` to skip the non-repeatable `ALTER TABLE` statements after
the first successful application. The test fixture applies the current set twice and proves one
tracking row and unchanged data.

Application rollback is safe: legacy credentials and sessions are retained, and an older
`AUTH_PROVIDER=legacy` build can ignore the new columns/tables/triggers. Schema rollback is not a
drop operation; the additive substrate remains until a separately reviewed cleanup migration.
CAP-042 performs no destructive legacy cleanup.
