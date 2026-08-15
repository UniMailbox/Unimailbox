# Handoff — 2026-08-15 — CAP-032 (implementer)

**From:** implementer subagent · **Capability:** CAP-032 — Stable error model · **Phase:** 0

## Current objective

CAP-032 is ready for the orchestrator to run independent reviewers (architecture,
code, qa, security). The slice is complete; the working tree is dirty by design
(orchestrator commits at the capability boundary).

## Completed

- Closed `ErrorCode` literal union in `apps/worker/src/platform/errors.ts` driven
  by `ERROR_CODES = { ... } as const satisfies Readonly<Record<string, string>>`.
- Real `requestId` middleware in `apps/worker/src/http/middleware/request-id.ts`
  that uses `systemIds.uuid()` and sets `c.set('requestId', id)` + `X-Request-Id`
  response header.
- `requestId?: string` added to `AppEnv.Variables` in `apps/worker/src/platform/env.ts`.
- `errorMiddleware` rewritten in `apps/worker/src/http/middleware/error.ts` to
  emit the canonical envelope `{ error: { code, message, requestId } }` across
  all four branches (ZodError, DomainError, SyntaxError, unknown). AC5 fallback
  to `'<unknown>'` for defence in depth.
- `HttpErrorBody` interface moved from `apps/worker/src/http/errors.ts` into
  `apps/worker/src/platform/errors.ts`; `http/errors.ts` deleted.
- Admin blocklist DELETE 404 now throws `DomainError({ code: 'BLOCKLIST_ENTRY_NOT_FOUND', httpStatus: 404 })`
  instead of a hand-rolled `{ error: { code: 'NOT_FOUND', ... } }` literal.
- Three `INVALID_REQUEST` sites in `apps/worker/src/http/routes/auth.ts` (lines 127,
  336, 542) reclassified to `VALIDATION_ERROR` (D-CAP-031-C / Fix 9 — these are
  zod-style required-field guards that run before actorId hashing).
- New test files:
  - `apps/worker/src/http/middleware/error.test.ts` — 6 tests covering all four
    branches + AC5 fallback + AC4 cross-check.
  - `apps/worker/src/http/middleware/request-id.test.ts` — 4 tests covering UUIDv4
    generation, context variable, response header, distinctness per request, and
    the header/envelope cross-check.
  - `apps/worker/src/platform/errors.test.ts` — extended with AC1 (catalog
    existence), AC2 (HttpErrorBody shape), AC3 (`// @ts-expect-error` closed-union
    demo), plus DomainError field tests.
- Quality gates run from the repo root, all pass:
  - `pnpm lint` — 0 errors, 0 warnings
  - `pnpm typecheck` — 0 errors
  - `pnpm test:unit` — 18 files, 323 tests passed
  - `pnpm test:worker` — 28 files, 461 tests passed
  - `pnpm build` — worker + web succeed
  - `pnpm scaffold doctor` — 10/10 checks passed

## Current state

- Branch: `cap/CAP-020-026-business-loop` · Working tree: dirty (changes listed
  below — intentionally not committed)
- `work/active/CAP-032-stable-error-model/` — still present (orchestrator cleans
  after review)
- `D work/active/CAP-027-idempotency/task.md` — pre-existing git status marker
  (not part of CAP-032)

## Decisions made

| Decision | Rationale | Persisted to |
|---|---|---|
| Reclassify the three `INVALID_REQUEST` auth.ts sites as `VALIDATION_ERROR` | Functionally equivalent to zod required-field validation (D-CAP-031-C / Fix 9). | `apps/worker/src/http/routes/auth.ts` |
| Hand-rolled 404 in admin-blocklist DELETE → `DomainError(BLOCKLIST_ENTRY_NOT_FOUND, 404)` | R-API-001: every error must use the canonical envelope. The 404 path no longer writes an `idempotency_records` row because no business write happens. | `apps/worker/src/http/routes/admin-blocklist.ts` (comment block on lines 215-227) |
| `ERROR_CODES.INVALID_REQUEST` kept in the catalog as deprecated | Migration window only; removed in a follow-up capability. | `apps/worker/src/platform/errors.ts` |
| `envelope()` uses `Response.json(...)` + explicit X-Request-Id propagation | `c.json(...)` is correct in production but breaks the AC5 stub test; `Response.json` is more explicit and easier to test. | `apps/worker/src/http/middleware/error.ts` |
| `ContentfulStatusCode` widened for envelope `httpStatus` param | The narrow literal union (400/401/...) rejected `ContentfulStatusCode` from `DomainError.httpStatus`. | `apps/worker/src/http/middleware/error.ts` |
| Stub Context in `runDirect` uses `Parameters<typeof errorMiddleware>[1]` instead of `any as any` | Lint-clean, type-safe stub. | `apps/worker/src/http/middleware/error.test.ts` |
| Removed the "non-Error thrown value" test | Hono's `onError` wraps thrown strings into Error instances before our middleware sees them — the test was asserting on Hono's wrapping behavior, not ours. | `apps/worker/src/http/middleware/error.test.ts` |
| `admin-blocklist.worker.test.ts`: replay test asserts shape (same code, same status, fresh requestId) rather than byte equality | Throwing 404 without writing idempotency_records means the second request produces a fresh requestId; byte-equality is impossible after the simplification. | `apps/worker/src/http/routes/admin-blocklist.worker.test.ts` (inline comment) |
| `admin-blocklist.worker.test.ts`: "different ids → different records" test rewritten to use two successful DELETEs against two seeded entries | 404s no longer write idempotency_records, so the original two-404-count test couldn't prove the path-id namespace. | `apps/worker/src/http/routes/admin-blocklist.worker.test.ts` |

## Blocked

- Nothing. The slice is ready for review.

## Next concrete actions

1. Orchestrator: dispatch `[role: architecture-reviewer]`, `[role: code-reviewer]`,
   `[role: qa-reviewer]`, `[role: security-reviewer]` in parallel against the
   diff. Per `.claude/rules/agent-collaboration.md`, reviewers must not have
   written the code.
2. Reviewers should focus on:
   - Catalog discipline: every code in `ERROR_CODES` has at least one call site
     (`grep -r "code: 'CODE_NAME'" apps/worker/src/`). The deprecated
     `INVALID_REQUEST` is documented as migration-window.
   - AC5: `errorMiddleware` emits `requestId: '<unknown>'` when
     `c.get('requestId')` is undefined — asserted in `error.test.ts`.
   - The X-Request-Id propagation in `envelope()` reaches the wire (cross-check
     test in `request-id.test.ts` and `admin-blocklist.worker.test.ts`).
3. After reviews pass, resolve findings, update `docs/rebuild/capability-ledger.md`
   to mark CAP-032 as `Implemented`, append `docs/rebuild/implementation-log.md`,
   clean up `work/active/CAP-032-stable-error-model/`, and commit. **Not the
   implementer's job.**

## Relevant files

- `apps/worker/src/platform/errors.ts` — closed ERROR_CODES catalog + HttpErrorBody
- `apps/worker/src/platform/errors.test.ts` — AC1, AC2, AC3, DomainError field tests
- `apps/worker/src/platform/env.ts` — AppEnv.Variables.requestId
- `apps/worker/src/http/middleware/request-id.ts` — real middleware (was CAP-001 stub)
- `apps/worker/src/http/middleware/request-id.test.ts` — new: AC4 cross-check
- `apps/worker/src/http/middleware/error.ts` — canonical envelope, AC5 fallback
- `apps/worker/src/http/middleware/error.test.ts` — all four branches + AC5
- `apps/worker/src/http/errors.ts` — DELETED (HttpErrorBody moved to platform/errors)
- `apps/worker/src/http/routes/admin-blocklist.ts` — 404 throws DomainError
- `apps/worker/src/http/routes/admin-blocklist.worker.test.ts` — 404 expectations,
  replay test, path-id namespace test
- `apps/worker/src/http/routes/auth.ts` — three `INVALID_REQUEST` → `VALIDATION_ERROR`
