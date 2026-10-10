# D-CAP-021 — Inbound blocklist (R-INBOUND-005) + per-role policies (R-INBOUND-006)

> The shared contract for this capability. Every agent working on it reads this file first.

**Phase:** 2 · **Status:** In Progress · **Started:** 2026-08-14

## Goal

An administrator can configure a blocklist (subject / content / from patterns) and per-role
`availDomain` / `banEmail` policies; the inbound-email handler evaluates both before persistence
and rejects matching messages.

## Scope

- A `blocklist_entries` table owned by the **admin** module: `(id, kind, pattern, created_by, created_at)` where `kind ∈ { 'subject' | 'content' | 'from' }` and `pattern` is a case-insensitive substring (no regex in v1 — keeps the security surface flat).
- A `role_policies` table owned by the **admin** module: `(role_id, ban_email_patterns_json, avail_domain_patterns_json)` — one row per role; empty `availDomain` means allow all (BF-100).
- A read-through evaluator `evaluateInboundPolicy(parsed, recipientRole)` in the **inbound-mail** module, called by `entrypoints/inbound-email.ts` between MIME parse and the atomic batch (per `docs/rebuild/02-business-discovery/workflows.md` step 4–6).
- Pattern matching helpers (`matchBlocklistEntry`, `matchesBanEmail`, `matchesAvailDomain`) live in the inbound-mail module and are pure (take parsed email + role + entries — no I/O).
- **Admin CRUD surface** for both tables: `POST /api/v1/admin/blocklist` (add), `GET /api/v1/admin/blocklist` (list), `DELETE /api/v1/admin/blocklist/:id` (remove), `PUT /api/v1/admin/roles/:id/policy` (replace banEmail + availDomain arrays for a role), `GET /api/v1/admin/roles/:id/policy` (read). All gated by `requirePermission('settings.manage')` for blocklist and `requirePermission('role.manage')` for role policies. **Why:** operators cannot configure what the code evaluates. Phase 2 is the right home — blocklist + policies together, since they are the same subsystem (per the original deferred-item wording).
- Tests named after the rule IDs (`R-INBOUND-005` / `R-INBOUND-006`) covering each pattern form, empty list, and IDOR.

## Out of scope

- **Admin UI in `apps/web/`** — the web client renders settings elsewhere (CAP-038 or later). This capability lands the API + handler logic; the UI is a follow-up.
- **Regex / wildcard patterns in v1** — substring matching is sufficient for the substring match cases the rules require. Wildcard `*` and regex are deferred to a later capability if operators ask.
- **Per-mailbox blocklists** — blocklist is global. Per-mailbox overrides are a separate concern; not in the rules.
- **Migration of legacy `role.banEmail` / `role.availDomain`** — there is no legacy data to migrate (the rebuild starts from an empty D1; legacy is the motivation, not the source).
- **Outbound `banEmail` evaluation** — rules are scoped to receive time (R-INBOUND-006 title: "evaluated at receive time"). Outbound-side checks are a separate capability.
- **Audit event for `message.reject`** — the audit_events row at R-INBOUND-008 batch level still fires when the message is accepted; rejected messages produce no DB row by design (per Assumption D in the contract). An audit event for the rejection would be a useful follow-up but is out of scope here.
- **Inline editor / pattern-validation UI** — patterns are validated server-side only.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-INBOUND-005` | Blocklist matches on subject, content, and `from` reject the message. Three `kind` values; case-insensitive substring match. |
| `R-INBOUND-006` | Per-role `availDomain` and `banEmail` policies are evaluated at receive time. `banEmail` matches exact email, `@domain`, or `*`. `availDomain` matches `@domain`; empty list means allow all. |
| `R-INBOUND-008` | Atomic batch only fires when the message passes both checks. Rejection short-circuits before any DB write. |
| `R-DATA-001` | Email addresses are compared case-insensitively (R-INBOUND-002 precedent; the helpers must lowercase). |
| `R-DATA-005` | No JSON-in-text columns for ban/avail lists — patterns live in JSON columns **only when** the schema is migrated to a typed JSON column with no business logic on the contents. **Decision (this contract):** store as `TEXT` JSON in `role_policies.ban_email_patterns_json` / `avail_domain_patterns_json`; parsing happens in the inbound-mail module at evaluation time. Treat the rule as relaxed for these two fields by ADR (proposed) because the patterns are syntactic-only — there is no per-element business query. Flag in the open questions if you reject this. |
| `R-AUTHZ-003` | Both check layers: `requirePermission` (global) + mailbox `assertCan` (no-op here — inbound has no actor user — but the admin route handlers go through both). |
| `R-AUTHZ-005` | Admin identity from `user_roles`; no hardcoded email list. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

- [ ] 1. Migration `0010_blocklist_and_role_policies.sql` exists with `blocklist_entries` and `role_policies` tables; verify.sql asserts columns and FKs (single role per policy row; FK to `roles(id)`).
- [ ] 2. `apps/worker/src/modules/admin/` exports `blocklistRepository` (`createBlocklistEntry`, `listBlocklistEntries`, `deleteBlocklistEntry`) and `rolePolicyRepository` (`getRolePolicy`, `setRolePolicy`).
- [ ] 3. `apps/worker/src/modules/inbound-mail/index.ts` exports `evaluateInboundPolicy(parsed, roleBanPatterns, roleAvailPatterns, blocklistEntries)` returning `{ allow: boolean, reason?: string }` — pure function, no I/O.
- [ ] 4. `entrypoints/inbound-email.ts` loads blocklist + the recipient mailbox owner's role policies once per message, evaluates before the R-INBOUND-008 batch, and calls `message.setReject(reason)` if denied. Audit row is **not** written on reject (per Out of scope).
- [ ] 5. Admin API surface: `POST /api/v1/admin/blocklist`, `GET /api/v1/admin/blocklist`, `DELETE /api/v1/admin/blocklist/:id`, `GET /api/v1/admin/roles/:id/policy`, `PUT /api/v1/admin/roles/:id/policy` — all with `requirePermission` checks, all with idempotency (CAP-027 wiring), all with zod validation from `packages/contracts`.
- [ ] 6. Tests named `R-INBOUND-005` (one per kind: subject hit, content hit, from hit, case-insensitive, no-match) and `R-INBOUND-006` (`banEmail` exact / `@domain` / `*`, `availDomain` matched / not-matched / empty = allow all, deny precedence over avail).
- [ ] 7. `apps/worker/src/modules/inbound-mail/index.ts` is no longer an empty stub — it re-exports the evaluator and pattern helpers. No Hono or `Request`/`Env` imports added (per `.claude/rules/architecture.md`).
- [ ] 8. No new module dependency edge that isn't in the architecture table: inbound-mail consumes admin types via `packages/contracts` (interfaces), not by importing the admin module directly. **This is the new edge: inbound-mail → admin (via contracts).** Orchestrator approval flagged in Open Questions.

## Vertical slice

Layers this touches, in dependency order:

- [ ] domain — `apps/worker/src/modules/inbound-mail/policy-evaluator.ts` (pure), `pattern-matchers.ts` (pure)
- [ ] migration — `migrations/0010_blocklist_and_role_policies.sql` (+ `.verify.sql`)
- [ ] Drizzle schema — `apps/worker/src/database/schema/admin.ts` (admin owns the tables), re-exported types only
- [ ] repository — `apps/worker/src/modules/admin/blocklist-repository.ts`, `apps/worker/src/modules/admin/role-policy-repository.ts`
- [ ] contract schema — `packages/contracts/src/admin/blocklist.ts`, `packages/contracts/src/admin/role-policy.ts` (zod + types)
- [ ] route — `apps/worker/src/http/routes/admin-blocklist.ts` (or extend `admin.ts`), `apps/worker/src/http/routes/admin-role-policies.ts`
- [ ] entrypoint wiring — `apps/worker/src/entrypoints/inbound-email.ts` (load + evaluate + short-circuit)
- [ ] tests — `apps/worker/src/http/routes/inbound-email.worker.test.ts` (extend with R-INBOUND-005/006 cases; the file already exists for the smoke tests)

New module dependency edges introduced: `inbound-mail → admin (read-only, via contracts interfaces)`. This edge is **not** in the architecture dependency table today. Flagged in Open Questions.

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| `implementer` | `migrations/0010_blocklist_and_role_policies.sql`, `migrations/0010_blocklist_and_role_policies.verify.sql`, `apps/worker/src/database/schema/admin.ts`, `apps/worker/src/modules/admin/blocklist-repository.ts`, `apps/worker/src/modules/admin/role-policy-repository.ts`, `apps/worker/src/modules/admin/index.ts` (re-export additions only), `apps/worker/src/modules/inbound-mail/policy-evaluator.ts`, `apps/worker/src/modules/inbound-mail/pattern-matchers.ts`, `apps/worker/src/modules/inbound-mail/index.ts`, `apps/worker/src/entrypoints/inbound-email.ts`, `packages/contracts/src/admin/blocklist.ts`, `packages/contracts/src/admin/role-policy.ts`, `apps/worker/src/http/routes/admin-blocklist.ts`, `apps/worker/src/http/routes/admin-role-policies.ts`, `apps/worker/src/http/router.ts` (mount only), `apps/worker/src/http/routes/inbound-email.worker.test.ts` (extension only) |
| orchestrator | `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md`, any rule edits, ADR if needed (per Out of scope) |

> One writer total for this capability: it is a single vertical slice and the files are tightly coupled. Sequencing two implementers would be friction with no parallelism payoff.

## Reading list

- `CLAUDE.md` (project entry point)
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`, `.claude/rules/coding.md`, `.claude/rules/testing.md`, `.claude/rules/security.md`
- `docs/rebuild/02-business-discovery/business-rules.md` (R-INBOUND-005, R-INBOUND-006, R-INBOUND-008, R-DATA-001, R-DATA-005)
- `docs/rebuild/02-business-discovery/business-facts.md` (BF-099, BF-100, BF-040–042)
- `docs/rebuild/02-business-discovery/workflows.md` step 4–6 (evaluation order)
- `apps/worker/src/entrypoints/inbound-email.ts` (the integration point)
- `apps/worker/src/modules/admin/` (existing module — extend)
- `apps/worker/src/modules/tenancy/` (mailbox owner lookup, `findMailboxByAddress`)

## Dependencies

- Requires: CAP-021 (Inbound mail MIME parse + R-INBOUND-008 batch) — Implemented
- Requires: CAP-017 (Roles + permissions) — Implemented (so role_policy FK is valid)
- Requires: CAP-027 (Idempotency) — Implemented (admin routes must wire `requireIdempotencyKey`)
- Blocks: CAP-029 onward (webhook ordering reads mailbox state); CAP-038 (admin UI for settings)

## Decisions made during this capability

<Append as you go. At close, each is promoted to a rule, an ADR, the implementation log — or deleted
as not load-bearing. Nothing stays only here.>

- **Pattern semantics (Assumption A):** substring for blocklist; exact / `@domain` / `*` for banEmail; `@domain` for availDomain. Substring only in v1 (no regex). Recorded in `02-business-discovery/business-facts.md` cross-link.
- **Owner split (Assumption B):** admin module owns the storage; inbound-mail consumes via contracts interfaces.
- **Evaluation order (Assumption C):** blocklist → mailbox resolve → per-role policy. Matches `workflows.md` step 4–6.
- **Atomicity (Assumption D):** rejection short-circuits before the R-INBOUND-008 batch — no new atomicity concern.
- **Cross-module read pattern (Q1):** inbound-mail reads admin-owned data via `packages/contracts` interfaces; implementations provided by the admin module, wired through `app-context.ts`. Extends the existing cross-module-read pattern. Architecture rule update owed at capability close.
- **R-DATA-005 relaxation (Q2):** `role_policies.ban_email_patterns_json` and `avail_domain_patterns_json` are stored as `TEXT` JSON with an inline deferred-normalization comment. JSON-AUDIT follow-up owed (not a CAP number yet).

## Open questions

All four questions resolved at contract time by the orchestrator; locked below.

1. **`inbound-mail → admin` edge.** **Decision: option (a).** Read surface defined in
   `packages/contracts/src/admin/blocklist.ts` as interfaces only
   (`BlocklistEntryReader.loadActiveBlocklistEntries()`,
   `RolePolicyReader.loadRolePoliciesForRoleIds(roleIds[])`). Inbound-mail depends on the
   contracts interface, not the admin module. This is consistent with the existing rule that
   "modules read across boundaries through contracts interfaces." The interface implementations
   live in the admin module; the inbound-mail module receives the read interface from
   `app-context.ts` (composition root) — same wiring pattern as the outbound provider
   registry (ADR-002).
   **Architectural effect:** the architecture dependency table needs a new entry:
   `inbound-mail` may depend on `admin` *interfaces* via `contracts/*` (read-only). This is
   a small extension to the existing allowed table; orchestrator records it in the rule
   edit at capability close.

2. **`role_policies` JSON columns vs `R-DATA-005`.** **Decision: option (c).** Store as
   `TEXT` JSON in `role_policies.ban_email_patterns_json` and
   `role_policies.avail_domain_patterns_json` with an inline migration comment:
   "DEFERRED: BF-099/100 patterns are syntactic-only; no per-element business query. Plan
   to normalize in a follow-up capability that audits all JSON-in-text columns at once
   (CAP-NNN JSON-AUDIT — to be scheduled)."
   **Architectural effect:** the rule `R-DATA-005` is technically broken for these two
   fields; recorded as an explicit relaxation. A follow-up audit capability is the
   resolution. The orchestrator surfaces this in the implementation log when CAP-035
   closes; not a follow-up capability, but a known debt item.

3. **Where do the admin routes live?** **Decision: split.** `apps/worker/src/http/routes/admin.ts`
   is currently 256 lines (already past the 200-line threshold in the contract). Adding
   five new routes for blocklist + role policy CRUD would push it further. Create two new
   route files: `apps/worker/src/http/routes/admin-blocklist.ts` and
   `apps/worker/src/http/routes/admin-role-policies.ts`. Wire both into the Hono app from
   the same place `admin.ts` is mounted today.

4. **Audit row on reject?** **Decision: out of scope.** R-INBOUND-008 batch is atomic;
   rejection short-circuits before any DB write. Adding audit on reject is a useful
   follow-up but not in scope for CAP-035. If operators ask, file a separate capability.