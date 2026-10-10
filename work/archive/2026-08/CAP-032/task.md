# CAP-032 — Stable error model

> The shared contract for this capability. Every agent working on it reads this file first.
> Location: `work/active/CAP-032-stable-error-model/task.md`.

**Phase:** 2 · **Status:** In Progress · **Started:** 2026-08-15

## Goal

Every `/api/v1/*` endpoint returns the canonical error envelope
`{ "error": { "code", "message", "requestId" } }` with a stable, closed-set
machine-readable `code`. No endpoint may emit a hand-rolled error response;
every failure path goes through the single error middleware and through one
typed `DomainError`.

## Scope

**In scope:**

1. **Closed-set error catalog.** Replace
   `apps/worker/src/platform/errors.ts:10`'s open `export type ErrorCode = string`
   with a closed `ErrorCode` literal-union derived from an `ERROR_CODES = { ... } as const`
   object. Every `code: '...'` literal currently in `apps/worker/src/**` must be
   a member of that union. New codes require an edit to the catalog — that's
   the point.

2. **`requestId` in the error envelope.**
   - `apps/worker/src/http/middleware/request-id.ts` (current CAP-001 no-op
     stub) becomes real: generates a UUIDv4 via `platform/ids.ts`, sets it on
     `c.set('requestId', id)`, and adds an `X-Request-Id` response header so
     the same value is observable from both the client and the log line.
   - `apps/worker/src/platform/env.ts:23-28` `AppEnv.Variables` adds
     `requestId?: string`.
   - `apps/worker/src/http/middleware/error.ts:8` `ErrorHandler` signature
     changes from `_c` → `c` so the handler reads `c.get('requestId')`. Every
     branch (`ZodError`, `DomainError`, `SyntaxError`, unknown) returns
     `{ error: { code, message, requestId } }`. Drops the TODO at `:53-54`.

3. **Single source of envelope shape.** Delete
   `apps/worker/src/http/errors.ts` (dead code — no importers, only a
   self-referential comment in `platform/errors.ts:9`). Move the canonical
   `HttpErrorBody` interface into `apps/worker/src/platform/errors.ts` so the
   shape lives next to its only producer.

4. **Eliminate hand-rolled error responses.** Every `c.json({ error: { ... } })`
   and every `return new Response(...)` with a 4xx/5xx body in
   `apps/worker/src/http/routes/**` is replaced with a `throw new
   DomainError({ code, httpStatus, message })` so the response always flows
   through `errorMiddleware`. Concretely, this slice replaces:
   - `apps/worker/src/http/routes/admin-blocklist.ts:218-223` — DELETE 404
     hand-rolled `c.json({ error: { code: 'NOT_FOUND', message: ... } })`
     → `throw new DomainError({ code: 'BLOCKLIST_ENTRY_NOT_FOUND',
     httpStatus: 404 })`.

   Implementer searches the routes directory for `c\.json\(\{[\s\n]*error` and
   `return new Response` and reports any other call sites as part of the
   handoff. Each one is in scope for this slice.

5. **Audit unknown-throw paths.** `apps/worker/src/modules/tenancy/authorizer.ts:77,89,105`
   throws `DomainError({ code: 'MAILBOX_ACCESS_DENIED', ... })` — already
   correct (typed code, routed through middleware). Verifies the catalog
   covers the authz vocabulary.

6. **Replace generic legacy codes** that exist in the surface today:
   - `'SOMETHING_WRONG'` (only in `error.test.ts:35` — an old test fixture) →
     replace with `'INTERNAL'`. If the test was asserting the old code as part
     of the contract, update the assertion.
   - `'INVALID_REQUEST'` (auth.ts:123, :328, :530) → review per site: most are
     zod-validation follow-ups and should be `'VALIDATION_ERROR'`; some may
     be semantic input errors with no existing code and need a new catalog
     entry. Implementer classifies each, proposes a target code, and asks
     before adding new codes.

7. **Tests.** Every test is named after the rule it proves or the AC number.

## Out of scope

- **Success-envelope changes** (`{ "data": T }`). Already uniform.
- **Body validation behaviour changes** (zod error mapping to
  `VALIDATION_ERROR`). CAP-031 already codified that and CAP-032 inherits it.
- **Per-provider webhook body-size policy.** D-CAP-031-A — Phase 2 follow-up.
- **Internationalisation of error messages.** `Accept-Language: en | zh`
  is a separate Phase 2 capability.
- **HTTP status code 503 (lock contention).** Listed in
  `.claude/rules/architecture.md` §API conventions but no current site uses
  it. The catalog records it for future use; no site emits it today.
- **`ErrorCode` deprecation/removal mechanics.** This slice introduces the
  closed union but does not add runtime validation of literal codes against
  the catalog (a future capability can add a `validateErrorCode` helper).
- **Audit-event envelope changes** (audit_events.request_id already exists).
- **Structured logger replacement of `console.error` in `error.ts:55`.**
  Tracked under D-CAP-006-B (logger migration). Today the middleware logs
  with `console.error`; this slice does not change that.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-API-001` | Every error response is `{ error: { code, message, requestId } }`. `code` and `requestId` are mandatory. |
| `R-API-002` | `code` is stable across releases. A closed catalog is the enforcement mechanism. |
| `R-API-003` | Status code mapping is real (`400`, `401`, `403`, `404`, `409`, `413`, `429`, `502`, `503`). The catalog's `httpStatus` field carries the mapping. |
| `R-LOG-001` | (inherited from CAP-031 / `.claude/rules/security.md`) — error envelope does not leak body content; `requestId` is a UUID, never a body digest. |

Source: `docs/rebuild/02-business-discovery/business-rules.md` §R-API-001 / 002 / 003.

## Acceptance criteria

Each criterion is demonstrated by at least one test named after the AC number
or the rule ID. Acceptance fails if a criterion has no named test.

### Closed catalog

- **AC1.** `apps/worker/src/platform/errors.ts` exports both `ERROR_CODES`
  (a `const` object whose values are the literal strings) and `ErrorCode` (a
  union of those values). `DomainError` accepts only `ErrorCode` in its
  `code` field.
- **AC2.** Every `code: '<X>'` literal in `apps/worker/src/**` is a member
  of the union. The implementer runs `grep -rE "code: '[A-Z_]+'" apps/worker/src --include='*.ts'`
  and shows that every match is in the catalog (or, for the few sites that
  are dynamically constructed, that the dynamic value is constrained).
- **AC3.** `tsc` fails to compile when a route hand-codes a `code:` literal
  not in the catalog (a single demo test in `errors.test.ts` is sufficient).

### `requestId` in the envelope

- **AC4.** Every request gets a `requestId` UUIDv4 set by the middleware. The
  same value appears in (a) the response header `X-Request-Id`, and (b) the
  error envelope `error.requestId`. Verifiable end-to-end via a worker test
  that hits a route that throws a `DomainError` and inspects both.
- **AC5.** If the middleware somehow fails to set a `requestId` (defence in
  depth), the error envelope still emits `requestId: '<unknown>'` rather than
  `undefined`. Asserted in `error.test.ts`.

### Single envelope source

- **AC6.** `apps/worker/src/http/errors.ts` is deleted (no importers — the
  file was dead code). `HttpErrorBody` (or its new name) lives in
  `platform/errors.ts`. `git grep "from .*http/errors"` returns no hits.

### No hand-rolled error responses

- **AC7.** `grep -rE "c\.json\(\{ ?\\n?error:|return new Response.*\\{ ?\\n?error:" apps/worker/src/http/routes --include='*.ts'`
  returns no hits after the slice. Demonstrable by running the grep in the
  handoff.
- **AC8.** At least one worker test per route file proves the canonical
  envelope appears on at least one error path (typically a `DomainError`
  thrown by the use case).

### Unknown-throw audit

- **AC9.** Every `throw new DomainError({...})` in
  `apps/worker/src/modules/**` has a `code` field that compiles under the new
  closed union. The implementer runs `tsc --noEmit` and confirms zero errors.

### Quality gates (`.claude/rules/testing.md`)

- `pnpm lint`
- `pnpm typecheck` (zero new `@ts-expect-error`)
- `pnpm test:unit`
- `pnpm test:worker`
- `pnpm build`
- `pnpm scaffold doctor`

## Vertical slice

Layers this touches, in dependency order:

- [ ] platform — `apps/worker/src/platform/errors.ts` (catalog + envelope type)
- [ ] platform — `apps/worker/src/platform/env.ts` (Variables.requestId)
- [ ] http middleware — `apps/worker/src/http/middleware/request-id.ts` (real impl)
- [ ] http middleware — `apps/worker/src/http/middleware/error.ts` (use c, emit requestId)
- [ ] http — delete `apps/worker/src/http/errors.ts` (dead code)
- [ ] http routes — replace any hand-rolled error responses with DomainError
- [ ] tests — `apps/worker/src/platform/errors.test.ts`,
  `apps/worker/src/http/middleware/request-id.test.ts`,
  `apps/worker/src/http/middleware/error.test.ts`,
  per-route envelope tests in each `*.worker.test.ts`

New module dependency edges introduced: **none.** Every change lives inside
`platform/*`, `http/middleware/*`, or `http/routes/*` — all of which are
already wired per `.claude/rules/architecture.md`.

## File ownership

The implementer owns every file below for the duration of this slice. No
other agent writes them.

**Modified:**

- `apps/worker/src/platform/errors.ts` (closed catalog + envelope type)
- `apps/worker/src/platform/env.ts` (Variables.requestId)
- `apps/worker/src/http/middleware/request-id.ts` (real middleware)
- `apps/worker/src/http/middleware/error.ts` (use c, include requestId)
- `apps/worker/src/http/routes/admin-blocklist.ts:218-223` (DELETE 404 → DomainError)
- `apps/worker/src/http/routes/auth.ts:123,328,530` (replace `'INVALID_REQUEST'`)
- Any other route hand-rolled error response found by the implementer's grep

**Deleted:**

- `apps/worker/src/http/errors.ts`

**New tests:**

- `apps/worker/src/platform/errors.test.ts` (catalog + closed-union demo)
- `apps/worker/src/http/middleware/request-id.test.ts` (UUID v4, header set, var set)
- `apps/worker/src/http/middleware/error.test.ts` (every branch emits
  `requestId`; new fallback for missing var; envelope shape with all fields)

**Modified tests** (one envelope-shape assertion per file):

- Every `apps/worker/src/http/routes/*.worker.test.ts` (12 route test files
  per the Phase 1 inventory — implementer re-confirms the list at slice start)

The implementer does **not** modify:

- `apps/worker/src/database/schema/admin.ts:72` (audit_events.request_id — already
  in place)
- `apps/worker/src/modules/admin/audit-event-repository.ts` (already takes
  `requestId` input)
- `apps/worker/src/platform/logger.ts` (already accepts `requestId?` field)
- `docs/rebuild/**` (orchestrator updates the ledger + implementation log at
  acceptance)
- `work/active/CAP-032-stable-error-model/task.md` (this file)

## Reading list

Implementer reads these before writing code:

- `CLAUDE.md`
- `.claude/agents/implementer.md`
- `.claude/rules/coding.md` (especially §Errors, §Abstraction discipline)
- `.claude/rules/architecture.md` (§API conventions error envelope shape,
  §Dependency direction — no new edges)
- `.claude/rules/security.md` (§Logging — `requestId` is observable metadata,
  not a body digest; §Input and transport — `code` strings must not leak
  internal class names)
- `.claude/rules/testing.md`
- `.claude/rules/agent-collaboration.md`
- `.claude/templates/handoff.md` (only if reporting blocked)
- `docs/rebuild/capability-ledger.md` — CAP-031 row (canonical close pattern),
  CAP-037 row (canonical review-resolve pattern)
- `work/archive/2026-08/CAP-031/task.md` (the most recent close, modelled
  here)
- `docs/rebuild/02-business-discovery/business-rules.md` §R-API-001 / 002 / 003
- **Catalog seed data.** `grep -rEho "code: '[A-Z_]+'" apps/worker/src
  --include="*.ts" | sort -u` produces the working set of codes today
  (≈ 50 distinct strings). The implementer reconciles each against the
  catalog before any edit.

## Dependencies

- Phase 1 closed (CAP-001 through CAP-026, plus CAP-027, CAP-031, CAP-035,
  CAP-037): `pnpm scaffold doctor` exits 0; the route inventory is stable.
- Requires the platform `ids` module to expose a `newRequestId()` UUIDv4
  helper (it does — `apps/worker/src/platform/ids.ts` per existing imports).
- Blocks: CAP-033 (audit events UI consumes `requestId` for filtering),
  CAP-034 (cursor pagination error handling). Neither is dependency-blocked
  on this slice; CAP-033's dependency is `CAP-026` (already implemented).
  The "blocks" relationship is sequencing, not technical.

## Decisions made during this capability

- **D-CAP-032-A.** The `requestId` middleware is implemented in this slice
  rather than deferred to a follow-up capability. Rationale: R-API-001
  requires `requestId` in the envelope, but the middleware is a CAP-001 stub
  (no-op). Shipping the closed catalog without the real middleware would
  produce envelopes where `requestId: '<unknown>'` for every request, which
  is worse than the current behaviour of not including the field at all.
  Implementing the middleware (≈ 15 lines: `crypto.randomUUID()` →
  `c.set('requestId', id)` → `c.header('X-Request-Id', id)`) is small enough
  to belong with the envelope change.
- **D-CAP-032-B.** `HttpErrorBody` is moved into `platform/errors.ts` and
  `http/errors.ts` is deleted. Rationale: dead code (no importers); the
  envelope type is co-located with `DomainError` (its only producer) and
  consumed by `http/middleware/error.ts` directly.
- **D-CAP-032-C.** `INTERNAL` is the catalog entry for the
  unknown-error → 500 branch. Rationale: existing code path already emits
  `INTERNAL` (error.ts:58); the catalog records it.
- **D-CAP-032-D.** Status codes that exist in
  `.claude/rules/architecture.md` §API conventions but are not yet emitted by
  any route (`429`, `503`) are **catalogued but unused**. The catalog
  documents the planned mapping; no site throws them today. Implementer
  adds them as `httpStatus: 429` / `httpStatus: 503` constants in the
  catalog but does not wire them into a route.

## Open questions

- **Q1.** The `auth.ts:123,328,530` `'INVALID_REQUEST'` sites — are they
  zod-validation follow-ups (→ `VALIDATION_ERROR`) or semantic input errors
  (→ new catalog entries like `EMAIL_INVALID`, `PASSWORD_TOO_SHORT`)? The
  implementer reads each site and proposes a target code in the handoff;
  unresolved sites become a deferred MEDIUM per
  `.claude/rules/agent-collaboration.md` §Conflict handling.
- **Q2.** The audit-event envelope (`{ event, requestId, actorUserId?,
  durationMs }`) per `.claude/rules/security.md` §Logging is unaffected by
  this slice (it does not change `platform/logger.ts`). Confirm — does the
  operator want the audit log lines to also be JSON-shaped via the new
  logger, or is the `console.error` in `error.ts:55` acceptable for this
  slice? Default: leave `console.error` as-is, defer logger migration to
  D-CAP-006-B.

## Risks

- **Closed-union churn.** Tightening `ErrorCode = string` → a closed union
  may surface literal typos or dynamic constructions the implementer did not
  anticipate. The implementer uses `tsc --noEmit` after every batch of edits
  and reports any unexpected failures as BLOCKER findings in the handoff.
- **Webhook envelope shape.** Webhook responses use `c.json({ data: { ok:
  true } })` (webhooks.ts:65). Errors there also flow through `errorMiddleware`
  (verified by `entrypoints/http.ts` composition). No webhook-specific
  envelope work expected, but the implementer confirms via grep that no
  webhook route emits a non-canonical error body.
- **Test fixture drift.** `error.test.ts:35` asserts the legacy code
  `'SOMETHING_WRONG'`. After the catalog change, this fixture must be
  updated to a real code or the assertion deleted. Implementer must not
  silently break this test.
- **requestId middleware order.** The middleware runs *before* `setupGate`
  and `authn` (router.ts:41) so even rejected requests carry an id. Confirmed
  by reading router.ts:41-43 — no order change needed.