# CAP-004 — Initial D1 schema + migration runner

**Phase:** 0 · **Status:** In Progress · **Started:** 2026-08-12

## Goal

`migrations/0001_initial.sql` creates the 11 Phase 0 tables (`installation_state`, `system_settings`, `users`, `sessions`, `encrypted_credentials`, `permissions`, `roles`, `role_permissions`, `user_roles`, `audit_events`, `maintenance_jobs`) with `PRAGMA foreign_keys = ON` (`R-DATA-004`), `COLLATE NOCASE` on email columns (`R-DATA-001`), the four-column PBKDF2 password shape per ADR-006, AES-GCM ciphertext columns per ADR-007, soft-delete columns per `data-model.md`, and indexes that match the access patterns the module skeletons imply. `migrations/0001_initial.verify.sql` proves the schema is correct. `pnpm scaffold db:migrate` runs pending migrations against a local D1 simulator with a single command. `pnpm scaffold doctor` (`schema-version` check) now actually verifies the recorded schema version against the highest-numbered migration.

## Scope

- **`migrations/0001_initial.sql`** — the canonical schema. Tables, indexes, FK constraints. ~250 lines.
- **`migrations/0001_initial.verify.sql`** — a SQL script that returns one row per assertion; `pnpm scaffold db:migrate --verify` (or the same script run directly) consumes it.
- **`migrations/0001_initial.md`** — the documented purpose, compatibility window, expected duration, backfill strategy, verification queries, and recovery procedure (per `data-model.md` §Migration file shape).
- **Drizzle typed schemas** for the 11 tables at `apps/worker/src/database/schema/<owner>.ts` (one file per owning module: `identity.ts`, `onboarding.ts`, `admin.ts`, `outbound-mail.ts`). These are typing only — the deployable artifact is the SQL.
- **Migration runner** at `scripts/db-migrate.ts`. Reads `migrations/*.sql` in lexicographic order, checks the tracking table `d1_migrations` (managed by wrangler's native migration support, not by us), applies pending, runs the `.verify.sql` companion on each applied migration, and exits non-zero on any failure.
- **`pnpm scaffold` subcommand** `db:migrate` wired in `scripts/scaffold.ts`. Routes `db:migrate` to `scripts/db-migrate.ts`.
- **Tracking table** — wrangler's native `d1_migrations` table. We do **not** create our own tracking table.
- **Test fixture helper** in `packages/test-kit`: `migrationsDb()` — returns a fresh, in-memory D1 simulator (via `@cloudflare/vitest-pool-workers`) with `0001_initial.sql` already applied. Used by every later capability that needs D1 in tests.
- **Doctor update** — `scripts/doctor.ts` `schema-version` check now reads the highest-numbered migration filename and asserts the recorded `installation_state.schema_version` matches it. Until CAP-006 lands the `installation_state` row, this check is satisfied by a stub row injected by the migration runner.
- **`drizzle-kit`** — install as a devDependency at the root; used to generate future migration diffs from the typed schemas. CAP-004 does NOT generate migrations via drizzle-kit — that workflow lands with CAP-004b if needed; for now SQL is hand-written and Drizzle is read-only.

## Tables in `0001_initial.sql`

Per `.claude/rules/architecture.md` §Persistence ownership:

| Owner | Table | Notes |
|---|---|---|
| onboarding | `installation_state` | Single-row table. Status: `'setup' | 'complete'`. `current_step`: `'claim' | 'preflight' | 'administrator' | 'domain' | 'cloudflare-verify' | 'inbound-smoke' | 'brevo' | 'outbound-smoke' | 'complete'`. `schema_version` int. |
| admin | `system_settings` | key-value (text pk). |
| identity | `users` | UUID pk. Email `COLLATE NOCASE UNIQUE`. Status `'active'|'banned'|'deleted'` per `R-AUTH-002`. PBKDF2 columns per ADR-006: `password_algorithm`, `password_iterations`, `password_salt`, `password_hash`. `deleted_at` soft-delete. |
| identity | `sessions` | UUID pk, FK users `ON DELETE CASCADE`. `refresh_token_hash` (not plaintext — `R-SECRET-005`-style rule). `expires_at` (epoch ms int). `revoked_at` nullable. |
| outbound-mail | `encrypted_credentials` | UUID pk. `name` text unique. `version` int. `ciphertext` blob (AES-GCM). `iv` blob. `auth_tag` blob. |
| admin | `permissions` | UUID pk. `key` text unique (e.g. `'message.send'`). `description` text. |
| admin | `roles` | UUID pk. `name` text unique (`'administrator'`, `'member'`, etc.). `description` text. `is_system` bool. |
| admin | `role_permissions` | composite pk `(role_id, permission_id)`. FKs `ON DELETE CASCADE`. |
| admin | `user_roles` | composite pk `(user_id, role_id)`. FKs `ON DELETE CASCADE`. `granted_at`, `granted_by`. |
| admin | `audit_events` | UUID pk. `actor_user_id` FK users nullable (system actions). `action` text. `resource_type`, `resource_id`. `request_id` text. `metadata` text (JSON-encoded — explicit exception to R-DATA-005 for *indexed* metadata; the audit log is special-cased and documented). `created_at`. |
| admin | `maintenance_jobs` | UUID pk. `kind` text. `status` `'pending'|'running'|'done'|'failed'` per `data-model.md` Index strategy. `cursor` text nullable (resumable). `attempts` int. `last_error` text nullable. `scheduled_at`, `started_at`, `completed_at`. |

Indexes:
- `users(email)` unique (already enforced by UNIQUE constraint)
- `sessions(user_id, expires_at)` — eviction query (`R-AUTH-003`)
- `audit_events(resource_type, resource_id, created_at DESC)` — per `data-model.md`
- `maintenance_jobs(status, scheduled_at)` — per `data-model.md`

`PRAGMA foreign_keys = ON` is set by the runner at the start of every connection (`R-DATA-004`). D1 enforces this at connection-level.

## Out of scope

- All Phase 1+ tables (`managed_domains`, `mailboxes`, `mailbox_members`, `messages`, `message_recipients`, `mailbox_messages`, `message_user_state`, `message_attachments`, `attachment_uploads`, `drafts`, `outbound_jobs`, `provider_connections`, `webhook_deliveries`, `provider_message_state`, `webhook_events`, `registration_keys`, `oauth_accounts`, `domain_signatures`, `idempotency_records`). Each lands in its owning capability's migration.
- The first real seed (the `administrator` role with all permissions, the `member` role with `message.{read,send,delete}` + `mailbox.{create,manage}`, etc.). Per `.claude/rules/cunding.md` Rule of One: one logical change per migration. The seed lands in `0002_seed_roles.sql` once CAP-017 is implemented.
- Drizzle-kit migration generation. CAP-004 ships the typed schemas; future migrations are still hand-written SQL until a later capability decides otherwise.
- Migration down/rollback. The migration policy (`data-model.md` §Migration policy) is "expand-and-contract"; down migrations are not used.
- CI integration. Not in any Phase 0 capability.
- The `apps/worker/src/database/db.ts` repository layer. That lands with CAP-019 (identity). CAP-004 only ships the schema.
- Soft-delete enforcement at the application layer. `deleted_at` columns exist; reads that exclude them are written by CAP-019+.

## Business rules

CAP-004 implements the *schema* for several rules. The actual *enforcement* lands in the capabilities that own those tables. The schema must be shaped so enforcement is possible without a later migration.

| Rule ID | What CAP-004 must enable |
|---|---|
| `R-AUTH-002` | `users.status` is `'active'|'banned'|'deleted'`. The CHECK constraint enforces the enum. |
| `R-AUTH-003` | `sessions(user_id, expires_at)` index enables the eviction query. |
| `R-AUTH-005` | `sessions.user_id ON DELETE CASCADE` and `password_*` columns support the revoke-all-on-password-change query. |
| `R-AUTH-009` | `users.email` is `COLLATE NOCASE`. |
| `R-DATA-001` | Email columns everywhere `COLLATE NOCASE`. |
| `R-DATA-004` | Migration runner sets `PRAGMA foreign_keys = ON` at connection open. |
| `R-DATA-005` | No JSON-in-text columns. `audit_events.metadata` is the explicit exception, documented in the migration's `.md`. |
| ADR-006 | `users.password_algorithm`, `password_iterations`, `password_salt`, `password_hash` — the four-column shape. PBKDF2-SHA256 with 600,000 iterations, salt ≥ 16 bytes. |
| ADR-007 | `encrypted_credentials.ciphertext`, `iv`, `auth_tag`, `version` — AES-GCM. |

## Acceptance criteria

- [ ] 1. `migrations/0001_initial.sql` exists, parses (no syntax errors when applied to a fresh D1), creates 11 tables, sets `PRAGMA foreign_keys = ON`, and exits clean.
- [ ] 2. `migrations/0001_initial.verify.sql` runs against the freshly-applied schema and returns one row per assertion, all of which pass.
- [ ] 3. `migrations/0001_initial.md` documents purpose, compatibility window, expected duration, backfill strategy, verification queries, recovery procedure (per `data-model.md`).
- [ ] 4. `pnpm scaffold db:migrate` runs the migration against a local D1 simulator (via `wrangler d1 execute --local`) and exits 0. The simulator must reflect the schema after the command.
- [ ] 5. Running `pnpm scaffold db:migrate` twice in a row is idempotent — second run applies 0 migrations and exits 0.
- [ ] 6. `pnpm scaffold db:migrate --verify` runs every `.verify.sql` and exits non-zero if any verification fails. Demonstrated by corrupting a table and reverting.
- [ ] 7. The migration runner detects that `wrangler d1 migrations` records a missing migration file (someone deleted `0001_initial.sql` from disk after applying) and reports it; does not silently apply a partial schema.
- [ ] 8. `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail}.ts` declare the 11 tables in Drizzle, with strict typing (`$inferSelect`, `$inferInsert` exports). The compile output has zero `any`.
- [ ] 9. `packages/test-kit` exports `migrationsDb()` — a vitest-pool-workers D1 binding with `0001_initial.sql` already applied. A test in `packages/test-kit/src/migrationsDb.test.ts` creates a `users` row, reads it back, asserts `email` is case-insensitive on lookup.
- [ ] 10. `pnpm scaffold doctor` `schema-version` check now actually verifies. Reading the source of `scripts/doctor.ts` shows it parses the highest-numbered migration filename and compares against a sentinel (e.g. a constant exported from `apps/worker/src/database/schema-version.ts`). The check passes today and is wired to break when CAP-006 changes the schema version.
- [ ] 11. No new runtime dependency in root `package.json` beyond `drizzle-kit` (devDep) and `drizzle-orm` (already a dep if any) plus the existing `wrangler` and `@cloudflare/workers-types`.
- [ ] 12. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build`, and `pnpm scaffold doctor` all exit 0.
- [ ] 13. Every `R-*` rule cited above has a test named for it: `grep -rE 'R-AUTH-002|R-DATA-001|R-DATA-004|R-DATA-005' apps packages --include='*.test.ts'` returns matches.
- [ ] 14. `drizzle-kit` config exists at `apps/worker/drizzle.config.ts` and `pnpm exec drizzle-kit check` exits 0 (the typed schemas are in sync with what a future migration would generate; for CAP-004 the schema is empty so this is a smoke).
- [ ] 15. `pnpm scaffold db:reset` exits 0 locally; refuses to run with `ENVIRONMENT !== 'local'` (verified by setting `ENVIRONMENT=preview` in the shell and observing exit 2).

## Vertical slice

- [x] migrations — `migrations/0001_initial.{sql,verify.sql,md}`
- [x] schema — `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail}.ts`
- [x] runner — `scripts/db-migrate.ts`, `scripts/scaffold.ts` extended
- [x] test fixture — `packages/test-kit/src/migrationsDb.ts`
- [x] doctor — `scripts/doctor.ts` `schema-version` updated
- [x] drizzle-kit — `apps/worker/drizzle.config.ts` (devDep only)

New module dependency edges introduced: none. The migration runner lives in `scripts/` (CAP-003 owns that directory). Drizzle schemas live in `apps/worker/src/database/` — a new directory; ownership is by table-owning module but the *files* are colocated in `database/schema/`. The actual repositories (which would import these schemas) land with their owning module capability.

## File ownership

One writer for this capability.

| Agent | Owns |
|---|---|
| implementer-1 | Everything in Scope. |

If a slice becomes too large, the orchestrator splits before delegation.

## Reading list

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/coding.md` (TS strict, no `any`, ≤ 150 lines per file)
- `.claude/rules/architecture.md` (schema ownership table, dependency direction, layered shape)
- `.claude/rules/testing.md` (real D1 in tests, naming convention for rule-id tests)
- `.claude/rules/security.md` (R-DATA-*, ADR-006 PBKDF2, ADR-007 AES-GCM, audit logging)
- `.claude/rules/git.md` (no commit, branch first)
- `docs/rebuild/05-target-architecture/data-model.md` (canonical schema rules + index strategy)
- `docs/rebuild/05-target-architecture/module-boundaries.md` (composition root shape)
- `docs/rebuild/02-business-discovery/business-rules.md` (R-AUTH, R-DATA, R-SECRET, R-MAILBOX)
- `docs/rebuild/09-decisions/` — at minimum the ADR for password hashing (ADR-006) and secrets (ADR-007); use the file names that exist
- `apps/worker/wrangler.jsonc` (binding names, `migrations_dir`)
- `scripts/doctor.ts` (the `schema-version` check to update)
- `scripts/scaffold.ts` (the dispatcher to extend)
- `packages/test-kit/src/index.ts` (where `migrationsDb()` will be exported)

Do not read other `docs/` files.

## Dependencies

- Requires: CAP-001 (workspace, wrangler config), CAP-002 (test harness, vitest-pool-workers), CAP-003 (doctor harness)
- Blocks: CAP-005 (deploy — needs migrations to apply on a fresh D1), CAP-006 onward (every capability that touches the schema)

## Decisions made during this capability

| Decision | Options | Default if no answer |
|---|---|---|
| Number of tables in `0001_initial.sql` | 11 (everything Phase 0 needs) vs split into 2 migrations | 11 — they are conceptually one "create the schema" event; later migrations are incremental |
| Audit metadata storage | text (JSON) vs relational | text (JSON) — explicit exception to R-DATA-005, documented in the .md. The audit log is the canonical "free-form payload" exception; if a future capability needs to query audit metadata relationally, a migration adds columns |
| Soft-delete columns | every table has `deleted_at` | only on `users` for now. `mailboxes`, `messages`, etc. get `deleted_at` when their owning capability lands |
| Cascading FKs | CASCADE everywhere vs SET NULL on some | CASCADE for hard ownership (user → sessions), SET NULL for soft references (audit_events.actor_user_id → users) |
| Migration tracking | wrangler native vs custom table | wrangler native (`d1_migrations`). Custom table would double the work |
| Test fixture location | `packages/test-kit/src/migrationsDb.ts` (new export) vs `apps/worker/test/migrationsDb.ts` | `packages/test-kit` — the spec says fixtures live there |

## Open questions

Blockers needing the operator.

1. Is the explicit JSON-in-text exception for `audit_events.metadata` acceptable, or should CAP-004 split metadata into separate columns even though no current rule queries them relationally? Default: text (JSON) with a documented exception in the .md; revisit if a future capability needs relational metadata.
2. Should the migration runner support `pnpm scaffold db:reset` (drop and re-create all tables) for local dev? Default: yes — common dev-tool affordance, exits 0, refuses to run if `ENVIRONMENT !== 'local'` (per `R-DATA-007`-style guard).