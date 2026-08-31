# CAP-066 — Domain administration

> The post-setup administrator surface for managed domains. This capability closes the
> D-CAP-063-B gap without changing the setup wizard or claiming a real Cloudflare API check.

**Phase:** 3 · **Status:** Implemented locally · **Started:** 2026-08-31 · **Completed:** 2026-08-31

## Goal

An authorized administrator can add, list, operator-confirm, and delete managed domains from a
reachable admin page after setup has completed.

## Scope

- Add the contracts and Worker API for listing, adding, operator-confirming, and deleting managed
  domains.
- Enforce `domain.read` for the list and `domain.manage` for add, verify, and delete.
- Keep add/delete/verify requests replay-safe and audit the domain state/action transition in the
  same D1 batch as the idempotency record.
- Prevent deleting a domain that still owns mailboxes; never cascade or silently orphan mailboxes.
- Add the authenticated `/admin/domains` page, admin landing link, and route-level session guard.
- Show only the safe domain projection: `id`, `name`, `status`, `createdAt`, and `updatedAt`.

## Out of scope

- Calling the Cloudflare API, changing DNS, or proving end-to-end inbound delivery. Phase 1's
  existing Cloudflare step is an operator-confirmation only; the real delivery proof remains the
  inbound smoke capability.
- Persisting a separate Cloudflare verification flag; the current schema has no such field and
  `status` means domain availability (`active`/`disabled`), not external DNS proof.
- Domain rename, disabling, provider assignment, mailbox management, role management, signatures,
  general settings, setup re-entry, or invitation delivery.
- Deploying, pushing, or committing the work.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-AUTHZ-001` | Every admin domain request requires an authenticated principal. |
| `R-AUTHZ-002` | The Worker checks `domain.read`/`domain.manage` against the database on every request. |
| `R-AUTHZ-003` | Global domain permission is server-authoritative; the Web page never grants access. |
| `R-DATA-001` | Domain names are trimmed, lowercased, structurally validated, and unique case-insensitively. |
| `R-DATA-004` | Repository writes are parameterized and the response is a strict safe projection. |
| `R-API-001` | Errors use the canonical envelope and include the request correlation ID. |
| `R-API-002` | Domain duplicate, missing, inactive, in-use, denied, and malformed-input outcomes use stable codes. |
| `R-API-004` | Add, verify, and delete require `Idempotency-Key`; replaying the same request returns the stored response. |
| `R-AUDIT-001` | Add, operator verification, and successful delete actions write an audit row atomically with the operation. |
| `R-SECRET-003` | No outbound connection identifier, credential, token, or storage-only field crosses the domain API/UI boundary. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`, `docs/rebuild/03-domain-design/authorization-model.md`, and
the CAP-063 deferred-gap record.

## Acceptance criteria

- [x] 1. An administrator can load `/admin/domains` and list all managed domains in a strict safe
  projection; members receive a server-generated `403 PERMISSION_DENIED` state.
- [x] 2. Add accepts a normalized valid domain, creates an active row, returns `201`, writes
  `domain.created` and an idempotency record atomically, and maps case-insensitive duplicates to
  `409 DOMAIN_ALREADY_MANAGED`.
- [x] 3. Verify is explicitly labeled operator confirmation, requires `domain.manage`, confirms a
  selected active domain exists, writes `domain.verified` plus idempotency atomically, and never
  claims a Cloudflare API or inbound-delivery check.
- [x] 4. Delete requires explicit UI confirmation, writes `domain.deleted` atomically on success,
  and returns `409 DOMAIN_IN_USE` without deleting or auditing when mailboxes reference the domain.
- [x] 5. All mutation replays are request-hash checked and all malformed/unknown response shapes
  are surfaced as stable client errors; no secrets or idempotency keys are rendered or persisted.
- [x] 6. Focused tests, full unit/Worker/Web gates, typecheck, lint, build, scaffold doctor, format,
  and diff checks pass; independent architecture, QA, security, code, and frontend review finds no
  unresolved blocker/high/medium issue.

## Vertical slice

Layers touched, in dependency order:

- [x] domain — existing `managed_domains` table; no migration required
- [x] migration — none; verified the existing `managed_domains → mailboxes` foreign-key behavior
- [x] repository — `apps/worker/src/modules/tenancy/domain-repository.ts`
- [x] use case — `modules/admin/domain-administration-service.ts` orchestrates tenancy + audit + idempotency
- [x] contract schema — `packages/contracts/src/admin/domains.ts` and package export
- [x] route — `apps/worker/src/http/routes/admin-domains.ts` and `apps/worker/src/http/router.ts`
- [x] client — `apps/web/src/features/admin/admin-queries.ts`, `DomainsPage.tsx`, landing/router
- [x] tests — focused Worker, contracts, query, page, landing, and router tests

New module dependency edges introduced: `admin route → tenancy` and `admin route → admin audit`
are existing allowed patterns; no new bounded-context edge.

## Delivery path

`authenticated administrator browser` → `/admin/domains` → `DomainsPage` → TanStack Query/API client
→ `/api/v1/admin/domains*` → `requirePermission` + tenancy repository → D1 `managed_domains` and
`audit_events`/`idempotency_records` → safe domain list and action result rendered in the browser.

- Build/runtime configuration touched: none
- Fresh-deploy evidence required: no new binding or migration; local Worker-pool coverage is required
- Repeat-deploy/idempotency evidence required: yes; Worker tests replay add/verify/delete and reject
  same-key/different-body reuse

## Reference implementation

None. Adapt the existing admin blocklist routes, admin list pages, `AlertDialog`, and shared API
client; reject any pattern that trusts client-side permission state or deletes referenced data.

## File ownership

| Agent | Owns |
|---|---|
| `codex-implementer` | `packages/contracts/src/admin/domains.ts`, `packages/contracts/src/index.ts`, `apps/worker/src/modules/tenancy/domain-repository.ts`, `apps/worker/src/modules/tenancy/index.ts`, `apps/worker/src/modules/admin/domain-administration-service.ts`, `apps/worker/src/modules/admin/index.ts`, `apps/worker/src/http/routes/admin-domains.ts`, `apps/worker/src/http/router.ts`, `apps/worker/src/http/routes/admin-domains.worker.test.ts`, `apps/web/src/features/admin/admin-queries.ts`, `apps/web/src/features/admin/DomainsPage.tsx`, `apps/web/src/features/admin/DomainsPage.test.tsx`, `apps/web/src/features/admin/admin-domains-queries.test.ts`, `apps/web/src/features/admin/AdminLandingPage.tsx`, `apps/web/src/features/admin/AdminLandingPage.test.tsx`, `apps/web/src/app/router.tsx`, `apps/web/src/app/router.test.tsx`, `apps/worker/src/platform/errors.ts`, `packages/contracts/src/admin/audit.ts` |
| `orchestrator` | this task, `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md`, `docs/operations/post-setup-admin-urls.md`, review coordination, archive, and final commit |

## Reading list

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`
- `.claude/rules/security.md`
- `.claude/rules/testing.md`
- `docs/rebuild/02-business-discovery/business-rules.md`
- `docs/rebuild/03-domain-design/authorization-model.md`
- `docs/rebuild/capability-ledger.md`
- `apps/worker/src/modules/tenancy/domain-repository.ts`
- `apps/worker/src/http/routes/admin-blocklist.ts`
- `apps/web/src/features/admin/UsersPage.tsx`
- `apps/web/src/features/admin/admin-queries.ts`

## Dependencies

- Requires: CAP-011 managed domain setup — Implemented; CAP-017 permissions — Implemented;
  CAP-026 audit trail — Implemented; CAP-027 idempotency — Implemented; CAP-044 admin Web shell — Implemented
- Blocks: role, signature, and general-settings admin surfaces only by roadmap order

## Decisions made during this capability

- 2026-08-31: “Verify” is intentionally the same Phase 1 operator-confirmation boundary as the
  setup Cloudflare step. It checks that the selected domain is present and active, records the
  deliberate operator action, and returns `verified: true`; it does not call Cloudflare or persist
  a false external verification claim.
- 2026-08-31: A domain with one or more mailboxes cannot be deleted because the existing foreign key
  has no delete cascade. The API returns `DOMAIN_IN_USE`; disabling or mailbox deletion is another
  capability.
- 2026-08-31: Mutation batches insert the idempotency record before the domain business write so a
  same-key race is serialized by the unique index before a domain-name conflict can leak as a
  duplicate. Delete repeats the mailbox predicate and uses a changes-guarded invalid sentinel so a
  zero-row delete rolls back audit/idempotency writes even when the target was the last domain.
- 2026-08-31: The shared AlertDialog now traps Tab focus and restores focus to its trigger; the
  domain page also passes TanStack Query cancellation signals and hides cached rows after a
  revoked `domain.read` response.

## Review and verification

- Independent Worker/security/architecture review found three issues: same-key idempotency races,
  a last-row delete guard false success, and delete-race error-code ambiguity. All were fixed and
  covered by the Worker race/guard/error-path tests.
- The architecture review also identified that the route initially owned the workflow orchestration.
  The final implementation moves that work into the Administration module's single use case
  service; the route now validates transport input, applies auth/permission middleware, and formats
  the use-case result only.
- Independent Web/QA/contracts review found query cancellation/cache races, stale data after
  permission revocation, non-UUID IDs, missing focus-trap behavior, and coverage gaps. All
  blocker/high/medium findings were fixed or covered by focused Web/contract tests. Additional
  low-priority matrix coverage remains non-blocking and is not part of this bounded slice.
- Final architecture re-review: no blocker/high/medium findings. The route/use-case boundary,
  public tenancy dependency, atomic batches, delete guard, and permission middleware were all
  rechecked against the project architecture rules.
- Focused Worker: 11/11. Focused Web/admin/router: 4 files, 59/59. Full unit: 75 files, 1159/1159.
  Full Worker: 51 files, 897/897. Typecheck, lint, format, `git diff --check`, build, and
  scaffold doctor 14/14 pass. Build retains only the existing Vite bundle-size warning.
- No deploy, commit, or push performed.

## Open questions

- None for this bounded slice.
