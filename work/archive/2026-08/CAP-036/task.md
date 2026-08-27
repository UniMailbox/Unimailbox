# CAP-036 — JSON normalization (R-DATA-005 strictness for v1)

## Outcome

The two JSON-in-TEXT columns in `role_policies` (`ban_email_patterns_json`,
`avail_domain_patterns_json`) are normalized into two relational child tables
(`role_policy_ban_emails`, `role_policy_avail_domains`), one row per pattern. The migration
backfills from existing rows, drops the JSON columns, and preserves every existing API
contract end-to-end. `R-DATA-005` ("JSON blobs in text columns are forbidden") is satisfied
for these columns in v1.

Closes the **last allocated Phase 2 backend-only slice** per `docs/rebuild/execution-plan.md:38`
("CAP-033 (audit queries), CAP-034 (cursor pagination), and CAP-036 (JSON normalization)
remain allocated Phase 2 work"). Resolves the **R-DATA-005 relaxation** that
`migrations/0010_blocklist_and_role_policies.sql:12-17` recorded at CAP-035 closure time.

The user picked this slice over Phase 3 because strict R-DATA-005 compliance in v1 is the
chosen policy (per the orchestrator summary message 2026-08-25; the INV-001 audit
recommended deferring it but the user disagrees).

## Implementation status

**Implemented locally 2026-08-27.** Acceptance criteria 1–29 are complete after the
main-Codex review and fix pass. The remaining criterion is operator-owned preview evidence
(AC 30), so this capability is Implemented rather than Verified. The contract is archived
until that evidence is captured.

## Form (locked by user)

- **Two child tables**, not one merged table — matches the existing `banEmail` /
  `availDomain` contract split, gives each pattern set its own check constraints, lets
  future indexing (e.g. per-pattern `LIKE @%` queries) be column-targeted.
- **Recreate-table pattern** in the migration (not `ALTER TABLE DROP COLUMN`) — SQLite
  pre-3.35 doesn't support `DROP COLUMN`; D1 is recent enough but the recreate idiom is
  the canonical SQLite "modify table" pattern and is what the migration-tracking story
  requires for forward compatibility. Cost: a 4-step rename (new + copy + drop + rename).
- **The atomic replace (PUT semantics) on `setRolePolicy` becomes:** two child-table
  deletes + two set-based `INSERT ... SELECT value FROM json_each(?)` statements + one
  metadata upsert. Each array is bound once as transient JSON input; JSON is not persisted.
  These statements remain in the route's single `db.batch([...])` with audit and
  idempotency writes, so the consumer never sees a half-replaced state. This preserves
  the public 500-item cap without exceeding D1's 100-bound-parameters-per-query limit.
- **`RolePolicyRow` is replaced with `RolePolicy`** as the reader's return shape — the
  inbound-mail module already wanted parsed arrays; the contract's current shape just
  exposed the storage representation. Eliminates the `safeParseStringArray` helper that
  `policy-evaluator.ts:98-106` carried as defensive parsing at every use site (the
  reader becomes the single parse seam, matching the BlocklistReader pattern).
- **No new module.** Schema, repository, contract, route all in the admin module.
  Inbound-mail consumer (`entrypoints/inbound-email.ts:95-99`) changes only the variable
  type it iterates over.
- **No credential in any committed file.** No new SDK. No new dependency.

## Vertical slice

Single slice, single capability. Slice boundary: when the migration ships, the schema +
repository + contract + route + reader + evaluator + tests pass, the 5-way review's fix
pass lands, and the gate baseline is unchanged.

Closure (the FULL flip) happens when the operator runs the preview gate end-to-end with a
real PUT/GET cycle against `PUT /api/v1/admin/roles/:id/policy` and confirms the
operator-evidence folder captures the round-trip. Ledger-only update; no further code
changes.

## Spike verdicts (pre-implementation, BLOCKERs to clear before authoring)

### V1 — SQLite version + DROP COLUMN support (architecture B2)

**Verdict:** GREEN. Cloudflare D1 runs SQLite 3.45+ (per the [D1 changelog](https://developers.cloudflare.com/d1/platform/changelog/)), so `ALTER TABLE ... DROP COLUMN` works. **However**, the migrate-and-rename idiom is safer for the
deployable artifact (no DDL semantic differences across SQLite versions) and is what the
existing migrations use. **Implementer uses the recreate-table pattern, not DROP COLUMN.**

### V2 — D1 query limits for the PUT atomic replace (architecture H3)

**Verdict:** GREEN. The previous draft confused D1's **100 bound parameters per query**
limit with a nonexistent 100-statements-per-batch limit. `D1Database.batch()` accepts an
array of prepared statements and executes it sequentially as a transaction. The repository
must not emit one statement per pattern: each child collection is inserted with one
prepared `INSERT ... SELECT ?, value FROM json_each(?) WHERE type = 'text'` statement.
The complete PUT therefore uses a small fixed statement count and two parameters per child
insert. The existing `.max(500)` public contract remains unchanged; 501 still fails Zod
validation.

### V3 — JSON backfill semantics (architecture H1)

**Verdict:** GREEN. SQLite's `json_each()` table-valued function
expands a JSON array into rows; the migration uses `INSERT OR IGNORE INTO
role_policy_ban_emails SELECT role_id, json_each.value FROM role_policies,
json_each(ban_email_patterns_json) WHERE json_each.type = 'text'` to backfill. The
`type = 'text'` predicate skips non-string elements defensively. Exact lossless backfill is
proved by a Workers/D1 upgrade test that seeds 0018-era JSON rows, applies 0019, and compares
the child rows. The companion verify runs after the old columns have been dropped, so it
checks durable structural/data invariants rather than pretending the destroyed source is
still available.

## Acceptance criteria

### Migration (migrations/0019_role_policy_normalize.sql + .verify.sql)

- [x] 1. **`0019_role_policy_normalize.sql`** recreates `role_policies` to drop the JSON
  columns and adds `role_policy_ban_emails` + `role_policy_avail_domains` child tables.
  Steps in order:
  - 1a. `CREATE TABLE role_policy_ban_emails (role_id TEXT NOT NULL REFERENCES
    roles(id) ON DELETE CASCADE, pattern TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 254), PRIMARY KEY (role_id, pattern))`.
  - 1b. `CREATE TABLE role_policy_avail_domains (role_id TEXT NOT NULL
    REFERENCES roles(id) ON DELETE CASCADE, pattern TEXT NOT NULL CHECK (length(pattern)
    BETWEEN 2 AND 254), PRIMARY KEY (role_id, pattern))`.
  - 1c. Backfill via `json_each` (V3 verdict).
  - 1d. `CREATE TABLE role_policies_new (role_id TEXT PRIMARY KEY REFERENCES roles(id)
    ON DELETE CASCADE, updated_by TEXT REFERENCES users(id) ON DELETE SET NULL, updated_at
    TEXT NOT NULL DEFAULT (datetime('now')))`.
  - 1e. `INSERT INTO role_policies_new SELECT role_id, updated_by, updated_at FROM
    role_policies`.
  - 1f. `DROP TABLE role_policies`.
  - 1g. `ALTER TABLE role_policies_new RENAME TO role_policies`.
  - 1h. `INSERT OR IGNORE INTO d1_migrations (name) VALUES
    ('0019_role_policy_normalize.sql')`.
- [x] 2. **`0019_role_policy_normalize.verify.sql`** asserts:
  - 2a. Migration tracking row exists.
  - 2b. The new `role_policies` table has exactly 3 columns (role_id, updated_by,
    updated_at); no `ban_email_patterns_json` or `avail_domain_patterns_json` columns
    exist (use `PRAGMA table_info(role_policies)`).
  - 2c. `role_policy_ban_emails` and `role_policy_avail_domains` exist with the
    composite PK and FK ON DELETE CASCADE.
  - 2d. No orphan child rows, no empty/out-of-range patterns, and no duplicate
    `(role_id, pattern)` pairs exist. The pre-0019 → 0019 Workers upgrade test owns exact
    source-to-target backfill equality because the source columns no longer exist when the
    companion runs.
  - 2e. The `length(pattern) BETWEEN ...` CHECK constraints are present; Workers tests
    execute out-of-range writes and prove they are rejected.
- [x] 3. Repeat deployment is idempotent through `d1_migrations`: the pending-only runner
  applies 0019 once and a second run is a no-op. The raw destructive SQL file is not claimed
  to be independently rerunnable after its source columns are gone. A Workers test injects
  a migration failure and proves D1 rolls the batch back without a partial child/schema state.

### Schema + repository (apps/worker/src/database/schema/admin.ts + role-policy-repository.ts)

- [x] 4. `rolePolicies` Drizzle schema drops `banEmailPatternsJson` + `availDomainPatternsJson`
  columns; gains no replacements (the child tables are separate Drizzle exports). The
  type `RolePolicyRowDrizzle` reflects the new 3-column shape.
- [x] 5. `NewRolePolicyRowDrizzle` similarly drops the JSON columns.
- [x] 6. New Drizzle exports for `rolePolicyBanEmails` + `rolePolicyAvailDomains` (each
  with `roleId` + `pattern` + composite PK).
- [x] 7. `apps/worker/src/modules/admin/role-policy-repository.ts` refactor:
  - 7a. `getRolePolicy(db, roleId)` uses one metadata query plus one query per child
    table, then returns `RolePolicy` directly. It must not join both one-to-many tables,
    which would create a ban × domain Cartesian product.
  - 7b. `setRolePolicy(db, input)` becomes: `prepareSetRolePolicyBatch` builds two
    parameterized deletes, two set-based `INSERT ... SELECT ?, value FROM json_each(?)
    WHERE type = 'text'` statements (one transient JSON binding per array), and one
    metadata upsert. The request remains `.max(500)` per array; statement and parameter
    counts stay fixed regardless of pattern count.
  - 7c. `loadRolePoliciesForRoleIds(db, roleIds)` issues three bounded queries (metadata,
    ban children, domain children), groups rows by role in application code, and returns
    `ReadonlyArray<RolePolicy>`. It must not join both child tables.
  - 7d. `prepareSetRolePolicy` is renamed to `prepareSetRolePolicyBatch` (clearer shape);
    returns `ReadonlyArray<D1PreparedStatement>` so the caller can wrap in `db.batch(...)`.
  - 7e. JSON-storage parsing helpers are deleted. A small grouping helper for relational
    child rows is allowed and must reject malformed database rows rather than silently
    dropping them.

### Contract (packages/contracts/src/admin/role-policy.ts)

- [x] 8. `RolePolicyRow` interface is **deleted**. The reader's return shape is
  `ReadonlyArray<RolePolicy>`, eliminating the parse-at-use-site pattern.
- [x] 9. `RolePolicyReader` interface updates: `loadRolePoliciesForRoleIds(roleIds):
  Promise<ReadonlyArray<RolePolicy>>`.
- [x] 10. `setRolePolicyRequestSchema` retains `max(500)` per array. Inline comments
  document the set-based `json_each(?)` write, D1's 100-bound-parameters-per-query limit,
  and the child-table `length(pattern) BETWEEN ...` checks.
- [x] 11. `banEmailPatternSchema` + `availDomainPatternSchema` are unchanged (the patterns
  themselves don't change; only their storage shape does).

### Reader + inbound-mail consumer (apps/worker/src/modules/admin/role-policy-repository.ts + entrypoints/inbound-email.ts)

- [x] 12. `createRolePolicyReader` returns the new shape: `RolePolicy[]`.
- [x] 13. `apps/worker/src/entrypoints/inbound-email.ts:95-99` reads the reader's return
  type as `ReadonlyArray<RolePolicy>`; `evaluateInboundPolicy(parsed, rolePolicies,
  blocklistEntries)` receives parsed arrays directly.
- [x] 14. `apps/worker/src/modules/inbound-mail/policy-evaluator.ts`:
  - 14a. `rolePolicies: ReadonlyArray<RolePolicyRow>` → `ReadonlyArray<RolePolicy>`.
  - 14b. The `safeParseStringArray` helper (`:98-106`) is **deleted** — `policy.banEmail`
    + `policy.availDomain` are already `string[]` arrays from the parsed shape.
  - 14c. The inline `policy.ban_email_patterns_json` parsing loop becomes
    `for (const pattern of policy.banEmail)`.
  - 14d. The inline `policy.avail_domain_patterns_json` parsing loop becomes
    `for (const pattern of policy.availDomain)`.

### Route (apps/worker/src/http/routes/admin-role-policies.ts)

- [x] 15. The PUT route's idempotency record + audit row + business writes still live in
  one `db.batch([...])` (CAP-046 pattern). The business-write set is now the
  `prepareSetRolePolicyBatch` return value (an array of statements), prepended to the
  `db.batch` call alongside `prepareCreateAuditEvent` + `prepareCreateIdempotencyRecord`.
- [x] 16. The route handler's variable types update: `const policy = await
  getRolePolicy(c.env.DB, roleId)` returns `RolePolicy | null` (not `RolePolicyRow | null`).
- [x] 17. The `empty: RolePolicy` fallback (when no row exists) keeps its shape
  (`banEmail: [], availDomain: []`).

### Worker tests (apps/worker/test/* + extensions)

- [x] 18. **New** `apps/worker/test/role-policy-normalize.worker.test.ts` exercises:
  - 18a. Migration backfill correctness: a fixture pre-populates `role_policies` with
    JSON arrays, runs the migration in a transaction, asserts every pattern is in the
    corresponding child table.
  - 18b. `getRolePolicy` returns parsed arrays for a role with patterns.
  - 18c. `getRolePolicy` returns `null` for a role with no row.
  - 18d. `setRolePolicy` atomically replaces both arrays (delete + insert + metadata in
    one batch); subsequent `getRolePolicy` returns the new arrays; no half-replaced state.
  - 18e. `setRolePolicy` with empty arrays removes all patterns (the metadata row
    survives).
  - 18f. `loadRolePoliciesForRoleIds` returns parsed arrays for multiple roles using the
    three-query grouping shape; empty input returns empty output without a SQL roundtrip.
    A role with two ban and three domain patterns returns 2 + 3 items, not six joined rows.
  - 18g. The existing 500-per-array cap is preserved: 500 patterns write successfully in
    the fixed statement-count batch and 501 patterns produce 400 VALIDATION_ERROR.
  - 18h. ON DELETE CASCADE: deleting a `roles` row removes both child tables'
    corresponding rows + the `role_policies` metadata row.
  - 18i. `evaluateInboundPolicy` continues to honor banEmail precedence over
    availDomain (existing semantics unchanged; the test pins R-INBOUND-006).
- [x] 19. **Existing** `apps/worker/src/http/routes/admin-role-policies.worker.test.ts`
  passes unchanged in structure (the contract's surface to the route didn't change),
  with type assertions updated to `RolePolicy` instead of `RolePolicyRow`.
- [x] 20. **Existing** `apps/worker/src/modules/inbound-mail/policy-evaluator.test.ts` (or
  equivalent) pins the parsing shape change (the function now takes `RolePolicy[]`
  instead of `RolePolicyRow[]`).
- [x] 21. **Existing** `apps/worker/src/modules/inbound-mail/pattern-matchers.test.ts`
  passes unchanged (it tests `matchesBanEmail` + `matchesAvailDomain` which are pure
  functions and unaffected by storage shape).
- [x] 22. The full Workers suite is green. Test isolation/configuration must prevent the
  previously documented shared-D1 parallel reset failures; a known-red baseline is not an
  acceptable closure condition.

### Gates (orchestrator-run subset)

- [x] 23. `pnpm scaffold doctor` 14/14 (unchanged — no new doctor check needed for
  this slice; the existing `R-DATA-005` check is generic).
- [x] 24. `pnpm typecheck` clean.
- [x] 25. `pnpm lint` clean.
- [x] 26. `pnpm test:unit` all green — count grows by the new contract tests (parser
  shape change, child-table invariants).
- [x] 27. `pnpm test:worker` all green, including the upgrade/backfill, 500-item replace,
  Cartesian-product regression, failure rollback, and existing suites.
- [x] 28. `pnpm build` EXIT=0.
- [x] 29. **No new dependency** to `apps/worker/package.json` or `apps/web/package.json`.

### Closure (operator-driven, not orchestrator-runnable)

- [ ] 30. Operator runs `ENVIRONMENT=preview pnpm scaffold deploy` (migrations
  pending-only applies and verifies `0019_role_policy_normalize.sql`); exercises
  `PUT /api/v1/admin/roles/:id/policy` with a 500-pattern max array, asserts the GET
  returns parsed arrays; exercises `GET /api/v1/admin/audit-events?action=role_policy.set`
  and confirms the audit row still records the transition. Captures evidence in
  `work/reviews/CAP-036-evidence-<OPERATOR>-<YYYY-MM-DD>/`.

## File ownership

| File | Owner |
|---|---|
| `work/archive/2026-08/CAP-036/task.md` | Orchestrator (this contract) |
| `migrations/0019_role_policy_normalize.sql` (NEW) | `implementer-cap036` |
| `migrations/0019_role_policy_normalize.verify.sql` (NEW) | `implementer-cap036` |
| `apps/worker/src/database/schema/admin.ts` (surgical edit) | `implementer-cap036` |
| `apps/worker/src/modules/admin/role-policy-repository.ts` (refactor) | `implementer-cap036` |
| `apps/worker/src/modules/inbound-mail/policy-evaluator.ts` (refactor — drop safeParse) | `implementer-cap036` |
| `apps/worker/src/entrypoints/inbound-email.ts` (type update only) | `implementer-cap036` |
| `apps/worker/src/http/routes/admin-role-policies.ts` (surgical edit on PUT batch) | `implementer-cap036` |
| `packages/contracts/src/admin/role-policy.ts` (RolePolicyRow deleted; caps lowered) | `implementer-cap036` |
| `packages/contracts/src/admin/role-policy.test.ts` (NEW — zod cap assertions) | `implementer-cap036` |
| `apps/worker/test/role-policy-normalize.worker.test.ts` (NEW) | `implementer-cap036` |
| `apps/worker/src/modules/inbound-mail/policy-evaluator.test.ts` (existing — type update) | `implementer-cap036` |
| `apps/worker/src/http/routes/admin-role-policies.worker.test.ts` (existing — type update) | `implementer-cap036` |
| `apps/worker/src/modules/admin/index.ts` (re-export any new helpers) | `implementer-cap036` |
| `docs/rebuild/capability-ledger.md` (CAP-036 row) | Orchestrator (closure) |
| `docs/rebuild/implementation-log.md` (closure entry) | Orchestrator (closure) |

No production code outside this list is touched. No new module, no new binding, no new
SDK usage. This is a backend-only normalization.

## Review surface (5-way, parallel after implementer COMPLETE)

| Reviewer | Focus |
|---|---|
| `architecture-reviewer` | Did the implementer honor V1/V2/V3 (recreate table, fixed-count set writes, Workers backfill proof)? Confirm no two-child JOIN Cartesian product and that the route retains one atomic business/audit/idempotency batch. |
| `code-reviewer` | Drizzle typing, three-query grouping, prepared-statement binding, stable ordering, malformed-row handling, and exact 500/501 boundary. Confirm transient JSON is only a bound `json_each(?)` input and never storage. |
| `security-reviewer` | The 500-item public cap remains protected by the 1 MB body limit and per-pattern length caps. Confirm no SQL interpolation, no cross-role row mixing, and failure rollback leaves no partially replaced policy. |
| `qa-reviewer` | AC traceability, pre-0019 backfill equality, runner-level repeat no-op, migration failure rollback, 2×3 Cartesian regression, 500 success/501 rejection, companion assertions, and fully green gates. |
| `frontend-reviewer` | **Not applicable** — no `apps/web/` changes this slice. Documented in this contract. |

After review, single-implementer fix pass on the consolidated criteria; then closure.

## Exit-criteria mapping (R-DATA-005 closure)

| R-DATA-005 facet | Where it lands |
|---|---|
| "JSON blobs in text columns are forbidden" | AC 1 + AC 2 (column drop + verify.sql) |
| "Relational columns only" | AC 4–6 (Drizzle schema + child tables) |
| "Migrations are the deployable artifact" | AC 1 (SQL is the source of truth; Drizzle schema is typing only) |
| "No inline SQL string concatenation" | AC 7d (`prepareSetRolePolicyBatch` returns prepared statements; no raw SQL) |

## Risks + open questions

- **Transient JSON input must stay an implementation detail.** `json_each(?)` is used only
  to expand a bound array inside one INSERT statement. Persisting that string or returning
  it from the repository would reintroduce the R-DATA-005 violation.
- **Backfill ordering** — the migration must INSERT child rows BEFORE dropping the JSON
  columns; otherwise the data is lost. The migrate-and-rename idiom ensures this (the new
  metadata table is created alongside the children; the drop happens after the copy).
- **`apps/web/` has no UI changes.** The admin role-policy page already sends/expects
  `banEmail: string[]` + `availDomain: string[]` — the contract change is invisible to the
  client.
- **The recreate-table migration drops the `length(ban_email_patterns_json) <= 65536`
  CHECK on the old `role_policies` table.** That check is no longer relevant (the JSON
  column is gone). The new child tables have per-pattern length CHECKs that replace it.
- **Operator evidence** — the operator runbook reuses the CAP-045 runbook's Step 1 (deploy)
  + Step 6 (audit query). The new evidence is Step 7 (PUT/GET round-trip on the new shape)
  captured to `work/reviews/CAP-036-evidence-<OPERATOR>-<YYYY-MM-DD>/`.

## Out of scope (deferred rows recorded at closure)

- **D-CAP-036-A** — R-DATA-005 audit on the rest of the codebase (any other TEXT JSON
  columns hiding in the schema). The implementer greps for `TEXT NOT NULL DEFAULT '[]'`
  + similar JSON-shaped columns before declaring CAP-036 closed; if any are found, they
  are added to this follow-up list.
- **D-CAP-036-B** — Per-pattern indexing on `role_policy_ban_emails.pattern` (LIKE @% /
  exact email match). Today the read path JOINs and filters in JS (`evaluateInboundPolicy`).
  If future load on inbound mail requires per-pattern index lookups, an index on `pattern`
  is the natural addition. Tracked for whichever capability observes the load.
- **D-CAP-036-C** — If the public cap grows beyond what the 1 MB request limit and current
  inbound evaluation cost can safely support, measure first and choose a new bounded API.
  This capability does not invent a lower D1 batch ceiling that the platform does not have.

(Names provisional; orchestrator renames against the next capability's task ID.)
