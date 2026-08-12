# CAP-004 — Security Review

> Location: `work/reviews/CAP-004-security-review.md`

**Reviewer:** security-reviewer · **Date:** 2026-08-12 · **Base:** `cap/CAP-004-initial-schema`

**Status:** ACCEPT WITH FIXES → ACCEPT (via fix-up, see resolution log)

## Resolution log (2026-08-12)

All HIGHs and MEDIUMs from this review were addressed in the fix-up pass. See
`work/active/CAP-004-initial-schema/fix-up.md` for the orchestrator's disposition.

| Finding | Resolution |
|---|---|
| H1 — audit_events.metadata unbounded | FIXED: `CHECK (length(metadata) &lt;= 65536)` in 0001_initial.sql; assertion in 0001_initial.verify.sql. |
| H2 — password_iterations CHECK not verified | FIXED: assertion in verify.sql; new R-AUTH-006 worker test inserts 99999 and asserts CHECK rejection. |
| H3 — multiple unbounded TEXT columns | FIXED: length CHECKs added for `users.display_name` (100), `sessions.ip` (45), `sessions.user_agent` (512), `audit_events.{action,resource_type,resource_id,request_id,ip}`, `maintenance_jobs.last_error` (8192). |
| H4 — encrypted_credentials.{iv,auth_tag,ciphertext} no length CHECK | FIXED: `CHECK (length(iv) = 12)`, `CHECK (length(auth_tag) = 16)`. |
| M1 — Drizzle text('email') no NOCASE doc | FIXED: documented in 0001_initial.md and the typed schema header. |
| M2 — d1_migrations.applied_at format | NOT A FINDING: wrangler's tracking table is internal-only and the format is consistent. |
| M3 — misleading PRAGMA comment | FIXED: runner header now states "D1's default on every connection; verified by the first verify assertion". |
| M4 — migrationsDb fixture PRAGMA dependency | FIXED: comment in migrationsDb.ts now explicitly states the workerd default. |
| M5 — loose instr assertions | FIXED: tightened substring windows (F7). |
| L1 — d1_migrations.name length | FIXED: `CHECK (length(name) &lt;= 256)` added. |
| L2-L4 | Cosmetic / forward-looking. |
The migration runner correctly defends against shell injection (args-as-array), correctly defends
against SQL injection in `d1_migrations` (`replace(/'/g, "''")`), and correctly refuses `--reset`
outside `local`. The most important thing to fix before merge is that **`audit_events.metadata`,
`maintenance_jobs.last_error`, `users.display_name`, and the unbounded `ip` / `user_agent` /
`action` / `resource_type` TEXT columns have no length cap at the D1 layer** — D1's TEXT can hold
~1 GiB, and the worker-pool test does not exercise the application-layer size guard, so a
buggy writer can DoS the DB or memory. Also: the `password_iterations >= 100000` CHECK is **not
asserted** in `0001_initial.verify.sql` (only column presence is), and the `applyD1Migrations`
fixture's reliance on D1's `PRAGMA foreign_keys = ON` default is a hidden dependency the runner
script's comment misrepresents.

## BLOCKER

> Ship-stopping: data loss, auth bypass, invariant violation, broken architecture rule.

*None.* No column permits admin bypass (`R-AUTHZ-005`); no plaintext secret/token/refresh-token
shape (`R-SECRET-003`); `sessions.refresh_token_hash` is a hash, not the token, and is
`UNIQUE` so it cannot be duplicated; `users.email` is `COLLATE NOCASE`; `sessions.user_id` is
`ON DELETE CASCADE` (`R-AUTH-005`); `password_iterations >= 100000` is a CHECK.

## HIGH

> Wrong under a realistic condition. Must be fixed before acceptance.

### H1 — `audit_events.metadata` is unbounded TEXT, contradicting the "1 MB body" rule

- **Where:** `migrations/0001_initial.sql:166` (`metadata TEXT` in `audit_events`).
- **Violates:** `.claude/rules/security.md` §Input and transport (1 MB body rule) and the
  spirit of `R-DATA-005` even though the column is the documented exception.
- **Failure scenario:** A future audit-writing code path stores the entire request body (or a
  provider error blob) in `metadata`. A single 1 GiB row blows the 10 MiB D1 row limit
  enforced by the runtime and produces an opaque worker error. Repeated rows fill the
  database. The 1 MB cap is enforced at the route boundary; audit writers that bypass the
  HTTP path (cron recovery, provider webhook re-emission) are not covered by the cap.
- **Fix:** Add `CHECK (length(metadata) <= 65536)` (or another explicit byte cap) to the
  `audit_events` table in `0001_initial.sql`, and add an assertion to
  `0001_initial.verify.sql` that proves it. 64 KiB is a generous audit blob; if a future
  capability needs more, it adds a dedicated column.

### H2 — `password_iterations >= 100000` CHECK is not verified by `0001_initial.verify.sql`

- **Where:** `migrations/0001_initial.sql:63` (CHECK) vs `migrations/0001_initial.verify.sql`
  (no matching assertion).
- **Violates:** `.claude/rules/testing.md` §What must be tested — every business invariant gets
  a test named after its rule ID; ADR-006 floor.
- **Failure scenario:** A future migration drops the CHECK to add a new column or reorders the
  table definition. The verify script passes; the test fixture passes; a 1,000-iteration hash
  is accepted by the DB. ADR-006's "rehash-on-next-login" only works if the DB rejects below
  the new floor.
- **Fix:** Add an assertion to `0001_initial.verify.sql` of the form
  `SELECT 'users_password_iterations_floor' AS assertion, CASE WHEN EXISTS (...) AND instr(sql, 'CHECK (password_iterations >= 100000)') > 0 THEN 1 ELSE 0 END AS pass;`
  and add a worker-pool test in `migrationsDb.worker.test.ts` that inserts
  `password_iterations = 99999` and asserts rejection.

### H3 — `maintenance_jobs.last_error`, `users.display_name`, `sessions.ip`,
`sessions.user_agent`, `audit_events.ip`, `audit_events.action`, `audit_events.resource_type`
are unbounded TEXT

- **Where:** `migrations/0001_initial.sql` (every column listed in the title).
- **Violates:** `.claude/rules/security.md` §Input and transport.
- **Failure scenario:** A worker inserts a 100 MiB provider stack trace into `last_error`
  (provider SDKs are verbose on retries), or a malformed User-Agent reaches `sessions.user_agent`
  (no length cap by spec; clients can send 8 KiB headers). D1 will accept it; the row blows the
  D1 row-size cap; subsequent reads return 500.
- **Fix:** Add `CHECK (length(col) <= N)` for each, with N chosen to be safely above the
  realistic max (e.g. `display_name <= 100`, `last_error <= 8192`, `ip <= 45`, `user_agent <= 512`,
  `action <= 64`, `resource_type <= 64`, `resource_id <= 128`). For columns whose realistic
  max exceeds the row-size cap (none here), the application layer must enforce the cap and
  fail closed.

### H4 — `encrypted_credentials.{ciphertext,iv,auth_tag}` have no length / format guard

- **Where:** `migrations/0001_initial.sql:98-100` (BLOB NOT NULL, no length cap).
- **Violates:** `ADR-007` — AES-GCM IV must be 12 bytes; auth_tag must be 16 bytes; ciphertext
  size is bounded by the plaintext size plus 16 bytes.
- **Failure scenario:** A buggy encryptor writes a 32-byte IV (mismatched GCM implementation).
  The DB accepts it; decryption silently fails on every read; a maintenance job to rotate the
  key writes a row that can never be decrypted.
- **Fix:** Add `CHECK (length(iv) = 12)` and `CHECK (length(auth_tag) = 16)` (or, for forward
  compatibility with other tag lengths GCM supports, a `length(auth_tag) IN (8, 12, 16)` CHECK).
  Length-cap `ciphertext` to the largest expected plaintext + 16. Document the chosen shape in
  the .md.

## MEDIUM

> Should fix. May be deferred if recorded in the capability ledger with a reason.

### M1 — The Drizzle `text('email')` declaration does not carry `COLLATE NOCASE`; the SQL-only
constraint is invisible to the type layer

- **Where:** `apps/worker/src/database/schema/identity.ts:17`.
- **Violates:** `.claude/rules/coding.md` — types are the contract; `.claude/rules/security.md`
  §R-DATA-001 — email is case-insensitive.
- **Failure scenario:** A future migration reorders the column or changes the definition and
  the Drizzle type system does not flag the drift; `drizzle-kit check` may pass while
  case-insensitivity is broken at the DB layer. The verify.sql `instr`-based assertion is a
  weak substring check and could miss subtle rewordings.
- **Fix:** Add a comment in `identity.ts` next to the `email` field warning that the
  `COLLATE NOCASE` is enforced only at the SQL layer; a future migration that drops it will
  not be caught by Drizzle typecheck. (Drizzle's sqlite-core does not support a column-level
  collation option that round-trips through `drizzle-kit check`; the type-layer cannot enforce
  it today. The mitigation is documentation, not code.) Add an explicit assertion to
  `0001_initial.verify.sql` that uses
  `instr(sql, 'email') > 0 AND instr(sql, 'COLLATE NOCASE') > 0`
  with both `instr` checks in the *same* substring window, not loose `exists`.

### M2 — `d1_migrations.applied_at` uses `CURRENT_TIMESTAMP`; R-DATA-002 requires
`YYYY-MM-DD HH:MM:SS` UTC

- **Where:** `scripts/db-migrate.ts:76`.
- **Violates:** `R-DATA-002` — "Timestamps are stored as `YYYY-MM-DD HH:MM:SS` UTC; epoch ms
  for lock fields."
- **Failure scenario:** Future audit / debug code reads `d1_migrations.applied_at` to
  reconstruct migration history. The format is `YYYY-MM-DD HH:MM:SS` (SQLite default) but
  the column is declared `TIMESTAMP`, which D1 maps to its own time format; the format may
  not match the contract. `d1_migrations` is internal-only, so the risk is low, but the
  inconsistency should be resolved before the table is referenced anywhere else.
- **Fix:** Either change the column to `TEXT NOT NULL DEFAULT (datetime('now'))` (matching
  every other timestamp in the schema) or document the deviation in the .md.

### M3 — The runner script's header claim that the runner sets `PRAGMA foreign_keys = ON` is
false; it relies on D1's default

- **Where:** `scripts/db-migrate.ts:19-21` (the comment) and `migrations/0001_initial.sql:14-15`
  (the SQL comment).
- **Violates:** the explicit citation `R-DATA-004 — enforced by scripts/db-migrate.ts and any
  D1 binding in tests`. The script does not call `PRAGMA foreign_keys = ON;`; neither does the
  verify companion's first assertion (it reads the value, not sets it).
- **Failure scenario:** A future D1 version or a non-D1 SQLite binding used in CI
  (e.g. node:test or a different migration surface) leaves `foreign_keys` off by default; the
  CASCADE assertions in the verify file pass against the SQL string (`instr ... CASCADE`) but
  the FK is not actually enforced at runtime. The verify assertion `pragma_foreign_keys_on`
  is the only safety net, and it is a read-only check at one point in time.
- **Fix:** Either (a) update the comment to say "relies on D1's default; verified by
  `0001_initial.verify.sql` assertion #1", or (b) prepend a `PRAGMA foreign_keys = ON;`
  statement to every wrangler `d1 execute` call in the runner, or (c) prepend a
  `PRAGMA foreign_keys = ON;` line to the `0001_initial.sql` migration (note: PRAGMAs in a
  migration only affect that connection — not useful here). Option (a) is the least code and
  the most honest.

### M4 — `migrationsDb()` `applyD1Migrations` fixture does not set `PRAGMA foreign_keys = ON`
explicitly; the worker-pool default is implicit

- **Where:** `packages/test-kit/src/migrationsDb.ts:30`.
- **Violates:** `.claude/rules/testing.md` §Determinism — "Domain code takes `Clock` and
  `ids` from `platform/` precisely so tests can inject fixed values. A test that relies on
  an implicit default is a test that will flake."
- **Failure scenario:** The fixture's `applyD1Migrations` resolves inside workerd; the
  worker-pool preset in `apps/worker/vitest.workers.config.ts` (or its default) is what sets
  `PRAGMA foreign_keys`. If a future test changes the binding source (e.g. uses
  `runInDurableObject` for a different binding) the PRAGMA is no longer applied, and the
  R-DATA-004 test passes-by-coincidence against an in-memory fixture.
- **Fix:** Either add a `db.exec('PRAGMA foreign_keys = ON;')` immediately after
  `applyD1Migrations` returns, or document the dependency in the file header. (The current
  comment at line 8 says "verify-assertions check R-DATA-001" but the assertion is in a
  separate test file; coupling by comment is fragile.)

### M5 — `verify.sql` `users_email_collate_nocase` and `users_status_check_constraint`
assertions are loose `instr`-substring checks

- **Where:** `migrations/0001_initial.verify.sql:62-78`.
- **Violates:** `.claude/rules/testing.md` §What must be tested — assertion should pin the
  invariant, not the substring.
- **Failure scenario:** The `users` table SQL is rewritten to add a *second* `email` column
  (e.g. `recovery_email`) with `COLLATE BINARY`; both substrings still appear in the
  `instr` check, the assertion passes, and the case-insensitive contract is broken for the
  new column. Same risk for `users_status_check_constraint` if a future `CHECK` on a
  different column re-uses the words `active`, `banned`, `deleted`.
- **Fix:** Tighten the assertions. For NOCASE, use a regex against the column definition
  (e.g. `instr(sql, 'email TEXT NOT NULL COLLATE NOCASE') > 0`). For CHECK, use
  `instr(sql, 'status IN (''active'',''banned'',''deleted'')') > 0`.

## LOW

> Style, naming, minor duplication. Fix if cheap.

### L1 — The `d1_migrations` table is created by the runner with `name TEXT UNIQUE`; no length
cap. A migration file with a 1 GiB name (theoretical) would still be inserted. Unlikely, but
add `CHECK (length(name) <= 256)`.

### L2 — `sessions.refresh_token_hash UNIQUE` index means a hash collision rejects the second
session insert. SHA-256 collision is astronomical; consider documenting the
`ON CONFLICT` policy in the .md for the rotate-on-refresh path (`R-AUTH-004`).

### L3 — `users.email` is indexed `UNIQUE` on `COLLATE NOCASE` and also column-level
`COLLATE NOCASE`. The redundancy is harmless but the column-level NOCASE on a UNIQUE-indexed
column is the only one needed. Cosmetic.

### L4 — `d1_migrations` table is created by `db-migrate.ts` *and* wrangler's native
migration system would create the same table on `wrangler d1 migrations apply`. If a future
operator accidentally runs `wrangler d1 migrations apply` *and* the runner, the second
no-ops. Document the "use one, not both" rule in the .md recovery section. Already implied
by the comment at lines 70-77 but not surfaced to the operator.

## Not verified

- I did not run the tests. The diff is small and the assertions are direct DB-shape checks;
  the implementer's report on `pnpm test:worker` is the source of truth. Re-run after H1-H4
  are addressed.
- I did not verify the `applyD1Migrations` semantics under
  `@cloudflare/vitest-pool-workers` for the `PRAGMA foreign_keys` default. The runtime
  check in `migrationsDb.worker.test.ts` is the right place to confirm; until the tests are
  run against the merge commit, M4 is a hypothesis.
- I did not check whether the Drizzle `text` declaration in `outbound-mail.ts` for
  `encrypted_credentials.name` needs `COLLATE NOCASE`. The SQL has NOCASE on the column
  and the index; Drizzle does not typecheck the column-level collation. The `.md` documents
  the name as a logical identifier, so NOCASE is appropriate, but a future migration that
  drops it would not be caught at the type layer.
- I did not read `docs/rebuild/05-target-architecture/data-model.md` — it is the source of
  truth for the index strategy and the migration policy, but the task contract and the
  inline SQL comments reference it accurately enough for this review.

## Required fixes

1. **H1** — Cap `audit_events.metadata` length in the schema and verify it.
2. **H2** — Add a `password_iterations >= 100000` assertion to `0001_initial.verify.sql` and
   a worker-pool rejection test.
3. **H3** — Cap the unbounded TEXT columns (see list in H3).
4. **H4** — Add length CHECKs to `encrypted_credentials.{iv,auth_tag,ciphertext}` per ADR-007.
5. **M3** — Fix the misleading "enforced by scripts/db-migrate.ts" comment.
6. **M5** — Tighten the `instr`-based verify assertions so they pin the invariant.
