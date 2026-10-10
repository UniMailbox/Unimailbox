# CAP-032 — Fix slice (review round 1)

> Triaged findings from `work/reviews/CAP-032-{architecture,code,qa}-review.md`.
> All three reviewers returned **ACCEPT WITH FIXES**. This slice implements
> every MEDIUM and cheap LOW. Deferrals are recorded by the orchestrator, not
> here.

**Phase:** 2 · **Base:** `cap/CAP-020-026-business-loop` (still dirty from CAP-032 main slice) · **Started:** 2026-08-15

## Source reviews

- `work/reviews/CAP-032-architecture-review.md` — 0 BLOCKER, 0 HIGH, 1 MEDIUM, 4 LOW
- `work/reviews/CAP-032-code-review.md` — 0 BLOCKER, 0 HIGH, 2 MEDIUM, 6 LOW
- `work/reviews/CAP-032-qa-review.md` — 0 BLOCKER, 0 HIGH, 3 MEDIUM, 2 LOW

## Triage decision

| Finding | Origin | Action |
|---|---|---|
| Arch M1 (Hono `ContentfulStatusCode` couples `platform/*`) | arch | **FIX** |
| Arch L1 (delete `NOT_FOUND` dead catalog entry) | arch | **FIX** |
| Arch L2 (add `RATE_LIMITED` / `LOCK_CONTENTION` per D-CAP-032-D) | arch | **FIX** |
| Arch L3 (envelope reads `c.get('requestId')` twice) | arch | **FIX** |
| Arch L4 (envelope `code` parameter accepts `INVALID_REQUEST`) | arch | **FIX** |
| Code M1 (envelope `code: keyof typeof ERROR_CODES` → `code: ErrorCode`) | code | **FIX** |
| Code M2 (rename + comment admin-blocklist replay test) | code | **FIX** |
| Code L1 (AC5 stub test needs a positive case) | code | **FIX** |
| Code L2 (tighten console.error spy assertion) | code | **FIX** |
| Code L3 (AC5 fallback must assert X-Request-Id header is null) | code | **FIX** |
| Code L6 (defensive redaction comment for `console.error`) | code | **FIX** |
| QA M1 (envelope-shape assertions on three route test files) | qa | **FIX** |
| QA L1 (comment for `if (headerId)` intent) | qa | **FIX** (folded into Arch L3) |
| QA L2 (rename `json.error.code` → `body.error.code` in webhooks test) | qa | **FIX** (folded into QA M1) |
| QA M2 (Q1: accept generic `VALIDATION_ERROR` reclassification) | qa | **ORCHESTRATOR** — orchestrator records the decision in `docs/rebuild/capability-ledger.md`; no code change |
| Code L5 (schedule `INVALID_REQUEST` removal) | code | **ORCHESTRATOR** — orchestrator records a follow-up CAP-NNN; no code change |
| Code L4 (`@ts-expect-error` demo is correct) | code | **DROP** — verified correct |

The implementer owns the 12 FIX items below. Orchestrator owns the 2 RECORD items.

## Fixes — exact changes

### F1 — Replace `ContentfulStatusCode` with local `HttpStatusCode` (Arch M1)

**File:** `apps/worker/src/platform/errors.ts`

1. Remove `import type { ContentfulStatusCode } from 'hono/utils/http-status';` (line 25).
2. Add a local literal union immediately above the `ERROR_CODES` declaration:

   ```ts
   /**
    * HTTP status codes that the error catalog can emit. Framework-neutral:
    * `platform/*` must not depend on Hono's `ContentfulStatusCode`. Status
    * codes recorded here are the ones the catalog actually maps to today
    * (D-CAP-032-D plus the live set).
    */
   export type HttpStatusCode =
     | 200 | 201 | 204
     | 400 | 401 | 403 | 404 | 409 | 413 | 429
     | 500 | 502 | 503;
   ```

3. Replace `ContentfulStatusCode` with `HttpStatusCode` on lines 127 and 134.

**File:** `apps/worker/src/http/middleware/error.ts`

4. Replace `import type { ContentfulStatusCode } from 'hono/utils/http-status';` (line 23) with `import type { HttpStatusCode } from '../../platform/errors';`.
5. Replace `httpStatus: ContentfulStatusCode` (line 49) with `httpStatus: HttpStatusCode`.

Rationale: `platform/*` is the bottom of the dependency graph and must remain framework-agnostic (architecture.md §Shape). Once one Hono type leaks in, the next five are easy.

### F2 — Delete `NOT_FOUND` and add 429/503 placeholder codes (Arch L1 + L2)

**File:** `apps/worker/src/platform/errors.ts`

1. Delete the `NOT_FOUND: 'NOT_FOUND',` line (currently line 56).
2. Add two new entries to the catalog, placed in semantically appropriate sections:

   ```ts
   // Rate limit / contention (429 / 503) — D-CAP-032-D catalogue-but-unused.
   // No route emits these today; declared so the next capability that needs
   // them has the catalog slot pre-allocated.
   RATE_LIMITED: 'RATE_LIMITED',
   LOCK_CONTENTION: 'LOCK_CONTENTION',
   ```

3. Assign the appropriate `httpStatus` for each — there is no `httpStatus` field on the catalog itself today; the mapping lives in `DomainErrorOptions.httpStatus` at the call site. So the new entries are just name additions (value-only). Confirm with `git grep "code: 'RATE_LIMITED'"` and `code: 'LOCK_CONTENTION'` after the addition — both should return zero hits *and that is correct* (these are documented as unused until a follow-up capability wires them).

### F3 — Tighten envelope signature (Code M1 + Arch L3 + L4 + QA L1)

**File:** `apps/worker/src/http/middleware/error.ts`

1. Change the `envelope` function signature so:
   - `code` parameter is typed against the value union, not the catalog keys.
   - `requestId` is the **single source of truth** — no second `c.get('requestId')` call inside the function.
   - The `c` parameter is removed if it becomes unused.

   Final shape:

   ```ts
   type EmittableErrorCode = Exclude<ErrorCode, 'INVALID_REQUEST'>;

   function envelope(
     code: EmittableErrorCode,
     message: string,
     httpStatus: HttpStatusCode,
     requestId: string,
   ): Response {
     const response = Response.json(
       { error: { code, message, requestId } },
       { status: httpStatus },
     );
     // Don't propagate the AC5 sentinel as a real header.
     if (requestId !== '<unknown>') {
       response.headers.set('X-Request-Id', requestId);
     }
     return response;
   }
   ```

2. Update the four call sites inside `errorMiddleware` to match the new signature:

   ```ts
   return envelope('VALIDATION_ERROR', err.errors[0]?.message ?? 'Validation failed', 400, resolveRequestId(c));
   ```

   ```ts
   return envelope(err.code, err.message, status, resolveRequestId(c));
   ```

   ```ts
   return envelope('VALIDATION_ERROR', 'Invalid JSON', 400, resolveRequestId(c));
   ```

   ```ts
   return envelope('INTERNAL', 'Internal server error', 500, resolveRequestId(c));
   ```

3. `envelope()`'s `EmittableErrorCode` type explicitly excludes `'INVALID_REQUEST'`. The `INVALID_REQUEST` entry remains in the catalog (with its deprecation comment) so the migration window stays valid, but the envelope helper cannot be tricked into emitting a deprecated code.

### F4 — Tighten `console.error` spy assertion (Code L2)

**File:** `apps/worker/src/http/middleware/error.test.ts`

Line 108 currently reads:

```ts
expect(spy).toHaveBeenCalled();
```

Replace with:

```ts
expect(spy).toHaveBeenCalledWith('[error-middleware] unhandled error:', expect.any(Error));
```

### F5 — Defensive redaction comment for `console.error` (Code L6)

**File:** `apps/worker/src/http/middleware/error.ts`

Add a one-line comment above the `console.error('[error-middleware] unhandled error:', err);` call (line 103):

```ts
// R-LOG-001: `err` must not carry body bytes, tokens, or secrets.
// Future redaction (D-CAP-006-B) must scrub `err.message` and `err.stack`
// before persisting.
```

### F6 — AC5 stub test: positive case + null-header assertion (Code L1 + L3)

**File:** `apps/worker/src/http/middleware/error.test.ts`

The current `runDirect` stub test (lines 113-128) only proves the fallback. Two additions:

1. Add a positive case to the AC5 describe block:

   ```ts
   it('propagates a real requestId through to the envelope', async () => {
     const response = runDirect(
       new DomainError({ code: 'INTERNAL', message: 'with id', httpStatus: 500 }),
       'some-uuid-aaaa-bbbb',
     );
     expect(response.status).toBe(500);
     const body = (await response.json()) as {
       error: { code: string; message: string; requestId: string };
     };
     expect(body.error.requestId).toBe('some-uuid-aaaa-bbbb');
     expect(response.headers.get('X-Request-Id')).toBe('some-uuid-aaaa-bbbb');
   });
   ```

2. Update the existing negative-case test to assert the header is absent:

   ```ts
   it('emits requestId "<unknown>" when c.get("requestId") is undefined', async () => {
     const response = runDirect(
       new DomainError({ code: 'INTERNAL', message: 'no middleware ran', httpStatus: 500 }),
       undefined,
     );
     expect(response.status).toBe(500);
     const body = (await response.json()) as {
       error: { code: string; message: string; requestId: string };
     };
     expect(body.error.requestId).toBe('<unknown>');
     expect(response.headers.get('X-Request-Id')).toBeNull();
   });
   ```

(NOTE: this requires `runDirect` to construct a `Response` whose `headers` are observable. After the F3 refactor, `envelope()` no longer takes `c`, so the response is built normally. The existing stub `c` is still passed (now only to `resolveRequestId(c)` at the call site, not to `envelope()`). The `Response` returned by `envelope()` is a real `Response` with a real `Headers` object — `headers.get(...)` works.)

### F7 — Rename + comment admin-blocklist replay test (Code M2)

**File:** `apps/worker/src/http/routes/admin-blocklist.worker.test.ts`

1. Find the existing replay test (likely named something like `"replay returns identical response"` or similar).
2. Rename to e.g. `"replay returns identical envelope shape with fresh requestId"`.
3. Add a one-line comment above the assertion explaining the simplification:

   ```ts
   // After 404 simplification, replay yields a fresh requestId but identical
   // envelope shape — assert shape, not bytes.
   ```

### F8 — Envelope-shape assertions on three route worker test files (QA M1)

**File:** `apps/worker/src/http/routes/webhooks.worker.test.ts`

Lines 160, 185, 209, 232 currently use `json.error.code`. Rename to `body.error.code` AND add an explicit `expect(body.error.requestId).toMatch(UUID_V4_REGEX)` (or equivalent) check at each site. The patterns already exist in `request-id.test.ts` — look there for the regex.

**File:** `apps/worker/src/http/routes/audit-events.worker.test.ts`

The file has no error-path test. Add a small test that exercises a thrown `DomainError` via the route handler (stub the use case to throw, or call the route with a malformed request that triggers a known failure path). Assert the canonical envelope shape: `status`, `body.error.code`, `body.error.message`, `body.error.requestId`, and `response.headers.get('X-Request-Id')` matching the body.

**File:** `apps/worker/src/http/routes/setup-status.worker.test.ts`

The route has no error branch in production (always 200 with `complete: false` until installation is done). The QA reviewer notes "the natural fix is a negative-path test". Two reasonable options:

- (a) Add a test that proves the route never emits an error envelope (a positive assertion that every response has `body.error === undefined`).
- (b) Stub the use case to throw and assert the envelope shape.

Option (a) is the lighter-touch fix (no throw infrastructure needed). Pick that unless the existing test infrastructure makes (b) cheaper.

## Out of scope (orchestrator handles)

- **Recording QA M2 decision** (accept generic `VALIDATION_ERROR` reclassification for the three auth.ts sites): orchestrator appends to `docs/rebuild/capability-ledger.md` under CAP-032.
- **Recording Code L5 deferral** (schedule `INVALID_REQUEST` removal): orchestrator adds a new `Pending` row to `docs/rebuild/capability-ledger.md` for `CAP-NNN — remove deprecated INVALID_REQUEST catalog entry`. The exact ID is allocated by the orchestrator.
- **CAP-032 ledger close-out, implementation log entry, archive cleanup, commit.** All orchestrator work after the fix-slice lands and gates pass.

## File ownership

The implementer owns every file listed under **Fixes** above. No other agent writes them.

## Vertical slice

The fix-slice touches only already-owned files from the main CAP-032 slice. No new edges. Execute in this order:

1. F1 (platform/errors.ts ContentfulStatusCode → HttpStatusCode) — tsc should stay green.
2. F2 (NOT_FOUND delete + RATE_LIMITED / LOCK_CONTENTION add) — tsc should stay green.
3. F3 (envelope signature refactor) — this is the riskiest. All four error tests must still pass.
4. F4 + F5 (test tightening + console.error comment).
5. F6 (AC5 stub test additions).
6. F7 (admin-blocklist replay test rename).
7. F8 (envelope-shape assertions on three route test files).
8. Run all six quality gates from the repo root.

## Reading list

- `work/active/CAP-032-stable-error-model/task.md` (main slice contract — unchanged)
- `work/reviews/CAP-032-architecture-review.md`
- `work/reviews/CAP-032-code-review.md`
- `work/reviews/CAP-032-qa-review.md`
- `apps/worker/src/platform/errors.ts`
- `apps/worker/src/http/middleware/error.ts`
- `apps/worker/src/http/middleware/error.test.ts`
- `apps/worker/src/http/middleware/request-id.test.ts` (UUIDv4 regex reference for F8)
- `apps/worker/src/http/routes/admin-blocklist.worker.test.ts`
- `apps/worker/src/http/routes/audit-events.worker.test.ts`
- `apps/worker/src/http/routes/setup-status.worker.test.ts`
- `apps/worker/src/http/routes/webhooks.worker.test.ts`
- `.claude/rules/coding.md` (especially §Errors, §Abstraction discipline)
- `.claude/rules/testing.md`
- `.claude/templates/handoff.md` (only if reporting blocked)

## Quality gates (must pass)

```
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:worker
pnpm build
pnpm scaffold doctor
```

The implementer runs all six from the repo root and reports the verbatim output in the handoff. A failed gate is a BLOCKER for the fix-slice (same rule as the main slice).

## Handoff

Use the same `## Task · Status · Changes · Files · Tests · Findings · Risks · Next` format from `.claude/templates/handoff.md`. The orchestrator will re-run the gates independently of the implementer's report — do not mark the slice complete on a self-report.
