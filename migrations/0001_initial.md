# 0001_initial — Phase 0 schema (11 tables)

## Purpose

Authoritative D1 schema for every Phase 0 capability. Creates the 11 tables
the installer, identity, outbound-mail and admin code paths read and write.
Hand-written SQL — Drizzle schemas in `apps/worker/src/database/schema/*` are
typing only and must never be used to regenerate this file. See
`docs/rebuild/05-target-architecture/data-model.md` §Migration authority.

Owners (per `.claude/rules/architecture.md` §Persistence ownership):

| Owner | Table |
|---|---|
| onboarding | `installation_state` |
| admin | `system_settings`, `permissions`, `roles`, `role_permissions`, `user_roles`, `audit_events`, `maintenance_jobs` |
| identity | `users`, `sessions` |
| outbound-mail | `encrypted_credentials` |

## Compatibility window

- **Backward-compatible (additive)** — every table is new. The migration
  cannot break an existing deployment because Phase 0 is the first migration
  ever applied.
- **Forward-incompatible** — future migrations that depend on the column
  shapes here must preserve them. In particular:
  - `users.password_*` — four columns (algorithm, iterations, salt, hash)
    per ADR-006. Do not collapse to a single hash column or JSON blob.
  - `encrypted_credentials.{ciphertext, iv, auth_tag, version}` — AES-GCM
    columns per ADR-007. Do not fold `auth_tag` into `ciphertext` (GCM
    implementations vary in tag location).
  - `audit_events.metadata` is `TEXT` holding JSON. This is the explicit
    exception to `R-DATA-005` documented below; do not promote it to a
    relational shape without an ADR.

## Expected duration

Single-digit milliseconds against a fresh local D1 simulator. Production D1
apply time is dominated by the round-trip; first-time apply against an empty
DB is essentially free.

## Data-backfill strategy

None — Phase 0 starts from an empty D1. Seed rows (the `administrator` role,
the `member` role, the permission catalog) land in `0002_seed_roles.sql`
once CAP-017 implements them. The schema is shaped to accept those seeds
without a future migration.

## Explicit exception to R-DATA-005

`audit_events.metadata` is declared `TEXT` and is meant to hold a JSON
payload. `R-DATA-005` forbids JSON-in-text columns; the audit log is the
canonical exception because:

1. The audit log is **append-only** and queried only by `request_id` and
   `actor_user_id` indexes, never by metadata keys.
2. Schema-locking the audit shape now would freeze the contract for every
   future capability before they exist.
3. If a future capability needs to query metadata relationally (e.g.
   "find every password-reset audit in the last 30 days"), the proper move
   is a follow-up migration that adds dedicated columns. The existing
   `metadata` JSON stays for backward compatibility.

This exception is the only one. Every other table is relational.

## Verification queries

The companion `0001_initial.verify.sql` runs these checks automatically.
Manual sanity queries (for one-off `wrangler d1 execute --command`):

```sql
-- 11 tables exist
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;

-- users.email is COLLATE NOCASE
SELECT sql FROM sqlite_master WHERE type='table' AND name='users';

-- PBKDF2 columns are present (ADR-006)
SELECT name FROM pragma_table_info('users')
WHERE name LIKE 'password_%' ORDER BY name;
-- password_algorithm, password_hash, password_iterations, password_salt

-- AES-GCM columns are present (ADR-007)
SELECT name FROM pragma_table_info('encrypted_credentials')
WHERE name IN ('ciphertext','iv','auth_tag','version') ORDER BY name;

-- PRAGMA foreign_keys is ON (R-DATA-004)
PRAGMA foreign_keys;
-- expected: 1

-- CASCADE on hard ownership FKs (sessions → users)
SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions';
-- expected: ... REFERENCES users(id) ON DELETE CASCADE ...

-- Indexes per data-model.md §Index strategy
SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events';
-- audit_events_actor_idx, audit_events_created_idx, audit_events_resource_idx
```

## Recovery procedure

1. **Local (`wrangler d1 execute --local`)** — delete
   `apps/worker/.wrangler/state/v3/d1/*` and re-run
   `pnpm scaffold db:migrate`. The runner uses `wrangler d1 migrations
   apply DB --local --persist-to ...` so the on-disk path is the only
   source of truth.
2. **Production** — open the most recent D1 Time Travel bookmark
   (`docs/rebuild/05-target-architecture/data-model.md` §Migration policy),
   restore to it, then re-run the migration from a fresh state. The
   Time Travel bookmark is taken **before** every production migration
   per `data-model.md` §Migration policy.
3. **Verification failure mid-apply** — `wrangler d1 migrations apply`
   rolls back the failing migration automatically. Re-run
   `pnpm scaffold db:migrate --verify` once the SQL is corrected.

## Foreign-key actions at a glance

| Child → Parent | Action | Reason |
|---|---|---|
| `sessions.user_id → users.id` | CASCADE | R-AUTH-005 revoke-all-on-delete |
| `role_permissions.role_id → roles.id` | CASCADE | role deletion removes the join |
| `role_permissions.permission_id → permissions.id` | CASCADE | permission deletion removes the join |
| `user_roles.user_id → users.id` | CASCADE | user deletion removes the grant |
| `user_roles.role_id → roles.id` | CASCADE | role deletion removes the grant |
| `user_roles.granted_by → users.id` | SET NULL | keep grant history if granter is deleted |
| `audit_events.actor_user_id → users.id` | SET NULL | system actions have no actor |

## Companion files

- `0001_initial.sql` — the schema itself.
- `0001_initial.verify.sql` — assertions run by the migration runner.
- `scripts/db-migrate.ts` — the runner that applies and verifies.
- `apps/worker/src/database/schema/*` — Drizzle typing declarations.

## Migration tracking convention (F1)

The `d1_migrations` table is created and populated by each migration's
SQL itself, in the **same** D1 batch as the schema. A batch is one
`wrangler d1 execute --file=<NNNN_*.sql>` invocation, which D1 commits
atomically: either the schema AND its tracking row land, or neither
does. A crash mid-batch rolls back both halves.

Every migration that ships after 0001 must follow the same shape at the
end of the file:

```sql
CREATE TABLE IF NOT EXISTS d1_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE CHECK (length(name) <= 256),
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('<NNNN_*.sql>');
```

`INSERT OR IGNORE` is used (not bare `INSERT`) so a re-run after a
half-applied state does not fail with `UNIQUE constraint failed`. The
runner additionally short-circuits already-applied files by reading
`d1_migrations` first (see `scripts/db-migrate.ts`).

## Deferred schema decisions

- **D-CAP-004-A** — `users.password_iterations` CHECK floor is `100000`,
  not ADR-006's `600000`. The exact iteration count lives in the
  application layer (CAP-019, user registration) so it can be raised
  later without a migration. The 100000 SQL floor is the lower bound
  enforced at the DB layer.