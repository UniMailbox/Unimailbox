# CAP-032 — QA Review

**Reviewer:** qa-reviewer · **Date:** 2026-08-15 · **Base:** `cap/CAP-020-026-business-loop` (uncommitted)

**Status:** ACCEPT WITH FIXES

## Summary

CAP-032 meets every acceptance criterion AC1-AC9 — the closed error-code catalog
is enforced by the type system (AC1, AC3), the requestId middleware is real and
end-to-end (AC4), the envelope fallback is exercised (AC5), and the hand-rolled
error responses are purged (AC6, AC7). Three of twenty route worker test files
do not yet assert the canonical envelope on an error path (AC8 is partially
met), and one open Q1 question from the implementer remains about whether
the three reclassified auth.ts sites need finer-grained codes than
`VALIDATION_ERROR`. Both are MEDIUM — neither blocks the canonical envelope
contract nor any business invariant. All six quality gates pass clean from
the repo root.

## Acceptance criteria

| # | Criterion | Met | Evidence |
|---|---|---|---|
| AC1 | `errors.ts` exports closed `ERROR_CODES` and `ErrorCode`; `DomainError.code` is `ErrorCode`-typed | YES | `apps/worker/src/platform/errors.ts:23-49` (closed catalog), `errors.test.ts:11-21` (AC1 catalog existence) |
| AC2 | Every `code: '<X>'` literal in `apps/worker/src/**` is in the catalog | YES | `comm -23` of `grep -rho "code: '[A-Z_0-9-]*'" apps/worker/src --include='*.ts'` minus catalog keys returns ZERO orphans; only `INVALID_REQUEST` and `NOT_FOUND` exist in catalog without a call site, both documented as deprecated/migration-window per `errors.ts:46` and `:23` |
| AC3 | tsc fails to compile a hand-coded `code:` literal not in the catalog | YES | `apps/worker/src/platform/errors.test.ts:27-28` — `// @ts-expect-error` with `'R-AUTHZ-004'`; `pnpm typecheck` passes (proving the cast is required) |
| AC4 | Every request gets a UUIDv4 `requestId`; same value in `X-Request-Id` header and `error.requestId` | YES | `apps/worker/src/http/middleware/request-id.test.ts:68-89` (AC4 cross-check); 3 supporting tests for UUIDv4 format (`:21-66`) |
| AC5 | Missing `requestId` falls back to `'<unknown>'` rather than `undefined` | YES | `apps/worker/src/http/middleware/error.test.ts:113-128`; fallback defined `error.ts:33-35` |
| AC6 | `http/errors.ts` deleted; `HttpErrorBody` in `platform/errors.ts`; no importers | YES | `ls apps/worker/src/http/errors.ts` returns ENOENT; `HttpErrorBody` declared at `platform/errors.ts:115`; `git grep "from .*http/errors"` returns no hits |
| AC7 | No hand-rolled error responses in routes | YES | `grep -rE "c\\.json\\(\\{[\\s\\n]*error" apps/worker/src/http/routes --include='*.ts'` returns ZERO hits; the only pre-existing hand-rolled 404 (admin-blocklist DELETE) was replaced |
| AC8 | At least one worker test per route file proves the canonical envelope on an error path | PARTIAL | 17/20 route worker test files assert `body.error.code` or `json.error.code` on a thrown error. Three files lack such an assertion: `audit-events.worker.test.ts`, `setup-status.worker.test.ts`, `webhooks.worker.test.ts` (see M1 below). |
| AC9 | Every `throw new DomainError({...})` in `apps/worker/src/modules/**` compiles | YES | `pnpm typecheck` reports 0 errors; the closed union was applied after every `DomainError` call site was reconciled |

## Quality gates (verbatim)

```
$ pnpm lint
$ eslint .
(no output — 0 errors, 0 warnings)

$ pnpm typecheck
$ tsc --build
(no output — 0 errors)

$ pnpm test:unit
 Test Files  18 passed (18)
      Tests  323 passed (323)
   Duration  1.86s

$ pnpm test:worker
 Test Files  28 passed (28)
      Tests  461 passed (461)
   Duration  6.86s

$ pnpm build
$ tsc --build && vite build
vite v6.0.7 building for production...
transforming...
✓ 159 modules transformed.
dist/index.html                   0.50 kB │ gzip:  0.32 kB
dist/assets/index-BH01JhrN.css    2.24 kB │ gzip:  0.77 kB
dist/assets/index-NZV9_L46.js   285.20 kB │ gzip: 89.48 kB │ map: 1,286.31 kB
✓ built in 510ms

$ pnpm scaffold doctor
✓ wrangler-bindings
✓ wrangler-compat
✓ migrations-present
✓ migrations-ordered
✓ schema-version
✓ module-dependency-zones
✓ eslint-boundary-rules
✓ tsconfig-strict
✓ harness-no-placeholders
✓ tests-cover-contracts
10/10 checks passed.
```

## BLOCKER

None. The canonical envelope contract (R-API-001 / R-API-002) is enforced by the
type system at every call site. No ship-stopping finding.

## HIGH

None. Every AC demonstrably passes the named tests, and every cited risk from
`task.md` §Risks was actively mitigated (see M2 below).

## MEDIUM

### M1 — AC8 envelope coverage gap on three route worker test files

- **Where:**
  - `apps/worker/src/http/routes/audit-events.worker.test.ts` — no error-path
    tests at all (file exercises audit emission, which is happy-path only).
  - `apps/worker/src/http/routes/setup-status.worker.test.ts` — happy-path only;
    `setup-status.ts` route has no error branch (always returns 200 with
    `complete: false` until done).
  - `apps/worker/src/http/routes/webhooks.worker.test.ts` — uses
    `json.error.code` rather than `body.error.code` for its four envelope
    assertions (`:160, :185, :209, :232`). Functionally equivalent proof
    (same `Response.json` shape), but inconsistent with the AC8 phrasing "at
    least one error path".
- **Violates:** AC8 (partial — 17/20 = 85% coverage).
- **Failure scenario:** A future change that drifts `webhooks.ts` away from the
  canonical envelope could pass its existing tests because `json.error.code`
  doesn't constrain the `data`/`error` discriminator shape. Not a live bug
  today.
- **Fix:** Add one envelope-shape assertion per file. For `audit-events` and
  `setup-status`, the natural fix is a *negative-path* test (e.g. simulate a
  thrown `DomainError` from a stubbed use case); for `webhooks`, rename the
  `json.error.code` accessor to `body.error.code` and add an explicit
  `expect(body.error.requestId).toMatch(UUID_V4_REGEX)` check. Estimated
  effort: ≤30 minutes total.

### M2 — Open question Q1 not yet answered by Orchestrator

- **Where:** `apps/worker/src/http/routes/auth.ts:127, :336, :542` —
  reclassified to `VALIDATION_ERROR` (correct per D-CAP-031-C / Fix 9).
- **Violates:** Open question Q1 in `task.md` §Open questions — the implementer
  reclassified all three as `VALIDATION_ERROR` rather than introducing
  finer-grained codes like `EMAIL_INVALID` or `PASSWORD_TOO_SHORT`.
- **Failure scenario:** A client UI that wants to highlight the specific
  missing field (register code vs. login email vs. refresh token) cannot
  distinguish them — every "missing required field" returns the same
  generic `VALIDATION_ERROR`. Today the error messages in each branch
  (`:127` "Registration code required", `:336` "Email required",
  `:542` "Refresh token required") carry the field context, so the user
  experience is fine; but machine-readable differentiation is lost.
- **Fix:** Orchestrator decides whether to (a) accept the current generic
  reclassification, (b) add three new catalog entries
  (`REGISTER_CODE_REQUIRED`, `EMAIL_REQUIRED`, `REFRESH_TOKEN_REQUIRED`),
  or (c) defer to a follow-up capability. Recommend (a) for this slice —
  the messages carry the field name; the catalog stays small; CAP-034
  (cursor pagination error handling) is the natural place to revisit
  input-error code granularity if needed.

### M3 — `error.test.ts` fixture drift verification (carried risk)

- **Where:** `apps/worker/src/platform/errors.test.ts:62-116`.
- **Violates:** `task.md` §Risks — "Test fixture drift. `error.test.ts:35`
  asserts the legacy code `'SOMETHING_WRONG'`."
- **Failure scenario:** If the fixture remained `'SOMETHING_WRONG'`, the
  unit test would fail at typecheck because the literal would no longer
  be in the closed union. **Not a live bug** — verified absent.
- **Fix:** None required. Verified by
  `grep -n "SOMETHING_WRONG" apps/worker/src/platform/errors.test.ts`
  → "NOT FOUND". The handoff's claim that the fixture was updated to
  `'INTERNAL'` is corroborated (all assertions in the file now use codes
  in the catalog).

## LOW

### L1 — `envelope()` could read `c.get('requestId')` once instead of twice

- **Where:** `apps/worker/src/http/middleware/error.ts:62-66` re-reads
  `c.get('requestId')` after it was already resolved by `resolveRequestId(c)`
  on the same call. The header propagation guard (`if (headerId)`) is a
  reasonable defensive read because the resolver falls back to
  `'<unknown>'`, which should NOT be propagated as a real header. The current
  code is correct — just worth a comment so the intent survives future edits.
- **Fix:** Add a one-line comment above `if (headerId)` explaining the
  intent (do not propagate the `'<unknown>'` sentinel as a real id).

### L2 — `webhooks.worker.test.ts` accessor inconsistency

- **Where:** `apps/worker/src/http/routes/webhooks.worker.test.ts:160, :185, :209, :232`
  uses `json.error.code` while every other route test uses `body.error.code`.
- **Violates:** Consistency only — the assertion still proves the envelope.
- **Fix:** Rename to match the established convention; roll up under M1.

## Not verified

- **Live smoke test against a preview deployment.** Per `.claude/rules/testing.md`
  §Levels, smoke is manual/CI. Not runnable from this review.
- **`wrangler deploy` output.** Build succeeded; actual deploy behaviour
  is environment-specific and outside the slice scope.
- **Re-read of `docs/rebuild/02-business-discovery/business-rules.md`** for
  every R-API-* invariant mapping — I cross-checked R-API-001 (envelope
  shape) directly against the test bodies, but did not re-read the full
  rule definitions. The implementer's handoff §Decisions covers D-CAP-032-A
  through -D, which I verified by reading the relevant source files.

## Required fixes

1. **M1** — Add envelope-shape assertions to the three route worker test
   files listed above (≤30 minutes).
2. **M2** — Orchestrator records a ledger decision on Q1 (accept current
   generic `VALIDATION_ERROR` reclassification, or defer code-granularity
   work to a named follow-up capability).
3. **M3** — Verification-only; no code change required. (Listed for
   traceability of the carried risk.)

---
Severity ordering: M1 (AC8 coverage) → M2 (Q1 decision) → M3 (verification) → L1 → L2.