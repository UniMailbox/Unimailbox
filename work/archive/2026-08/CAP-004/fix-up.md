# CAP-004 Fix-up — review findings

Four reviewers ran. Disposition:

| Reviewer | Verdict | Action |
|---|---|---|
| architecture | ACCEPT WITH NOTES | 1 MEDIUM + 3 LOW; the MEDIUM overlaps code's B1 and is addressed by fix #1 below |
| code | REJECT | 2 BLOCKER + 6 HIGH; B1 fixed inline, B2 + H5/H6 fixed; H2 (drizzle-kit) is empirically wrong (QA confirmed it exits 0) and ignored |
| qa | ACCEPT | 14/14 acceptance criteria YES |
| security | ACCEPT WITH FIXES | 4 HIGH + 5 MEDIUM; HIGHs addressed by fixes #3-#6 |

This file is the implementer's scope. Apply only the items below. Out-of-scope improvements go in the report, not the diff.

## Reading list

- `work/active/CAP-004-initial-schema/task.md` — the original contract
- `work/reviews/CAP-004-architecture-review.md`
- `work/reviews/CAP-004-code-review.md`
- `work/reviews/CAP-004-qa-review.md`
- `work/reviews/CAP-004-security-review.md`
- `migrations/0001_initial.sql`
- `migrations/0001_initial.verify.sql`
- `migrations/0001_initial.md`
- `scripts/db-migrate.ts`
- `scripts/doctor.ts`
- `scripts/scaffold.ts`
- `packages/test-kit/src/migrationsDb.ts`
- `packages/test-kit/src/migrationsDb.worker.test.ts`
- `packages/test-kit/src/fixtures.ts`
- `packages/test-kit/src/sql-raw.d.ts`
- `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail}.ts`
- `.gitignore`

Do not read other `docs/` files.

## Fixes to apply

### F1 — B1 (code) / M1 (architecture) — apply+track atomic in one D1 call

Append a `CREATE TABLE d1_migrations (...)` + `INSERT INTO d1_migrations (name) VALUES ('0001_initial.sql')` block to the end of `migrations/0001_initial.sql`. This is one D1 batch; either the schema applies and the row records, or neither does.

In `scripts/db-migrate.ts`:
- Drop the `CREATE TABLE IF NOT EXISTS d1_migrations` separate call (the schema now does it).
- Drop the post-apply `INSERT INTO d1_migrations (name) VALUES (...)` separate call (the schema now does it).
- `wrangler d1 execute --file=0001_initial.sql` is now both the apply and the track.

For later migrations (0002_*.sql etc.) the implementer should also include the `INSERT INTO d1_migrations` in the same file, or document the convention in `0001_initial.md` §Companion files. For CAP-004 only the 0001 migration exists, so the convention is set here.

### F2 — B2 / H5 / H6 (code) — extractRows and extractColumn must fail closed

- If `JSON.parse` fails → throw, the runner exits 1.
- If the parsed value is not an array → throw.
- If a batch's `success === false` → surface the `error` field and exit 1.
- For `--json` calls, capture stderr too (change `stdio: ['ignore', 'pipe', 'inherit']` to `'pipe'` and merge) so a wrangler error message embedded in stdout does not confuse the parser.

### F3 — H1 (security) — cap `audit_events.metadata`

Add to the `audit_events` table in `0001_initial.sql`:
```sql
CHECK (length(metadata) <= 65536)
```
Add to `0001_initial.verify.sql` an assertion that the CHECK exists in the table SQL.

### F4 — H2 (security) — verify the `password_iterations` CHECK

Add to `0001_initial.verify.sql` an assertion that `instr(sql, 'CHECK (password_iterations &gt;= 100000)') &gt; 0` for the `users` table.

Add to `packages/test-kit/src/migrationsDb.worker.test.ts` a test named `R-AUTH-006: users.password_iterations CHECK rejects below-floor values` (or pick the next free rule id; cite ADR-006 in a comment) that inserts `password_iterations = 99999` and asserts rejection with a message matching `/CHECK/`.

### F5 — H3 (security) — cap unbounded TEXT columns

Add `CHECK (length(col) &lt;= N)` to these columns in `0001_initial.sql`, with the documented caps:

| Column | Cap | Reason |
|---|---|---|
| `maintenance_jobs.last_error` | 8192 | provider stack traces |
| `users.display_name` | 100 | human display |
| `sessions.ip` | 45 | IPv6 max textual form |
| `sessions.user_agent` | 512 | generous UA cap |
| `audit_events.ip` | 45 | same |
| `audit_events.action` | 64 | `setup.claim`, `webhook.delivered`, etc. |
| `audit_events.resource_type` | 64 | `mailbox`, `message`, `role` |
| `audit_events.resource_id` | 128 | UUIDs + future composite ids |
| `audit_events.request_id` | 64 | Cloudflare request ids are ~32 chars |

Add a single assertion to `0001_initial.verify.sql` that proves the audit `metadata` and `last_error` length CHECKs exist (the others can be deferred to a verification that runs only when those tables grow).

### F6 — H4 (security) — encrypted_credentials AES-GCM shape CHECKs

Add to the `encrypted_credentials` table in `0001_initial.sql`:
```sql
CHECK (length(iv) = 12),
CHECK (length(auth_tag) = 16)
```
Add to `0001_initial.verify.sql` assertions that these CHECKs exist in the table SQL.

### F7 — H3 (code) / M5 (security) — tighten the loose `instr` assertions

For `users_email_collate_nocase` and `users_status_check_constraint` in `0001_initial.verify.sql`, replace the loose multi-`instr` checks with substring windows that pin the invariant. The reviewer suggested:
- `instr(sql, 'email TEXT NOT NULL COLLATE NOCASE') &gt; 0`
- `instr(sql, 'status IN (''active'',''banned'',''deleted'')') &gt; 0`

Apply the same tightening principle to the other loose checks (FK CASCADE, status CHECK on maintenance_jobs, current_step CHECK on installation_state).

### F8 — H4 (code) — ghost detection runs on `--verify` too

Move the d1_migrations read + ghost check out of the `if (!verifyOnly)` block in `scripts/db-migrate.ts`. The read can be skipped if the tracking table does not exist (verify-only on a never-applied DB is a no-op), but the diff against on-disk filenames must run whenever the runner is invoked.

### F9 — M2 (code) — tighten the CHECK-constraint test regex

In `packages/test-kit/src/migrationsDb.worker.test.ts`, the `R-AUTH-002` test's `.rejects.toThrow(/CHECK/)` is too loose. Use `.rejects.toThrowError(/CHECK constraint failed.*users/i)` to anchor it to the right table.

### F10 — M3 / M6 (code) — between-test reset

In `packages/test-kit/src/migrationsDb.worker.test.ts`, add a `beforeEach` that calls `reset()` from `cloudflare:test` so the 4 tests do not share state via the `applyD1Migrations` cache.

### F11 — M5 (code) — validate migration filenames before SQL string interpolation

In `scripts/db-migrate.ts`, before any wrangler call that interpolates a filename, validate the filename against `/^\d{4}_[A-Za-z0-9_-]+\.sql$/`. Reject anything else with exit 1. (The current code already filters to that regex when populating the `migrations` array, but the explicit validation per-call is defense in depth.)

### F12 — M8 (code) — drop the `0/0` log

In `scripts/db-migrate.ts:176`, `${verify}: ${rows.length}/${rows.length} assertions passed.` should be `${verify}: ${rows.length} assertion(s) passed.` or, after the F2 fix, `${verify}: ${passed} passed, ${failed} failed.`

### F13 — L2 (architecture) — gitignore drizzle output

Add `/migrations/drizzle/` and `/migrations/drizzle/**` to `.gitignore`. The directory is regenerated by `drizzle-kit check` and `drizzle-kit generate`; checking it in causes noise.

### F14 — fixture status enum drift (CAP-002 forward-looking)

In `packages/test-kit/src/fixtures.ts`, change `installationState.status` from `'uninitialised' | 'in_progress' | 'complete'` to match the SQL CHECK: `'setup' | 'complete'`. Update the default in the builder and any references in test files. Search before changing — if any test relies on the old shape, that test is wrong; fix the test to use the real schema.

### F15 — task.md AC #15 (db:reset)

AC #15 is already added to `task.md` by the orchestrator. The implementer should verify it (a one-line `ENVIRONMENT=preview pnpm scaffold db:reset` should exit 2) and check the box.

## Defer to ledger (no code change)

- **D-CAP-004-A** — `users.password_iterations` CHECK is `&gt;= 100000`, weaker than ADR-006's 600,000. The implementer chose 100,000 as a sanity floor; the exact iteration count lives in the application layer and changes on rehash. CAP-019 (user registration) sets the application-level floor.
- **D-CAP-004-B** — `UserId` and other cross-boundary types should live in `packages/contracts/` before repositories land. Architecture reviewer's L1. CAP-017/CAP-019 territory.
- **D-CAP-004-C** — `scripts/db-migrate.ts` is ~250 lines (after F2 it may grow). The 150-line rule in `.claude/rules/coding.md` is for domain code; the migration runner is a dev-only CLI script that benefits from being one file. Orchestrator judgment.
- **D-CAP-004-D** — M4 (code) `sql-raw.d.ts` shadowing `cloudflare:test`. The current declaration exports `D1Migration` and `applyD1Migrations` types. If `@cloudflare/vitest-pool-workers` 0.21.x's official module exports the same surface, switch to module augmentation; if it does not, the current declaration is correct and the finding is moot. Implementer may check; if ambiguous, defer to CAP-005 (deploy) which will exercise the surface in CI.

## Acceptance

After the fixes:

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm test`, `pnpm build`, `pnpm scaffold doctor`, `pnpm scaffold db:migrate --reset`, `pnpm scaffold db:migrate --reset --verify` all exit 0.
- [ ] `pnpm exec drizzle-kit check` exits 0 from `apps/worker/`.
- [ ] F1 demonstrated: delete the d1_migrations table; run `pnpm scaffold db:migrate`; the table exists and `0001_initial.sql` is in it. (I.e. apply+track is now one batch.)
- [ ] F2 demonstrated: feed the runner a deliberately-malformed verify SQL and observe exit 1 with a non-empty error message.
- [ ] F4 demonstrated: the new R-AUTH-006 worker test runs against a `password_iterations = 99999` insert and asserts rejection.
- [ ] F10 demonstrated: the 4 worker tests pass in arbitrary order, each starting from an empty DB.
- [ ] F11 demonstrated: a file named `0001_initial.sql; DROP TABLE users; --.sql` (if such a file existed) is rejected before any wrangler call.
- [ ] F14 demonstrated: a unit test or test-kit test that consumes `fixtures.installationState({ status: 'setup' })` typechecks and runs.

## File ownership

| Agent | Owns |
|---|---|
| implementer-fix-1 | All fixes F1–F15. |

Reading other files in the workspace is fine. Writing only the files in the reading list.

## What to return

```
Task:      CAP-004 fix-up
Status:    COMPLETE | PARTIAL | BLOCKED

Changes:   <file-by-file, behavioural>
Files:     <exact paths>
Tests:     <gate commands and pass/fail>
Findings:  <anything the implementer found that the reviewers missed>
Risks:     <anything the implementer could not verify>
Next:      <recommended next concrete action>
```
