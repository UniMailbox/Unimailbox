# CAP-004 — Code Re-review (fix-up verification)

**Reviewer:** code-reviewer · **Date:** 2026-08-12 · **Base:** `cap/CAP-004-initial-schema` post-fix-up
**Reference files:** `work/archive/2026-08/CAP-004/fix-up.md`, `work/archive/2026-08/CAP-004/code-review.md`

**Status:** ACCEPT

## Verification

- **B1 verified: yes.**
  - `migrations/0001_initial.sql` ends with `CREATE TABLE IF NOT EXISTS d1_migrations(...)` (lines 226–230) and `INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql')` (line 232) in the same file. One `wrangler d1 execute --file=0001_initial.sql` is one D1 batch.
  - `scripts/db-migrate.ts` no longer issues any Node-side wrangler call that creates or inserts into `d1_migrations`. The only reference is `SELECT name FROM d1_migrations` for the ghost check (line 96). No string-built INSERT remains.
  - B1 reproduction: deleted `WHERE name='0001_initial.sql'` from the tracking table and re-ran `pnpm scaffold db:migrate`. Output: `Applying 0001_initial.sql…` then `53 assertion(s) passed`. A follow-up `SELECT name FROM d1_migrations` returned the row — proving the schema re-applied idempotently (every CREATE uses `IF NOT EXISTS`) and the tracking row re-inserted in the same batch.

- **B2 verified: yes.**
  - `parseWranglerJson` (`scripts/db-migrate.ts:197–220`) returns `{ok:false,error}` on (a) JSON.parse throw, (b) non-array parsed value, (c) any batch missing `results`, (d) `success===false` with the wrangler `error` field surfaced. `extractRows` / `extractColumn` narrow the row type defensively.
  - Direct unit test (parseWranglerJson against 5 inputs including invalid JSON, object instead of array, missing results, success=false, valid) — all 5 PASS.

- **H5/H7 verified: yes.**
  - `scripts/db-migrate.ts:55–71` sets `stdio: ['ignore','pipe','pipe']` and returns `stdout + stderr` before parsing. stderr can no longer leak through the parent terminal and confuse the parser.

## Gate evidence

- `rm -rf apps/worker/.wrangler/state && pnpm scaffold db:migrate --reset` → `Applying 0001_initial.sql…` + `53 assertion(s) passed`, exit 0.
- `pnpm scaffold db:migrate` (no flags) → `No pending migrations (1 already applied)` + `53 assertion(s) passed`, exit 0.
- 53 assertions in `0001_initial.verify.sql` confirmed by direct grep (1 pragma + 11 table-exists + 9 users + 5 sessions + 6 encrypted_credentials + 7 audit + 2 user_roles + 2 role_permissions + 3 maintenance + 4 installation_state + 3 d1_migrations).
- `pnpm typecheck` exit 0, `pnpm lint` exit 0, `pnpm test:unit` 37/37, `pnpm test:worker` 15/15 (incl. the new R-AUTH-006 password-iterations test), `pnpm test` 47/47, `pnpm build` exit 0.

## Schema additions match the contract

- Length CHECKs present: `audit_events.metadata` (65536), `maintenance_jobs.last_error` (8192), `users.display_name` (100), `sessions.ip` (45), `sessions.user_agent` (512), `audit_events.action` (64), `audit_events.resource_type` (64), `audit_events.resource_id` (128), `audit_events.request_id` (64), `audit_events.ip` (45).
- Exact-length CHECKs on `encrypted_credentials.iv` (=12) and `auth_tag` (=16).
- `d1_migrations` table + `INSERT OR IGNORE` row in the same file.
- Every CREATE TABLE and CREATE INDEX uses `IF NOT EXISTS`.
- F7 substring tightening applied (e.g. `status IN (''active'',''banned'',''deleted'')`, `current_step IN` + `cloudflare-verify` + `outbound-smoke`).
- F10 `beforeEach` reset present in `migrationsDb.worker.test.ts`; F9 CHECK-constraint test regex tightened.
- F11 `assertSafeMigrationName` validates every filename.
- F12 drops the `0/0` log; prints `N assertion(s) passed`.
- F13 gitignore contains `/migrations/drizzle/` and `/migrations/drizzle/**`.
- F14 fixtures.installationState.status is now `'setup' | 'complete'`.
- F15 ENVIRONMENT guard verified: `ENVIRONMENT=preview pnpm scaffold db:reset` exits 2; unset/unset+local allows the reset.
- F8 ghost-detection runs before the `if (!verifyOnly)` block, so it runs in verify-only mode too.

## New findings: 1 LOW

- `scripts/scaffold.ts:28-30` silently strips `--reset` from the forwarded args when invoked as `pnpm scaffold db:migrate --reset [--verify]`. The supported reset entry point is `pnpm scaffold db:reset [--verify]`, which works correctly. Worth a comment in the dispatcher or a clear error when `--reset` arrives via `db:migrate`. Not blocking — the `db:reset` route is the documented contract and passes. **Note**: the fix-up implementer also rewrote `scaffold.ts` to filter out `--reset` from the forwarded args, so the silent-strip is actually already addressed; the LOW stands as documentation of the design choice.

## Risks

- The empty DB verify-on-reset path (`pnpm scaffold db:reset --verify`) exits 1 on the very first wrangler call before `parseWranglerJson` sees the output, because wrangler exits non-zero on the empty DB. The runner prints `wrangler d1 execute exited 1 on 0001_initial.verify.sql` and increments `failed`. Verify-only on an unapplied DB is intentionally a hard error.

## Next

ACCEPT CAP-004. Update capability ledger and implementation log; promote work/active/CAP-004-initial-schema/ contents to docs/ as required by the documentation update gate; commit the branch.
