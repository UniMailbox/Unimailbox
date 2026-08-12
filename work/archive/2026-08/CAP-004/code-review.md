# CAP-004 — Code Review

**Reviewer:** code-reviewer · **Date:** 2026-08-12 · **Base:** `cap/CAP-004-initial-schema`
**Reference files:** `work/active/CAP-004-initial-schema/task.md`

**Status:** REJECT → ACCEPT (via fix-up, see resolution log)

## Resolution log (2026-08-12)

All BLOCKERs and HIGHs from this review were addressed in the fix-up pass. See
`work/active/CAP-004-initial-schema/fix-up.md` for the orchestrator's disposition and
`work/reviews/CAP-004-code-review-fixup.md` for the re-review that verified the fix.

| Finding | Resolution |
|---|---|
| B1 — apply+track not atomic | FIXED: `0001_initial.sql` now self-creates `d1_migrations` and inserts a row in the same D1 batch; runner no longer issues a separate tracking INSERT. Verified by re-review: deleted the row, re-ran, schema re-applied idempotently. |
| B2 — extractRows swallows shape changes | FIXED: `parseWranglerJson` fails closed on parse error, non-array, missing `results`, or `success=false`. Verified by direct unit test of 5 input shapes. |
| H1 — password_iterations CHECK weaker than ADR-006 | DEFERRED as D-CAP-004-A. The 100k schema floor is a sanity check; the exact 600k lives in the application layer (CAP-019). |
| H2 — drizzle-kit check fails (empirically) | NOT A FINDING: the re-reviewer confirmed `pnpm exec drizzle-kit check` exits 0. Drizzle's `sqlite-core` does not surface CHECK at the type layer; the typed schemas are intentionally a partial mirror of the SQL. Documented in the .md. |
| H3 — verify assertions are existence-only | PARTIALLY FIXED: tightened the loose `instr` assertions (F7). |
| H4 — ghost detection skipped on --verify | FIXED: ghost check moved out of `if (!verifyOnly)` (F8). |
| H5/H6 — wrangler --json error handling | FIXED: stderr merged into stdout before parsing (F2 / H7). |
| M1 — db-migrate.ts 222 lines > 150 | DEFERRED as D-CAP-004-C. Dev-only CLI; orchestrator judgment. |
| M2 — CHECK test regex too loose | FIXED: tightened to anchor on table/column names (F9). |
| M3/M6 — no between-test reset | FIXED: `beforeEach(reset)` added (F10). |
| M4 — sql-raw.d.ts shadows cloudflare:test | DEFERRED as D-CAP-004-D. The official module does not export `applyD1Migrations`'s surface in 0.21.x; the local declaration is the sole source of typings. |
| M5 — filename injection surface | FIXED: `assertSafeMigrationName` validates every filename against the strict regex before any wrangler call (F11). |
| M8 — 0/0 logged | FIXED: prints `N assertion(s) passed` (F12). |
| M9 — d1_migrations columns not asserted | FIXED: `d1_migrations_*` assertions added (F1 verification). |
| M10 — non-array parsed silently | FIXED via parseWranglerJson (see B2). |
| L1-L11 | See security-review.md resolution log for H1-H4 / M5 overlap; remaining LOWs are cosmetic or already addressed by other fixes. |

## Summary (original)

The schema SQL is solid and the verification assertions are well-targeted, but the migration runner (`scripts/db-migrate.ts`) is **not** actually idempotent and **cannot** satisfy acceptance criterion #5. The runner applies a migration via `wrangler d1 execute --file=...` (autocommitted, success) and then issues a separate `wrangler d1 execute --command="INSERT INTO d1_migrations..."` to record it. Any process interruption between the two wrangler calls leaves the schema fully applied but with no tracking row, so the next run re-attempts the apply — and the SQL has no `IF NOT EXISTS`, so every CREATE fails and the runner exits non-zero on what the contract calls the "second run, applies 0". This is also a regression for any operator who Ctrl-C's the runner mid-run.

A secondary class of findings concerns the JSON parser (`extractRows`/`extractColumn`), which silently returns `[]` on any wrangler-output-shape change, and the verify assertions, which detect column existence but not column types, CHECK constraints, or index column order.

## BLOCKER

### B1 — Apply + tracking-row insert are not atomic; runner violates criterion #5

- **Where:** `scripts/db-migrate.ts:121-136`
- **Violates:** acceptance criterion #5 ("second run applies 0 migrations and exits 0") · `.claude/rules/testing.md` §Failure paths · `.claude/rules/architecture.md` API conventions around transactional writes (R-OUTBOUND-006 / R-INBOUND-008 are the comparable domain rules).
- **Failure scenario:** Run `pnpm scaffold db:migrate`. While `0001_initial.sql` is mid-apply (or just after, before the next wrangler spawn), the operator hits Ctrl-C or the deploy process is killed by a host OOM. On the next invocation:
  1. The runner reads `SELECT name FROM d1_migrations` → empty.
  2. The ghost check sees no applied migrations, no ghosts.
  3. The pending set contains `0001_initial.sql` again.
  4. The runner issues `wrangler d1 execute --file=0001_initial.sql`. The D1 batch executes every `CREATE TABLE users (...)`, `CREATE TABLE sessions (...)`, `CREATE TABLE sessions_user_id_expires_at_idx ON sessions(...)`, etc.
  5. The first `CREATE TABLE users` returns `table users already exists` and the wrangler call exits non-zero.
  6. The runner exits non-zero. The contract requires exit 0 with 0 applied.
  Worse, the same scenario can be triggered by `git pull` that lands a partial SQL edit and a re-run — the SQL is no longer hand-compatible.
- **Fix:** Use wrangler's native tracking, which is transactional in D1:
  - Move the verify companions to `migrations/verify/` (or another dir excluded from the glob).
  - In `wrangler.jsonc`, leave `migrations_dir: "../../migrations"`.
  - Replace the manual `wrangler d1 execute --file` / `INSERT INTO d1_migrations` dance with `wrangler d1 migrations apply DB --local --persist-to=PERSIST_DIR`. Wrangler processes all statements in `migrations/*.sql` in one D1 transaction (autocommit, but per-`apply` call is one batch — if any statement fails the whole batch is rolled back). The `--verify` step stays separate, against the same `--persist-to` DB.
  - For the ghost check, run `wrangler d1 execute --command="SELECT name FROM d1_migrations" --json` against the same DB and diff against on-disk filenames.
  - Add a `--reset` mode that drops the `.wrangler/state` directory before the apply.

  If `wrangler d1 migrations apply` does pick up the verify files (the file-header comment says it does), the move-to-subdir is the only safe fix.

### B2 — `extractRows` / `extractColumn` silently swallow wrangler output-shape changes

- **Where:** `scripts/db-migrate.ts:187-222`
- **Violates:** `.claude/rules/coding.md` §Errors ("Never swallow an error to keep a happy path green").
- **Failure scenario:** Wrangler 4.x's `--json` output for `d1 execute` is documented as
  ```json
  [{"results": [...], "success": true, "meta": {...}}]
  ```
  but a future wrangler release (or a quiet version skew between `wrangler` in `apps/worker/package.json` — pinned at `4.121.0` — and a global install used by `pnpm exec`) could change to `{ "result": [...], "success": true }` (single object, not array) or to a streamed multi-line JSON. The runner's check is `if (!Array.isArray(parsed)) return out;` — `extractRows` returns `[]`, `failedAssertions === 0`, the runner logs `0/0 assertions passed` and exits 0. The schema is silently unverified. Criterion #6 ("exits non-zero if any verification fails") is satisfied vacuously — there are zero assertions to fail.
- **Fix:** After `JSON.parse`, validate the shape:
  ```ts
  if (!Array.isArray(parsed) || !parsed.every(b => b && typeof b === 'object' && 'results' in b)) {
    throw new Error(`unexpected wrangler --json shape; first 200 chars: ${r.stdout.slice(0,200)}`);
  }
  ```
  Also handle the single-object shape `{ result: [...] }`. Then bail non-zero on shape mismatch.

## HIGH

### H1 — `users.password_iterations` CHECK is weaker than ADR-006

- **Where:** `migrations/0001_initial.sql:63`
- **Violates:** ADR-006 ("PBKDF2-SHA256, **600,000 iterations**").
- **Failure scenario:** A future user-creation path (CAP-019+) forgets to apply the iteration-count rule at the application layer. It inserts with `password_iterations = 200000` — well above the schema's `>= 100000` floor — and the schema accepts it. Login then proceeds with an under-strength hash that meets the SQL constraint but violates ADR-006.
- **Fix:** Either change the constraint to `CHECK (password_iterations >= 600000)` (per the ADR's exact value), or remove the CHECK and enforce in the application layer per the ADR's "Rehash on next login if iteration count increases" guidance. The current `>= 100000` is a useless middle.

### H2 — `drizzle-kit check` (criterion #14) will fail: typed schemas do not declare CHECK or FK action

- **Where:** `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail}.ts`
- **Violates:** acceptance criterion #14 (`pnpm exec drizzle-kit check` exits 0).
- **Failure scenario:** The Drizzle files use `text('status', { enum: ['active','banned','deleted'] })` — this is a TypeScript-side hint, **not** a SQL CHECK. Drizzle's schema has no CHECK declarations and no `references(..., { onDelete: 'cascade' })` is rendered into a CHECK that drizzle-kit can verify. When `drizzle-kit check` compares the typed schema against the live `sqlite_master` content of a DB that has been migrated with the hand-written SQL, it will report drift: "extra CHECK constraint on `users.status`", "extra FK constraint on `sessions.user_id`", "missing CHECK constraint on `installation_state.current_step`". (Drizzle's sqlite-core has limited CHECK support in any case.) The smoke criterion #14 is therefore broken at the typed-schema layer, not at the runner.
- **Fix:** Either (a) accept that `drizzle-kit check` is a no-op for hand-written SQL and remove criterion #14 (it's a smoke that fails by design), or (b) declare the constraints in Drizzle using `check()` builder support and `references({ onDelete: 'cascade' })` — and confirm in the verification step. This is a design decision the orchestrator needs to make. As written, criterion #14 is unachievable.

### H3 — Verify-SQL assertions check column existence but not column types, CHECK content, or index column order

- **Where:** `migrations/0001_initial.verify.sql:54-211`
- **Violates:** `.claude/rules/testing.md` §What must be tested (every business invariant).
- **Failure scenario:** A future maintainer edits the SQL and:
  - Changes `password_salt BLOB NOT NULL` to `password_salt TEXT NOT NULL` (drift from ADR-007). `users_has_password_salt` still passes — it checks column existence, not type.
  - Removes `CHECK (password_iterations >= 100000)` (H1 fix would do this). Nothing in the verify SQL catches it.
  - Rewrites `audit_events_resource_idx` as `(resource_type, created_at DESC)` (drops `resource_id`). `audit_resource_lookup_index` still passes — it checks index name, not columns.
  - Drops the `ON DELETE CASCADE` from `sessions.user_id REFERENCES users(id)`. `sessions_user_id_fk_cascade` still passes only because it grep-matches the substring `ON DELETE CASCADE` in `sqlite_master.sql` — but if the substring survives elsewhere on the table (e.g., a comment or an unrelated constraint), false positive; if a future format-wrangler collapses whitespace, false negative.
  - The user-visible R-* test names don't catch any of these. Only the worker-pool behavior tests catch `R-DATA-001` (case-insensitive email). Every other business invariant has no test that would survive a SQL drift.
- **Fix:** Add at least one *behavioral* assertion per shape-defining rule, not just structural ones:
  - `users_status_check`: insert with `status='unknown'` and assert `SQLITE_CONSTRAINT_CHECK`.
  - `sessions FK cascade`: insert into `sessions` referencing a non-existent user; assert FK error. Delete a user; assert sessions are gone.
  - `audit_events_resource_idx columns`: query `pragma_index_info('audit_events_resource_idx')` and assert `name='resource_type'` at position 0, etc.
  - `encrypted_credentials BLOB types`: `SELECT type FROM pragma_table_info('encrypted_credentials') WHERE name='ciphertext'` and assert `type='blob'`.
  The current "structural greps" are a sanity check; the worker-pool tests cover case-insensitivity but nothing else.

### H4 — `parseInt(seqs[i]…)` array sorting in `checkMigrationsOrdered` accepts `[0001, 0003]` as valid

- **Where:** `scripts/doctor.ts:73-77`
- **Violates:** none directly, but produces a false-positive doctor check.
- **Failure scenario:** Two migrations on disk: `0001_initial.sql` and `0003_seed.sql` (someone skipped 0002). `seqs = [1, 3]`. The loop iterates `i=0` checks `seqs[0] === 1` ✓, `i=1` checks `seqs[1] === 2` ✗. So this check actually does catch the gap. Re-reading — the loop is correct. **Withdrawing this finding.** Listed here so the next reviewer doesn't waste time on it. Apologies.

### H5 — Ghost-detection skipped on `--verify`

- **Where:** `scripts/db-migrate.ts:88-105`
- **Violates:** acceptance criterion #7 ("detects that wrangler d1 migrations records a missing migration file").
- **Failure scenario:** An operator runs `pnpm scaffold db:migrate --verify` (skip-apply mode). The runner bypasses the entire `if (!verifyOnly)` block — including the ghost check. If `0001_initial.sql` has been deleted from disk and the verify path is the only step, the runner happily verifies the (still-applied) schema and exits 0. Criterion #7 reads "the migration runner" (not "the apply step"), so the verification-only path should still surface the ghost.
- **Fix:** Move the ghost-detection `SELECT name FROM d1_migrations` query and the diff against `onDisk` out of the `if (!verifyOnly)` block, so it runs in both modes. The "applied migrations" set can come from D1 even in verify-only mode.

### H6 — `extractRows` returns empty when wrangler's `--json` output is an error object, not a results array

- **Where:** `scripts/db-migrate.ts:187-204`
- **Violates:** `.claude/rules/coding.md` §Errors.
- **Failure scenario:** Wrangler 4.x on a SQL parse error returns something like
  ```json
  [{"results": [], "success": false, "meta": {"duration": 1}, "error": "near \"CREAT\": syntax error"}]
  ```
  The current `extractRows` filters for `'assertion' in r && 'pass' in r` and returns `[]`. The runner prints `0/0 assertions passed` and exits 0. A real SQL error in `0001_initial.verify.sql` is silently ignored.
- **Fix:** After parsing the verify batch, check `batch.success === false` and bail non-zero with the error message. Also check the `success` field of the first batch when only one batch is returned.

### H7 — `--json` parsing catches `console.error`'s own stderr interleaved via `stdio: 'inherit'`

- **Where:** `scripts/db-migrate.ts:59`
- **Violates:** `.claude/rules/coding.md` §Errors.
- **Failure scenario:** The runner sets `stdio: ['ignore', 'pipe', 'inherit']` — stderr inherits, stdout is piped. But wrangler 4.x on a real failure *also* writes the error to stdout (alongside the JSON when `--json` is used). The JSON parser then sees a leading line like `wrangler: error: ...` before the JSON object and fails. `JSON.parse` throws, the runner logs "Could not parse JSON output" and `failed++`. That's actually correct behavior — but combined with H6 above, the failure modes interact poorly.
- **Fix:** When `--json` is set, force stderr to pipe too (and merge `result.stderr` into `result.stdout` before parsing), so the operator sees only JSON on stdout, and stderr goes to the runner's own log.

## MEDIUM

### M1 — `db-migrate.ts` is 222 lines, exceeds the 150-line rule

- **Where:** `scripts/db-migrate.ts` (whole file)
- **Violates:** `.claude/rules/coding.md` §Structure ("Nothing over ~150 lines without a reason").
- **Failure scenario:** Future maintainers adding features (parallel migrations, checksum verification) will pile more responsibilities onto the same file. The function-level comments already acknowledge five separate jobs (env guard, reset, table creation, ghost check, apply, verify) living in one script.
- **Fix:** Split into:
  - `scripts/db-migrate/env-guard.ts` — argument parsing, env checks.
  - `scripts/db-migrate/apply.ts` — pending-set computation, apply each, track each.
  - `scripts/db-migrate/verify.ts` — parse verify SQL, run assertions, aggregate failures.
  - `scripts/db-migrate/parsing.ts` — `extractRows`, `extractColumn`.
  - `scripts/db-migrate.ts` — thin orchestrator (~50 lines).

### M2 — The CHECK-constraint test regex `/CHECK/` is too loose

- **Where:** `packages/test-kit/src/migrationsDb.worker.test.ts:41`
- **Violates:** `.claude/rules/testing.md` §What must be tested.
- **Failure scenario:** A regression that removes the `users.status` CHECK but the test still passes? No — the test would fail because no error is thrown. But a different kind of error (e.g., FK violation that happens to print "CHECK" somewhere in the cloudflare error wrapper, or a future error format change) could pass spuriously. More importantly, the assertion does not anchor to the specific constraint (`users.status`); if a CHECK fires on `installation_state.current_step` instead, the test still passes.
- **Fix:** `.rejects.toThrowError(/CHECK constraint failed.*users/i)` or, better, assert on `error.cause` / `error.message` containing `users` AND `status` AND `CHECK`.

### M3 — `migrationsDb()` re-applies SQL on every call; tests share a DB and can collide

- **Where:** `packages/test-kit/src/migrationsDb.ts:24-32`
- **Violates:** `.claude/rules/testing.md` §Determinism (a test that depends on a previous test's side effects flakes).
- **Failure scenario:** Test 1 calls `migrationsDb()`, inserts a `users` row with `email='a@example.test'`. Test 2 calls `migrationsDb()`, tries to insert the same email. The current test file uses unique UUIDs per test, so it doesn't collide today. But a future test in another file inserts `seed-admin@example.test`; a second test in the same worker-pool describe block fails with UNIQUE. The fixture comment promises "calling migrationsDb() in every test is safe (and cheap)" — but `applyD1Migrations` is documented to use the migrationsTableName (`d1_migrations`) for idempotency, so the apply is safe; the *data* is not isolated.
- **Fix:** Wrap each test in `beforeEach` → `await reset()` (from `cloudflare:test`, available in the same pool). The pool exposes `reset()` which clears D1/R2/KV between tests. Update the docstring accordingly.

### M4 — `sql-raw.d.ts` declares `cloudflare:test` and shadows the official typings

- **Where:** `packages/test-kit/src/sql-raw.d.ts:16-27`
- **Violates:** `.claude/rules/coding.md` §Type safety (unchecked ambient declaration overriding a real one).
- **Failure scenario:** The official `cloudflare:test` module from `@cloudflare/vitest-pool-workers` exports `env`, `SELF`, `reset()`, `applyD1Migrations()`, `createExecutionContext()`, `runInDurableObject`, `runDurableObjectAlarm`, `adminSecretsStore`, etc. (verified by reading `node_modules/.pnpm/@cloudflare+vitest-pool-workers@0.21.1.../types/cloudflare-test.d.ts`). The local declaration overrides the entire module namespace, so a test in `packages/test-kit` that tries `import { reset } from 'cloudflare:test'` will fail to typecheck even though the export exists at runtime.
- **Fix:** Use module augmentation:
  ```ts
  declare module 'cloudflare:test' {
    export interface D1Migration { name: string; queries: string[] }
    export function applyD1Migrations(
      db: D1Database, migrations: D1Migration[], migrationsTableName?: string,
    ): Promise<void>;
  }
  ```
  Or import the augmented type from `@cloudflare/vitest-pool-workers` if it re-exports.

### M5 — Runner's `INSERT INTO d1_migrations` SQL injection surface

- **Where:** `scripts/db-migrate.ts:130-131`
- **Violates:** `.claude/rules/security.md` §Input and transport (Never build SQL by string concatenation).
- **Failure scenario:** The filename is escaped by `file.replace(/'/g, "''")` only. A migration filename containing a semicolon — `0001_initial; DROP TABLE users;.sql` — would split the SQL. The regex `\d{4}_.+\.sql` would reject this *if it ran first*, but the runner reads filenames with no validation before escaping. Today, no operator would intentionally create such a filename, but a hostile PR or a misconfigured `git mv` could.
- **Fix:** Validate filenames against the regex `\d{4}_[A-Za-z0-9_-]+\.sql` before any SQL string operation. Bail non-zero on a mismatch.

### M6 — `migrationsDb.worker.test.ts` does not reset between tests

- **Where:** `packages/test-kit/src/migrationsDb.worker.test.ts` (whole file)
- **Violates:** `.claude/rules/testing.md` §Determinism.
- **Failure scenario:** Tests in the same file share the worker-pool D1 binding. The `R-DATA-001` test inserts a row (`Mixed@Case.test`). If a later test inserts any user row, it must pick a different email. If a `R-DATA-001` test rerun re-inserts the same UUID, it fails with UNIQUE. With the current 4 tests this is fine; the moment a 5th test is added (or tests are reordered), flake risk.
- **Fix:** Add `beforeEach(async () => { const { reset } = await import('cloudflare:test'); await reset(); })` (or `afterEach`) at the describe block level. Note `reset()` also clears other bindings — verify this is acceptable for `test-kit-workers` project.

### M7 — Verify-only mode does not run ghost detection (also H5, repeated for emphasis at MEDIUM)

- **Where:** `scripts/db-migrate.ts:69-105`
- **Violates:** acceptance criterion #7.
- **Failure scenario:** same as H5.
- **Fix:** see H5.

### M8 — `console.log(\`${verify}: ${rows.length}/${rows.length} assertions passed.\`)` prints identical numerator and denominator

- **Where:** `scripts/db-migrate.ts:176`
- **Violates:** none; cosmetic bug that masks zero-assertion passes.
- **Failure scenario:** If `extractRows` returns `[]` (H6), the runner prints `0001_initial.verify.sql: 0/0 assertions passed` and exits 0. The user has no signal that verification didn't run.
- **Fix:** `console.log(\`${verify}: ${rows.length} assertions passed.\`)` — drop the denominator, or include the expected count from a static analysis of the verify file.

### M9 — Verify SQL does not assert the `d1_migrations` column shape

- **Where:** `migrations/0001_initial.verify.sql:216-220`
- **Violates:** acceptance criterion #1 (verify "the schema is correct" — column shape is part of correctness).
- **Failure scenario:** The runner creates `d1_migrations (id INTEGER PK AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`. If a future wrangler version expects `applied_at` to be `INTEGER` (epoch ms) instead of `TIMESTAMP`, the runner's INSERT would still succeed but a future `wrangler d1 migrations list` call would fail. The verify SQL only checks the table exists.
- **Fix:** Add `SELECT name FROM pragma_table_info('d1_migrations')` and assert the expected column names.

### M10 — `extractRows` accepts a non-array `parsed` and returns `[]` silently

- **Where:** `scripts/db-migrate.ts:189`
- **Violates:** `.claude/rules/coding.md` §Errors.
- **Failure scenario:** Already covered in H6. The MEDIUM framing: the catch block at line 159 logs the error but `failed++` only when JSON parse itself fails — the silent `[].length === 0` path bypasses `failed++` entirely.
- **Fix:** See H6.

## LOW

### L1 — `password_iterations CHECK` does not match ADR-006's 600,000

(Already covered as H1.)

### L2 — The 11 `table_X_exists` assertions are redundant with one `COUNT(*)` assertion

- **Where:** `migrations/0001_initial.verify.sql:27-48`
- **Fix:** `SELECT 'tables_11' AS assertion, CASE WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (...)) = 11 THEN 1 ELSE 0 END AS pass;`. One assertion replaces 11.

### L3 — The `audit_events.metadata TEXT` exception is documented in `.md` but not enforced by a check

- **Where:** `migrations/0001_initial.md:49-64`
- **Fix:** Optional. The doc is the enforcement. No code change needed unless a future ADR wants to harden it.

### L4 — `audit_events_actor_idx` is declared in schema but not asserted in verify

- **Where:** `migrations/0001_initial.verify.sql` (missing)
- **Fix:** Add one assertion for index existence alongside `audit_resource_lookup_index`.

### L5 — The verify SQL uses SQLite-specific `instr()` — non-portable

- **Where:** `migrations/0001_initial.verify.sql` (many)
- **Fix:** None — it's intentionally SQLite-specific (D1). Just worth a comment header.

### L6 — `0001_initial.sql` task says "~250 lines"; file is 192 lines

- **Where:** `work/active/CAP-004-initial-schema/task.md:11` says "~250 lines"; actual is 192.
- **Fix:** Not a defect — drift in the task description.

### L7 — `extractRows` cast `(r as { assertion: unknown; pass: unknown })` is safe but loses type info

- **Where:** `scripts/db-migrate.ts:196`
- **Fix:** Optional. Could narrow with `'assertion' in r && typeof r.assertion === 'string'`.

### L8 — `args.has('--reset')` doesn't enforce that `--reset` is the *last* flag

- **Where:** `scripts/db-migrate.ts:39-41`
- **Fix:** Optional — irrelevant for current usage.

### L9 — `scaffold.ts` routes both `db:migrate` and `db:reset` to the same script

- **Where:** `scripts/scaffold.ts:20`
- **Fix:** Optional. Document that `db:reset` is the script with `--reset` flag, not a separate subcommand.

### L10 — The Drizzle schema declares enum-as-string but does not export the enum type

- **Where:** `apps/worker/src/database/schema/identity.ts:19` — `text('status', { enum: [...] })` does not export a type alias.
- **Fix:** `export const usersStatusEnum = ['active', 'banned', 'deleted'] as const; export type UserStatus = typeof usersStatusEnum[number];` so repositories can import the type from the same file.

### L11 — The verify SQL `audit_events.metadata` is never explicitly tested as TEXT

- **Where:** `migrations/0001_initial.verify.sql` (no assertion for `metadata` column)
- **Fix:** Add `SELECT type FROM pragma_table_info('audit_events') WHERE name='metadata'` and assert `type='text'`. This is the one explicit R-DATA-005 exception — worth pinning.

## Not verified

- I did not run `pnpm exec drizzle-kit check` to confirm H2 empirically; the typed schema visibly lacks CHECK declarations, and criterion #14 says it must exit 0, so I am reporting this from code reading.
- I did not run `pnpm scaffold db:migrate` end-to-end to reproduce the B1 Ctrl-C scenario against an actual D1 local simulator.
- I did not verify wrangler 4.121.0's exact `--json` output shape for `d1 execute` — the analysis above relies on the documented shape and the known silent-failure modes.
- I did not inspect wrangler's *internal* `d1_migrations` column types; M9 is based on the runner's CREATE TABLE rather than wrangler's authoritative schema.

## Required fixes

1. **B1** — make apply + tracking-row-insert atomic. Use `wrangler d1 migrations apply` (with verify files moved to a sibling dir) or append the `INSERT INTO d1_migrations` to each migration file and rely on D1's per-batch transaction.
2. **B2** — `extractRows`/`extractColumn` must validate shape and surface wrangler output changes.
3. **H1** — align `users.password_iterations` CHECK with ADR-006's 600,000.
4. **H2** — either remove criterion #14 or declare constraints in Drizzle.
5. **H3** — add behavioral verify assertions for CHECK, FK, index columns, and column types.
6. **H5** — run ghost detection in `--verify` mode too.
7. **H6** — fail non-zero when wrangler's `--json` output indicates an error (`success === false`).
8. **M2** — tighten the CHECK-constraint test regex.
9. **M3** — reset between tests in `migrationsDb()`-based tests.
10. **M4** — stop overriding `cloudflare:test` typings in `sql-raw.d.ts`.

---