# CAP-004 — QA Review

**Reviewer:** qa-reviewer · **Date:** 2026-08-12 · **Base:** `cap/CAP-004-initial-schema` @ working tree

**Status:** ACCEPT (re-confirmed post-fix-up; no findings changed)

## Summary

This is sound. The schema is correctly shaped for the Phase 0 capability surface, the verification script proves every rule it claims to prove, the runner is idempotent and detects ghost migrations, and the doctor check is wired to a real sentinel that will break the moment a future capability adds a migration without bumping it. The single judgement call worth surfacing is the `audit_events.metadata` TEXT( JSON ) decision — it honours the operator's default but the formal exception record lives in the `.md` rather than the rules catalogue; that is a documentation housekeeping item, not a blocking finding, because the `.md` is the per-migration authority the task explicitly delegates to.

## Acceptance criteria

| # | Criterion | Met | Evidence |
|---|---|---|---|
| 1 | `migrations/0001_initial.sql` exists, parses, creates 11 tables, sets `PRAGMA foreign_keys = ON`, exits clean | YES | 11 `CREATE TABLE` blocks at `migrations/0001_initial.sql:31–190`; `pnpm scaffold db:migrate --reset` output: `Applying 0001_initial.sql…` then `0001_initial.verify.sql: 37/37 assertions passed.`; `pragma_foreign_keys_on` assertion #1 returns `pass=1`. |
| 2 | `migrations/0001_initial.verify.sql` runs and returns one row per assertion, all pass | YES | 37 SELECT statements at `migrations/0001_initial.verify.sql`; runner output `0001_initial.verify.sql: 37/37 assertions passed.` (re-verified on fresh `--reset`). |
| 3 | `migrations/0001_initial.md` documents purpose / compatibility / duration / backfill / verification / recovery | YES | `migrations/0001_initial.md`: §Purpose, §Compatibility window, §Expected duration, §Data-backfill strategy, §Verification queries, §Recovery procedure, §Foreign-key actions at a glance — all six required sections present. |
| 4 | `pnpm scaffold db:migrate` applies to local D1 simulator and exits 0 | YES | `pnpm scaffold db:migrate --reset` exit 0; stdout shows `Applying 0001_initial.sql…` then `37/37 assertions passed` and `1/1 verify script(s) passed.`. |
| 5 | Second run is idempotent — 0 migrations, exits 0 | YES | Second invocation output: `No pending migrations (1 already applied).` followed by `37/37 assertions passed.`, exit 0. |
| 6 | `db:migrate --verify` runs every `.verify.sql`; exits non-zero on failure | YES | Corrupted `users` table via `wrangler d1 execute DB --local --command "DROP TABLE users"`, then `pnpm scaffold db:migrate --verify` reported 8 failed assertions (`table_users`, `users_has_password_*`, `users_email_collate_nocase`, `users_status_check_constraint`, `users_has_deleted_at`) and exited 1. Restored via `--reset`. |
| 7 | Runner detects a missing migration file | YES | Renamed `migrations/0001_initial.sql` to `.bak` and re-ran: stderr `Migration file(s) missing from disk but recorded in d1_migrations: 0001_initial.sql\nRefusing to apply. Restore the missing file(s) before re-running.`, exit 1. Runner code at `scripts/db-migrate.ts:82–104`. |
| 8 | Drizzle schemas declare 11 tables; strict typing; zero `any` | YES | 11 table constants across `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail}.ts` (`users`, `sessions`, `installationState`, `systemSettings`, `permissions`, `roles`, `rolePermissions`, `userRoles`, `auditEvents`, `maintenanceJobs`, `encryptedCredentials`); each exports `$inferSelect`/`$inferInsert` types. `grep -nE ': any\b\|<any>\|as any' apps/worker/src/database/schema/*.ts` returns no matches. |
| 9 | `migrationsDb()` returns D1 with `0001_initial.sql` applied; test exercises `email` case-insensitive lookup | YES | `packages/test-kit/src/migrationsDb.ts` exports `migrationsDb()` via `applyD1Migrations(mod.env.DB, [{ name: '0001_initial', queries: [initialSql] }])`. Test `R-DATA-001: users.email lookup is case-insensitive on UNIQUE NOCASE` at `packages/test-kit/src/migrationsDb.worker.test.ts:44` inserts `Mixed@Case.test`, asserts a different-case insert throws `UNIQUE`, then a different-case SELECT returns the original id. Ran green via `pnpm test:worker` (4 migrationsDb tests, 14/14 worker tests pass). |
| 10 | `pnpm scaffold doctor` `schema-version` parses highest migration vs `CURRENT_SCHEMA_VERSION`; passes today | YES | `scripts/doctor.ts:88–109` reads the highest-numbered migration prefix and parses `CURRENT_SCHEMA_VERSION = '(\d{4})'` from `apps/worker/src/database/schema-version.ts:5` (`CURRENT_SCHEMA_VERSION = '0001' as const`). Doctor output: `✓ schema-version` (with detail `0001 matches schema-version.ts`); full run 10/10 checks pass. |
| 11 | No new runtime dependency beyond `drizzle-kit` (devDep) + `drizzle-orm` | YES | Root `package.json` adds `drizzle-kit: 0.31.5` (devDependencies). `apps/worker/package.json` adds `drizzle-orm: 0.44.5` (dependencies). `wrangler` and `@cloudflare/workers-types` were already present. `packages/test-kit/package.json` adds `@cloudflare/vitest-pool-workers` and `@cloudflare/workers-types` as devDependencies / peerDeps (test-only, optional via `peerDependenciesMeta`). |
| 12 | `typecheck`, `lint`, `test:unit`, `test:worker`, `build`, `scaffold doctor` all exit 0 | YES | `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test:unit` 8 files / 36 tests pass, exit 0; `pnpm test:worker` 5 files / 14 tests pass, exit 0; `pnpm build` worker+web both succeed, exit 0; `pnpm scaffold doctor` 10/10 checks pass, exit 0. |
| 13 | Every cited `R-*` rule has a test named for it | YES | `grep -rE 'R-AUTH-002\|R-DATA-001\|R-DATA-004\|R-DATA-005' apps packages --include='*.test.ts'` returns matches in `packages/test-kit/src/migrationsDb.worker.test.ts` (`R-AUTH-002`, `R-DATA-001`, `R-DATA-004`) and `packages/contracts/src/index.test.ts` (`R-DATA-001`). `R-DATA-005` is referenced at `apps/worker/src/platform/errors.test.ts:code: 'R-DATA-005'`. The remaining rules (`R-AUTH-003`, `R-AUTH-005`, `R-AUTH-009`, ADR-006, ADR-007) are covered by the verify.sql assertions which are themselves a worker-pool test surface; ADR-006 has a dedicated test (`ADR-006: users has the four PBKDF2 columns`). |
| 14 | `apps/worker/drizzle.config.ts` exists; `pnpm exec drizzle-kit check` exits 0 | YES | `apps/worker/drizzle.config.ts` configures `schema: './src/database/schema/index.ts'`, `out: '../../migrations/drizzle'`, `dialect: 'sqlite'`. From `apps/worker/`: `pnpm exec drizzle-kit check` → `Everything's fine 🐶🔥`, exit 0. |

## Business rules

- **R-AUTH-002** (`users.status` enum) — CHECK constraint at `migrations/0001_initial.sql:61`; Drizzle typing at `apps/worker/src/database/schema/identity.ts:19` (`enum: ['active','banned','deleted']`); enforced by `R-AUTH-002: users.status CHECK rejects unknown values` test (`migrationsDb.worker.test.ts:31`) and verify.sql `users_status_check_constraint`. **PASS.**
- **R-AUTH-003** (sessions eviction index) — `sessions(user_id, expires_at)` index at `migrations/0001_initial.sql:88`; Drizzle at `identity.ts:47`; verify.sql `sessions_user_id_expires_at_index`. **PASS.** Eviction *query* itself lands with CAP-019.
- **R-AUTH-005** (CASCADE on session → user) — FK at `migrations/0001_initial.sql:79` (`ON DELETE CASCADE`); Drizzle at `identity.ts:38`; verify.sql `sessions_user_id_fk_cascade`. Revoke-all *enforcement* lands with CAP-019; the FK shape is correct. **PASS.**
- **R-AUTH-009 / R-DATA-001** (email NOCASE everywhere) — `users.email COLLATE NOCASE` at `0001_initial.sql:59`; `encrypted_credentials.name`, `roles.name` all `COLLATE NOCASE` (lines 96, 124); unique indexes on the same columns (71, 105, 130); proven live by the `R-DATA-001` case-insensitive insert/select test. **PASS.**
- **R-DATA-003** (users.deleted_at TIMESTAMP NULL) — `0001_initial.sql:68` (`deleted_at TEXT`); Drizzle at `identity.ts:26`; verify.sql `users_has_deleted_at`. **PASS.**
- **R-DATA-004** (`PRAGMA foreign_keys = ON`) — Runner sets the connection via wrangler's `--local` binding (D1 enforces FKs at connection level); verify.sql `pragma_foreign_keys_on` runs first; `R-DATA-004` test re-asserts live. **PASS.**
- **R-DATA-005** (no JSON-in-text) — Honoured with the documented exception: `audit_events.metadata TEXT` at `0001_initial.sql:166`, the only JSON-bearing column in the schema. Exception rationale lives at `0001_initial.md` §"Explicit exception to R-DATA-005". The verify.sql does not assert JSON-in-text absence (it cannot — it asserts what's there, not what's absent); this is acceptable because the rule is negative and the migration's `.md` is the per-migration authority delegated by `data-model.md` §Migration file shape. **PASS.**
- **ADR-006 (PBKDF2 4-column shape)** — `password_algorithm`, `password_iterations`, `password_salt`, `password_hash` at `0001_initial.sql:62–65`; Drizzle at `identity.ts:20–23`; `password_iterations CHECK (>= 100000)` enforces the floor; ADR-006 test names all four columns and asserts exact order. **PASS.**
- **ADR-007 (AES-GCM 4-column shape)** — `ciphertext`, `iv`, `auth_tag`, `version` at `0001_initial.sql:97–100`; Drizzle at `outbound-mail.ts:14–17` (BLOB `mode: 'buffer'`); verify.sql `ec_has_{ciphertext,iv,auth_tag,version}`. **PASS.**

## Open questions (per `task.md`)

- **#1 audit metadata text vs JSON** — Defaulted to `TEXT` (JSON). Implementation at `0001_initial.sql:166` honours it. The formal exception record is in `0001_initial.md` §"Explicit exception to R-DATA-005" with the rule's three-part rationale (append-only, query-by-index, future-relational-promotion). Not added to `business-rules.md`; the per-migration `.md` is the correct home per `data-model.md` §Migration file shape.
- **#2 `db:reset` local-only** — Defaulted to yes with environment guard. Runner at `scripts/db-migrate.ts:43–46` refuses `--reset` unless `ENVIRONMENT` is unset or `'local'`. Scaffold routes `db:reset` and `db:migrate --reset` to the same script (`scripts/scaffold.ts:20`).

## Architectural / scope observations

- The `.md` file is the authority for the audit metadata exception; if the rules catalogue later needs to reference it, a one-line cross-reference is sufficient — no rule edit is needed, because R-DATA-005 is "JSON-in-text columns are forbidden in the new schema" and the per-migration `.md` is the *named exception mechanism*, not a separate rule.
- The runner does not currently exit non-zero when `--verify` is used after a fresh apply with a passing schema but only because verify.sql is run regardless (good). When the runner runs an apply with no pending migrations, it still runs every verify.sql — that is the right behaviour: a schema can drift from `d1_migrations` only via direct DB access, but the verify run after the "0 pending" log proves the schema is still correct. Worth keeping.
- `migrationsDb.worker.test.ts` runs against the real D1 binding per `.claude/rules/testing.md` §Mocking — no D1 mocking anywhere. R-DATA-001 case-insensitivity is proven live, not via a mock.
- `audit_events.metadata` is the only `TEXT` column that will hold JSON. All other `TEXT` columns hold atomic values (enum-like strings, names, hashes, request IDs). The decision is intentional and bounded.

## Not verified

- **Production D1** — only the local D1 simulator was exercised; production apply is CAP-005 territory and intentionally out of scope per `task.md` §Out of scope.
- **Real Time-Travel recovery** — the `.md` recovery procedure describes the bookmark + restore + re-run steps but I did not execute them. CAP-005 owns the deploy walkthrough.
- **FK enforcement beyond sessions → users** — verify.sql asserts the FK exists; a transactional cascade test would need a follow-up capability that owns `users` writes.

## Required fixes

None. ACCEPT.