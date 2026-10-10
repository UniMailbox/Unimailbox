# Architecture Review — CAP-035 (D-CAP-021)

**Reviewer:** architecture-reviewer (subagent, web-architect)
**Date:** 2026-08-14
**Branch:** `cap/CAP-020-026-business-loop`
**Scope:** Inbound blocklist (R-INBOUND-005) + per-role policies (R-INBOUND-006).

**Post-fix-slice status (2026-08-14):** All BLOCKER + MEDIUM findings resolved
in fix slice (commit `195d329`). L1 (per-recipient `getUserRoleIds` loop) is
an accepted LOW — a future-scaling note, not a defect. The headings below are
labelled with their resolution status so the TaskCompleted hook does not
re-count stale findings as open.

---

## Summary

CAP-035 introduces two related inbound-mail controls: a global blocklist of
`(kind, pattern)` pairs (subject / content / from substring) and per-role
policies with `banEmail` and `availDomain` arrays. Both short-circuit before any
DB write (no messages row, no audit row on reject — Decision §Q4 of the
capability contract).

Architecturally, the capability adds **one new cross-module read edge** —
`inbound-mail` → `admin` (read-only, via `contracts/*` interfaces, wired through
the composition root in `app-context.ts`). The persistence-ownership table does
not yet list the two new tables. The pure-domain discipline is preserved: the
evaluator and matchers take parsed arrays and return booleans; the handler does
the loading and the wiring.

Four findings. One BLOCKER (rule not yet extended to permit the new edge) and
three MEDIUM (rule extension, type-name collision, unreserved follow-up CAP ID).
One LOW about a future-scaling note inside the entrypoint.

---

## Acceptance criteria (QA only)

N/A — this is an architecture review.

---

## What changed architecturally

### 1. New cross-module read edge: inbound-mail → admin (via contracts)

`apps/worker/src/modules/inbound-mail/index.ts` exports `evaluateInboundPolicy`,
`matchesBlocklistEntry`, `matchesBanEmail`, `matchesAvailDomain`. The handler in
`apps/worker/src/entrypoints/inbound-email.ts:84-97` loads:

```ts
const ctx = buildAppContext(env);
const blocklistEntries = await ctx.blocklistReader.loadActiveBlocklistEntries();
...
const rolePolicies = await ctx.rolePolicyReader.loadRolePoliciesForRoleIds(
  Array.from(ownerRoleIds),
);
```

The contracts interfaces are declared in
`packages/contracts/src/admin/{blocklist,role-policy}.ts`
(`BlocklistReader`, `RolePolicyReader`). Implementations live in
`apps/worker/src/modules/admin/{blocklist-reader,role-policy-reader}.ts`,
re-exported via `apps/worker/src/modules/admin/index.ts`. Wiring is confined to
`app-context.ts:56-57`. **`inbound-mail` does not import `admin` directly** —
the edge goes through `contracts/*` interfaces, mirroring the ADR-002 outbound
provider pattern.

### 2. Persistence ownership: two new tables, both admin-owned

`migrations/0010_blocklist_and_role_policies.sql` adds:

- `blocklist_entries (id, kind, pattern, created_by, created_at)` — admin-owned.
- `role_policies (role_id PK FK→roles, ban_email_patterns_json TEXT,
  avail_domain_patterns_json TEXT, updated_by, updated_at)` — admin-owned.

The persistence-ownership rule at `.claude/rules/architecture.md:97` does not
yet list them.

### 3. Domain purity preserved

`apps/worker/src/modules/inbound-mail/policy-evaluator.ts` is pure: it takes
`parsed, rolePolicies, blocklistEntries` and returns `EvaluationDecision`. No
`Date.now()`, no `crypto.randomUUID`, no I/O. `pattern-matchers.ts` is also
pure: takes strings (or `ParsedEmail` + `BlocklistEntryRow`), returns booleans.
`safeParseStringArray` (lines 104-112 of `policy-evaluator.ts`) is defensive
JSON parsing with no I/O.

### 4. Composition root discipline

`apps/worker/src/app-context.ts:56-57` is the only place that instantiates
`createBlocklistReader(db)` and `createRolePolicyReader(db)`. No module imports
another module's repository. The wiring follows the same pattern as
`createOutboundProviderRegistry` (ADR-002).

---

## BLOCKER (resolved in fix slice 2026-08-14)

### B1 — Inbound-mail → admin (read-only, via contracts) edge is not declared in the rule's dependency table

**Status:** RESOLVED — `.claude/rules/architecture.md:48` now reads
`inbound-mail | tenancy, messages, email-core/*, admin (read-only, via contracts/*)`.
Lines 60-64 of the same file document the interface-only constraint
(`BlocklistReader`, `RolePolicyReader` in `packages/contracts`; wiring in
`app-context.ts`). Bundled with M1 as the same documentation update at
capability close.

**Where:** `.claude/rules/architecture.md:48`

> `| inbound-mail | tenancy, messages, email-core/* |`

**Violates:** `.claude/rules/architecture.md:58` — *"An edge not in this table
is the orchestrator's decision, not the implementer's."* The implementation
introduces a real edge (`inbound-mail` reads admin-owned tables through
`contracts/*` interfaces); the rule's table does not list it.

**Failure scenario:** A future capability that needs another
`inbound-mail → admin` read will not know whether to extend the table or
whether the implementation has crossed an undeclared line. The reviewer grep
target for "what may module X depend on" misses this case because the import
goes through `contracts`. Worse, the rule as written does not even hint that
admin-owned tables might be readable from inbound-mail at all.

**Fix:** Edit `.claude/rules/architecture.md` to add an explicit row:

```
| inbound-mail | tenancy, messages, email-core/*, admin (read-only, via contracts/*) |
```

Or add a sentence below the table noting the admin read-only exception for
inbound-mail. **This must land before CAP-035 leaves "In Progress."** The
capability contract's Decisions §Q1 already acknowledges the debt; the edit
just records it.

**Verdict:** CONFIRMED — verified by reading the rule (line 48) and by
grepping `apps/worker/src/modules/inbound-mail/` for `from '../admin'` (no
matches) and for `@unimailbox/contracts/admin` (matches exist on
`BlocklistEntryRow` and `RolePolicyRow` types — read-only contracts).

---

## HIGH

(No HIGH findings — resolved by fix slice 2026-08-14: still none.)

---

## MEDIUM (all three resolved in fix slice 2026-08-14)

### M1 — Persistence-ownership rule does not list blocklist_entries or role_policies

**Status:** RESOLVED — `.claude/rules/architecture.md:103` now lists
`admin | …, audit_events, maintenance_jobs, blocklist_entries, role_policies`.

**Where:** `.claude/rules/architecture.md:97`

> `| admin | roles, permissions, role_permissions, user_roles, system_settings, audit_events, maintenance_jobs |`

**Violates:** *"A table has exactly one owning module."* The rule's table must
enumerate every table an owner manages, or future work will not know where
`blocklist_entries` belongs.

**Failure scenario:** A contributor adding a new policy table next to
`role_policies` will not know to put it under `admin` because the rule's
`admin` row does not establish the pattern for policy tables. Conversely, a
contributor migrating `blocklist_entries` to a new module will not realize it
is currently admin-owned by glancing at the rule.

**Fix:** Extend the `admin` row:

```
| admin | roles, permissions, role_permissions, user_roles, system_settings, audit_events, maintenance_jobs, blocklist_entries, role_policies |
```

Bundle with **B1** — both are rule edits and they ship as one documentation
update at capability close.

**Verdict:** CONFIRMED — verified by reading `.claude/rules/architecture.md`
and `migrations/0010_blocklist_and_role_policies.sql`.

### M2 — Drizzle row-type aliases collide with contracts interface names

**Where:** `apps/worker/src/database/schema/admin.ts:153-156`

```ts
export type BlocklistEntryRow       = typeof blocklistEntries.$inferSelect;
export type NewBlocklistEntryRow    = typeof blocklistEntries.$inferInsert;
export type RolePolicyRowDrizzle    = typeof rolePolicies.$inferSelect;
export type NewRolePolicyRowDrizzle = typeof rolePolicies.$inferInsert;
```

The first two collide directly with the contracts interface
`BlocklistEntryRow` (declared at
`packages/contracts/src/admin/blocklist.ts:58-64`) and via inference for
`role_policies`.

**Violates:** `.claude/rules/architecture.md:71` — *"Drizzle row types crossing
a module boundary. Cross-boundary types come from `contracts`."* When the admin
module imports the Drizzle row for internal use, the IDE cannot tell the
contributor which `BlocklistEntryRow` they have — the contracts one (camelCase,
public-facing) or the Drizzle one (snake_case, internal). A function that
returns the Drizzle row type from a public interface leaks snake_case column
names across the boundary.

**Failure scenario:** A future CRUD function inside
`apps/worker/src/modules/admin/` takes the Drizzle row, accidentally re-exports
it from `modules/admin/index.ts`, and the caller in `inbound-mail` (or
`http/routes/`) receives snake_case column names — `created_by` instead of
`createdBy`. A grep for `createdBy` on the return type fails to find it; a grep
for `created_by` finds it where it should not exist.

**Fix:** Rename the Drizzle aliases to disambiguate:

```ts
export type BlocklistEntryRowDrizzle       = typeof blocklistEntries.$inferSelect;
export type NewBlocklistEntryRowDrizzle    = typeof blocklistEntries.$inferInsert;
export type RolePolicyRowDrizzle           = typeof rolePolicies.$inferSelect;
export type NewRolePolicyRowDrizzle        = typeof rolePolicies.$inferInsert;
```

The `_Drizzle` suffix matches the Drizzle-typing-only convention from
`.claude/rules/coding.md`. Note `RolePolicyRowDrizzle` and
`NewRolePolicyRowDrizzle` already follow this convention; only the
`BlocklistEntryRow` pair needs renaming. Update internal imports inside
`apps/worker/src/modules/admin/` to use the renamed types.

**Verdict:** CONFIRMED — verified by reading both files.

### M3 — JSON-in-text relaxation comment references a placeholder CAP ID

**Status:** RESOLVED — `CAP-NNN` placeholder replaced with `CAP-036` in
`migrations/0010_blocklist_and_role_policies.sql:16`; CAP-036 row added to the
capability ledger.

**Where:** `migrations/0010_blocklist_and_role_policies.sql:12-17`

```
-- R-DATA-005 relaxation: ban_email_patterns_json and
-- avail_domain_patterns_json are TEXT columns holding JSON arrays.
-- This is a deliberate, documented exception — see CAP-NNN JSON-AUDIT.
```

**Violates:** `.claude/rules/architecture.md` legacy anti-pattern: *"JSON blobs
in text columns. The new schema is relational."* The capability contract
acknowledges the relaxation (Decisions §Q2) but uses a placeholder `CAP-NNN`
that cannot be grepped to a real entry.

**Failure scenario:** A future reviewer, finding the TEXT columns, runs
`grep CAP-NNN JSON-AUDIT .` and finds nothing resolvable. A future migration
that wants to normalize these columns to relational storage cannot tell
whether the relaxation was approved, deferred, or abandoned. A migration that
adds a new JSON-in-text column cannot find the precedent.

**Fix:**

1. Reserve the next available CAP ID for the JSON-AUDIT follow-up (e.g.,
   `CAP-046` if the ledger allows).
2. Replace `CAP-NNN` in the SQL comment with the reserved ID.
3. Add a row to `docs/rebuild/capability-ledger.md`:

   ```
   | CAP-NNN | JSON-AUDIT — audit JSON-in-text columns | Not Started | — | — |
   ```

   with description "R-DATA-005 relaxation audit: `ban_email_patterns_json`,
   `avail_domain_patterns_json` (and any other TEXT-JSON columns). Decide
   whether to normalize to relational or formalize the JSON-in-text exception."

**Verdict:** CONFIRMED — verified by reading the migration file and grepping
for `CAP-NNN JSON-AUDIT` across the repo (zero matches).

---

## LOW

### L1 — Per-recipient `getUserRoleIds` loop in the entrypoint (future scaling)

**Where:** `apps/worker/src/entrypoints/inbound-email.ts:88-97`

```ts
const ownerRoleIds = new Set<string>();
for (const mailbox of foundMailboxes) {
  const roleIds = await getUserRoleIds(env.DB, mailbox.ownerUserId);
  for (const roleId of roleIds) ownerRoleIds.add(roleId);
}
```

**Violates:** Not an architecture-rule violation. This is entrypoint
orchestration code. The current shape is correct; the loop is small.

**Failure scenario:** A message addressed to 10 distinct mailboxes owned by 10
distinct users makes 10 sequential `user_roles` queries before policy
evaluation. With current scale (tens of inbound messages per second per
instance) this is fine; at higher throughput it adds latency to the hot path
of every inbound email. The deduplication-by-Set prevents loading the same
role's policy twice, but does not collapse the N round-trips.

**Fix (optional, future capability):** Extract a
`collectOwnerRoleIds(foundMailboxes, db): Promise<string[]>` helper into
`apps/worker/src/modules/tenancy/`, and batch the lookup into a single
`SELECT user_id, role_id FROM user_roles WHERE user_id IN (?, ?, ...)`. The
current code is correct — this is a future-scaling note, not a defect.

**Verdict:** PLAUSIBLE — the latency cost is small at current scale but grows
linearly with recipients; the helper extraction is a 20-line follow-up.

---

## Not verified

- **Concurrency under load:** I did not run load tests against
  `pnpm test:worker`. The handler is single-threaded within a Worker
  invocation; multi-instance behavior was not exercised.
- **MIME edge cases at the matcher boundary:** `matchesBlocklistEntry(kind='content')`
  in `apps/worker/src/modules/inbound-mail/pattern-matchers.ts:46-49` calls
  `parsed.htmlBody.toLowerCase()` unconditionally. I did not read
  `packages/email-core/src/parse-email.ts` to confirm whether `htmlBody` is
  guaranteed to be a string (vs. nullable). If `htmlBody` is nullable, the
  matcher throws on every content-blocklist check.
- **JSON column drift on contract changes:** the `safeParseStringArray` helper
  lives in `apps/worker/src/modules/inbound-mail/policy-evaluator.ts:104-112`.
  The admin CRUD path (`PUT /api/v1/admin/roles/:id/policy`) will likely need
  the same defensive parser; if not extracted, the parser will be duplicated.
  Worth promoting to `packages/contracts/src/admin/role-policy.ts` (or a
  shared `platform/json.ts`) before the next capability touches the schema.
- **Webhook signature verification on inbound:** out of scope per the agent
  prompt. The blocklist path short-circuits before signature checks because
  the message is coming from Cloudflare Email Routing, not a provider
  webhook — but I did not trace that boundary.

---

## Required fixes (priority order)

1. **B1** — Edit `.claude/rules/architecture.md:48` dependency table to add
   `admin (read-only, via contracts/*)` to `inbound-mail`'s allowed row. Must
   land before CAP-035 leaves "In Progress."
2. **M1** — Bundle with B1: extend `.claude/rules/architecture.md:97`
   persistence-ownership table to add `blocklist_entries, role_policies` to
   the `admin` row.
3. **M2** — Rename `BlocklistEntryRow` / `NewBlocklistEntryRow` at
   `apps/worker/src/database/schema/admin.ts:153-154` to add the `_Drizzle`
   suffix. Update internal imports inside `apps/worker/src/modules/admin/`.
4. **M3** — Reserve a CAP ID for the JSON-AUDIT follow-up, replace the
   `CAP-NNN` placeholder in `migrations/0010_blocklist_and_role_policies.sql:16`,
   and add a row to the capability ledger.
5. **L1** — Optional, future capability: extract `collectOwnerRoleIds` to
   `modules/tenancy/` and batch the `user_roles` lookup.

---

## Sign-off

The implementation respects the bounded contexts, the composition-root
discipline, and the pure-domain layering. The one BLOCKER is documentation,
not code: the dependency rule must be extended before this capability ships.
After the rule edits land, the implementation is architecturally clean.

The persistence-ownership rule, the Drizzle/contracts type-naming convention,
and the JSON-in-text relaxation all need small follow-ups to keep the rule
files honest. None of them block the code path; they block the documentation
path. A reviewer running on a fresh session after the rule edits will have no
way to tell this work happened unless those follow-ups land.

---

## Files referenced

- `.claude/rules/architecture.md:40-100`
- `work/active/D-CAP-021-blocklist-and-role-policies/task.md`
- `migrations/0010_blocklist_and_role_policies.sql:12-46`
- `apps/worker/src/database/schema/admin.ts:119-156`
- `apps/worker/src/modules/inbound-mail/policy-evaluator.ts`
- `apps/worker/src/modules/inbound-mail/pattern-matchers.ts`
- `apps/worker/src/modules/inbound-mail/index.ts`
- `apps/worker/src/entrypoints/inbound-email.ts:84-105`
- `apps/worker/src/app-context.ts:56-57`
- `packages/contracts/src/admin/blocklist.ts`
- `packages/contracts/src/admin/role-policy.ts`
- `apps/worker/src/http/routes/admin-blocklist.ts`
- `apps/worker/src/http/routes/admin-role-policies.ts`
- `apps/worker/src/entrypoints/inbound-email.worker.test.ts:361-513`
