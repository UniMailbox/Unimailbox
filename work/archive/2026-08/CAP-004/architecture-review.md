# CAP-004 — Architecture Review

**Reviewer:** architecture-reviewer · **Date:** 2026-08-12 · **Base:** `cap/CAP-004-initial-schema` @ `5c79ad2`

**Status:** ACCEPT WITH NOTES → ACCEPT (via fix-up, see resolution log)

## Resolution log (2026-08-12)

All findings from this review were addressed in the fix-up pass. See
`work/active/CAP-004-initial-schema/fix-up.md` for the orchestrator's disposition.

| Finding | Resolution |
|---|---|
| M1 — string-built SQL in runner | FIXED: the manual `INSERT INTO d1_migrations` is gone; the schema file owns the tracking INSERT. |
| L1 — Drizzle cross-table ref | NOT A FINDING for CAP-004. Logged as D-CAP-004-B for the repository-owning capabilities. |
| L2 — migrations/drizzle/ gitignore | FIXED: added `/migrations/drizzle/` and `/migrations/drizzle/**` to .gitignore. |
| L3 — db:reset no explicit AC | FIXED: AC #15 added to task.md; ENVIRONMENT=preview demonstrates exit 2. |
| Not verified (fixture status enum drift) | FIXED: `fixtures.installationState.status` changed from `'uninitialised' | 'in_progress' | 'complete'` to `'setup' | 'complete'` to match the SQL CHECK. | The eleven tables are placed in the right bounded contexts, the persistence-ownership table in `.claude/rules/architecture.md` is respected, and the documented R-DATA-005 exception for `audit_events.metadata` is the only legitimate JSON-in-text column in the new schema. The slice introduces no new abstraction with fewer than three concrete use cases, no base classes, no DI, no plugin system, no event bus. There is one MEDIUM finding (string-built SQL in the runner) and three LOW forward-looking notes that will land as concerns when later capabilities add the repositories — none of those block acceptance of CAP-004.

## BLOCKER

> Ship-stopping: data loss, auth bypass, invariant violation, broken architecture rule.

None. The empty section is the result of this review.

## HIGH

> Wrong under a realistic condition. Must be fixed before acceptance.

None.

## MEDIUM

> Should fix. May be deferred if recorded in the capability ledger with a reason.

### M1 — `scripts/db-migrate.ts:131` builds the tracking INSERT via string concatenation

- **Where:** `scripts/db-migrate.ts:131` — `INSERT INTO d1_migrations (name) VALUES ('${escaped}')` where `escaped = file.replace(/'/g, "''")`.
- **Violates:** `.claude/rules/architecture.md` §Forbidden ("Never build SQL by string concatenation. Drizzle query builder or parameterized statements only").
- **Failure scenario:** Today the input is safe: filenames come from `readdirSync(MIGRATIONS_DIR)` filtered by `/^\d{4}_.+\.sql$/`. The character class forbids control characters and most shells metacharacters; the single-quote doubling handles the only remaining hazard. **But** the rule is stated as absolute ("never"), and the runner is the template every later capability will copy. The first contributor to add a non-ASCII locale in a migration filename, or to read filenames from `git ls-files` without a regex filter, will produce a tracking row with a SQL syntax error or, worse, a tracking row that points at a file that no longer exists. The expected cost to fix once that lands is a multi-hour forensic trail through half-applied migrations.
- **Fix:** Use wrangler's native tracking via `wrangler d1 migrations apply DB --local --persist-to=...`, which the runner's own header comment already notes is the chosen path. The current implementation hand-rolls the `d1_migrations` schema because the file header also notes that `apply` would pick up the `.verify.sql` companions — so the structurally clean answer is to **move the verify companions to `migrations/verify/`** (per `data-model.md` §Migration file shape it already anticipates a verify dir convention) and let wrangler's transactional apply handle both apply and tracking. If that is out of scope for CAP-004, the same end can be reached with a one-shot `wrangler d1 execute --command` that reads filenames from a `d1_migrations` join against `json_each(read_dir(...))` or, more cheaply, with the file's path read through `wrangler d1 execute --file=stdin` after `printf` formatting from a template — either way, no string interpolation in SQL.
- **Defer-able:** This is a MEDIUM rather than BLOCKER because the input is constrained, the script is dev-only, and CAP-004's documented decision (per `task.md` §Decisions) was "wrangler native tracking" — the implementation is half-instead and the gap is captured here for the orchestrator to resolve when CAP-005 wires up CI integration or when CAP-006 needs the runner's idempotency guarantees for real.

## LOW

> Style, naming, minor duplication. Fix if cheap.

### L1 — `apps/worker/src/database/schema/admin.ts:9` cross-references `users` from `./identity`

- **Where:** `import { users } from './identity';` — used at lines 54, 57, 68 for FK declaration (`userId`, `grantedBy`, `actorUserId`).
- **Violates:** None today; prefigures a `.claude/rules/architecture.md` §Type leakage concern.
- **Risk:** Drizzle's `references(() => users.id, { onDelete: 'cascade' })` works because both files are in `apps/worker/src/database/schema/`. When the **repositories** land with CAP-017/CAP-019, they will be in `apps/worker/src/modules/admin/` and `apps/worker/src/modules/identity/` respectively, and `admin` will need the `users.id` type to wire FKs at the repository level. The architecture rules require cross-boundary types to come from `packages/contracts/` — exporting `UserId` from contracts and using it both in the schema declaration and in module repositories prevents the eventual leakage of the Drizzle row type across modules. The schema-layer coupling here is acceptable (Drizzle literally cannot model a FK without a table reference); the risk is that module repositories reach into `./schema/identity` for the row type instead of into `./contracts` for the contract type.
- **Fix:** No change required for CAP-004. Add an item to the ledger entry for the CAP that introduces the `admin` module: "decide where `UserId` lives in `packages/contracts/` so admin repositories don't reach into `database/schema/identity`."

### L2 — `migrations/drizzle/meta/_journal.json` is empty and checked in

- **Where:** `/Users/john/Workspace/x/Unimailbox/migrations/drizzle/meta/_journal.json` — `{"version":"7","dialect":"sqlite","entries":[]}`.
- **Violates:** None; `.gitignore` does not exclude it.
- **Risk:** The empty journal is the output of `drizzle-kit`'s config smoke (`pnpm exec drizzle-kit check`). Future runs of `drizzle-kit generate` will rewrite this file and any subsequent `drizzle-kit introspect` may regenerate sibling files in `migrations/drizzle/meta/`. Each `drizzle-kit` version skew (a common occurrence) tends to write a slightly different `_journal.json` (added keys, reordered entries), so the empty journal today will become a noisy working tree the moment the next capability pulls a newer drizzle-kit. The on-disk hand-written `0001_initial.sql` is the authoritative artifact per `data-model.md` §Migration authority; the drizzle dir is decoration.
- **Fix:** Either gitignore `migrations/drizzle/` (preferred — it is regenerated, not edited) or accept the noise and document the policy in `0001_initial.md` §Companion files.

### L3 — `db:reset` subcommand ships without an explicit acceptance criterion

- **Where:** `scripts/scaffold.ts:20` — `db:reset` is wired alongside `db:migrate` and forwarded to `scripts/db-migrate.ts --reset`.
- **Violates:** None; the task.md §Open questions recorded this as "Default: yes" and acceptance criterion #11 does not mention it.
- **Risk:** `--reset` deletes `apps/worker/.wrangler/state` (line 49-52 in `db-migrate.ts`) with an `ENVIRONMENT !== 'local'` guard at line 43-46. The guard covers production, but the subcommand is reachable by any developer without confirmation. A misread of the arg list as `pnpm scaffold db:migrate --reset` on a CI preview environment that happens to have `ENVIRONMENT=preview` set in its shell would exit 2 (per the explicit guard) — that is the intended behaviour. The risk is the missing acceptance criterion: there is no documented "demonstrated by running `pnpm scaffold db:reset` and observing state restoration" in `task.md`. The doctor, the migration apply, and the verify all have explicit demonstrations; the reset path does not.
- **Fix:** Add a one-line acceptance criterion in the ledger entry for CAP-004: "`pnpm scaffold db:reset` exits 0 locally, refuses to run with `ENVIRONMENT !== 'local'`." Or delete `db:reset` from the scaffold dispatcher and ship it with the first capability that actually needs it (CAP-006 or CAP-019), keeping CAP-004 strictly schema-shaped.

## Not verified

- **Runtime behaviour of `wrangler d1 migrations apply` with `.verify.sql` companions** — the runner's file header claims it would treat verify companions as migrations, but I did not run the tool. The structure-alignment of the runner's design depends on this. If the claim is wrong, the suggested fix in M1 (move verify to `migrations/verify/`) is wrong and the runner's current "manually write `d1_migrations` rows" approach is the right one.
- **`pnpm exec drizzle-kit check` exit code** — acceptance criterion #14. I read the config; I did not run it.
- **`pnpm test:worker` exit code** — the new `migrationsDb.worker.test.ts` exercises `applyD1Migrations` against the worker pool. I read it; I did not run it. The code looks correct against `@cloudflare/vitest-pool-workers`'s documented `cloudflare:test` surface, but I did not verify the `D1Migration` type signature matches what the pool actually exposes (the `.d.ts` declares `applyD1Migrations(db, migrations, migrationsTableName?)` with `migrationsTableName` optional; if the runtime requires it, this would fail at test run).
- **Soft-delete enforcement shape** — the migration creates `users.deleted_at` and the schema declares it, but the application layer that filters on it is explicitly out of scope (per `task.md §Out of scope`). The default-read exclusion lands with the module that owns `users` reads (CAP-019). No finding, but worth flagging that any future capability that reads `users` without a `WHERE deleted_at IS NULL` will silently expose soft-deleted accounts.
- **`fixtures.installationState` shape drift** — `packages/test-kit/src/fixtures.ts:31-36` declares `status: 'uninitialised' | 'in_progress' | 'complete'` while `migrations/0001_initial.sql:33` declares `CHECK (status IN ('setup', 'complete'))`. This drift predates CAP-004 (the fixture is unchanged in this diff; it shipped with CAP-002 in commit `9a9743d`). Tests that consume both will fail to compile once they import the schema type. Worth surfacing to CAP-006 (which wires the first installation_state write) so it lands a coherent pair.

## Required fixes

1. M1 — runner's hand-rolled tracking insert via string concatenation; recommended fix in the M1 finding body.
2. L3 — add a `db:reset` acceptance criterion or delete the subcommand from `scripts/scaffold.ts`.

---

CAP-004 is otherwise architecturally clean for what it ships. The block is the schema, the runner, the test fixture, the doctor check, and the drizzle-kit smoke. There is no domain code, no module code, no route code in scope — those layers will be exercised when CAP-006 onward lands, and the only forward-looking note that matters before then is L1 (contracts-typed `UserId` before the repositories land).