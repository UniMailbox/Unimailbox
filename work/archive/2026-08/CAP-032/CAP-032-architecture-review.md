# CAP-032 — Architecture Review

**Reviewer:** architecture-reviewer · **Date:** 2026-08-15 · **Base:** `cap/CAP-020-026-business-loop` (dirty)

**Status:** ACCEPT WITH FIXES

## Summary

The slice is architecturally clean. The closed `ERROR_CODES` catalog is the right mechanism for R-API-002; the request-id middleware is in the right slot in `router.ts`; every `/api/v1/*` error now flows through one envelope. The only real findings are minor: a single dead catalog entry (`NOT_FOUND`) and a subtle type-coupling of `platform/*` to Hono's `ContentfulStatusCode`. None block acceptance.

## BLOCKER

None.

## HIGH

None.

## MEDIUM

### M1 — `platform/errors.ts` now imports a Hono utility type, coupling the lowest layer to Hono

- **Where:** `apps/worker/src/platform/errors.ts` (the `httpStatus?: ContentfulStatusCode` field) and `apps/worker/src/http/middleware/error.ts:23,49`.
- **Violates:** Spirit of `.claude/rules/architecture.md` §Shape — `platform/` is the bottom of the dependency graph (modules depend on `platform/*`, never the other way around); §Forbidden — "A module importing Hono... directly" is forbidden for *modules*, and `platform/*` is by convention framework-agnostic so it can host use-case code without dragging the framework in. The previous type was the framework-neutral `number`; the new type is `ContentfulStatusCode` from `hono/utils/http-status`.
- **Failure scenario:** Today, fine — `import type` is erased at runtime, no bundle bloat. Future: a follow-up capability that swaps Hono for a different HTTP framework (or extracts `DomainError` into a shared package) must touch `platform/errors.ts`, even though `platform/*` has no Hono runtime dependency. This is the first leak of a framework type into the lowest layer; future reviewers will see precedent and widen the leak.
- **Fix:** Define `export type HttpStatusCode = 200 | 201 | 204 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503 | ...` locally in `platform/errors.ts` and use it instead of `ContentfulStatusCode`. Keep the `envelope()` helper's call signature strict; the local literal union gives the same type-safety without the framework dependency.

## LOW

### L1 — `NOT_FOUND` is a dead catalog entry

- **Where:** `apps/worker/src/platform/errors.ts` — `NOT_FOUND: 'NOT_FOUND'`.
- **Violates:** The contract's own D-CAP-032-D discipline ("Every `code: '<X>'` literal currently in `apps/worker/src/**` must be a member of that union... Each entry has a call site OR is a documented migration-window entry"). The companion deprecated entry `INVALID_REQUEST` carries an explicit comment ("Deprecated — migration window only; remove in a follow-up capability"). `NOT_FOUND` carries no such comment and has zero reachable sites (verified: `grep -rE "'NOT_FOUND'" apps/worker/src/ --include='*.ts'` returns only the catalog definition itself).
- **Failure scenario:** Future agent reading the catalog sees `NOT_FOUND` and assumes it is intentional. Adds a `throw new DomainError({ code: 'NOT_FOUND', httpStatus: 404 })` somewhere — which is precisely the pattern that the closed catalog was designed to prevent (specific 404 codes like `BLOCKLIST_ENTRY_NOT_FOUND` exist precisely so callers can react). The dead entry normalises generic 404s.
- **Fix:** Delete the entry. If it is intentionally reserved, add a one-line comment naming the future capability that will use it.

### L2 — D-CAP-032-D deviation: 429 / 503 placeholder codes were not added

- **Where:** `apps/worker/src/platform/errors.ts` — entire catalog.
- **Violates:** Contract §Decisions D-CAP-032-D ("Status codes that exist in `.claude/rules/architecture.md` §API conventions but are not yet emitted by any route (`429`, `503`) are **catalogued but unused**. ... Implementer adds them as `httpStatus: 429` / `httpStatus: 503` constants in the catalog but does not wire them into a route.") and R-API-003 (the catalog is the enforcement mechanism for status mapping).
- **Failure scenario:** The next capability that introduces rate-limiting (e.g., a CAP-038-style rate-limit on `/api/v1/auth/*`) must remember to add a `RATE_LIMITED` code at the same time as wiring it. The contract had pre-allocated the catalog slot so the wire-up and the catalog edit were one diff; now they are two diffs in two capabilities, and the order matters.
- **Fix:** Either add `RATE_LIMITED: 'RATE_LIMITED'` and `LOCK_CONTENTION: 'LOCK_CONTENTION'` to the catalog now (no use sites required, matches D-CAP-032-D), or record the deviation in the capability ledger as a deliberate non-implementation of D-CAP-032-D so the next capability that needs them does not forget.

### L3 — `envelope()` reads `c.get('requestId')` twice per call

- **Where:** `apps/worker/src/http/middleware/error.ts:34,63` — `resolveRequestId(c)` and the explicit header propagation.
- **Violates:** `.claude/rules/coding.md` §Structure — small-but-real duplication. Two reads of the same context variable for one envelope is harmless but redundant.
- **Failure scenario:** Cosmetic only. If a future maintainer changes the resolution semantics (e.g., resolves from header instead of context for a replay), the two call sites can drift.
- **Fix:** Pass `requestId` into `envelope()` and let it set the header from the parameter (single source of truth), or have `envelope()` own the resolution and read `c.get('requestId')` once internally. Pick one.

### L4 — `INVALID_REQUEST` remains reachable from the envelope helper

- **Where:** `apps/worker/src/platform/errors.ts:46` + `apps/worker/src/http/middleware/error.ts:47` — the `envelope()` parameter type is `keyof typeof ERROR_CODES`, which includes `'INVALID_REQUEST'`.
- **Violates:** Not a hard violation — the deprecated entry is intentional and documented. But the envelope helper can emit a deprecated code, which means future regressions that "use the catalog for convenience" can resurrect `INVALID_REQUEST` after the three auth.ts sites were removed in this slice.
- **Failure scenario:** A future module throws `DomainError({ code: 'INVALID_REQUEST', httpStatus: 400 })` because the catalog still has it. The error middleware emits `400 INVALID_REQUEST`, which violates D-CAP-031-C / Fix 9 (the renaming this slice just did).
- **Fix:** Either (a) move `INVALID_REQUEST` to a separate `DEPRECATED_CODES` object that is *not* included in `ErrorCode`, with a comment "do not emit, migration window", or (b) tighten the `envelope()` `code` parameter to `Exclude<keyof typeof ERROR_CODES, 'INVALID_REQUEST'>`. Pick one; either prevents accidental reintroduction.

## Observations

### O1 — Client migration risk is undocumented in the contract

The contract claims R-API-001 ("`code` and `requestId` are mandatory") but does not call out the backward-compatibility story for `apps/web/`. Verified: client code only reads `error.message`; no client code currently destructures `requestId`. Because the new field is additive, well-behaved clients are unaffected. This is a documentation gap, not a blocker; CAP-033 / CAP-034 should pick it up.

### O2 — `console.error('[error-middleware] unhandled error:', err)` pre-dates this slice

The unknown-error branch logs the full error object, which may include a `cause` chain (provider SDK errors, for example). This is a pre-existing concern tracked under D-CAP-006-B (logger migration). CAP-032 does not change it; flagging for awareness only.

## Not verified

- **Bundle size impact.** I did not run `pnpm build` and compare bundle size before/after. The `ContentfulStatusCode` import is `import type`, so the runtime cost should be zero; the source cost is negligible. Worth a quick check at the orchestrator's discretion.
- **Client-side integration test.** The contract claims AC4 ("X-Request-Id header AND envelope requestId") is verifiable end-to-end via a worker test. I read `admin-blocklist.worker.test.ts` and saw `expect(response.headers.get('X-Request-Id')).toEqual(body.error.requestId)` — that satisfies the worker side. No web client was probed (see O1).
- **`webhookV1` middleware inheritance.** Hono's middleware composition should propagate `requestId` to the webhook sibling sub-app via the parent router's `router.use('*', requestId)`. The parent router's `requestId` / `setupGate` / `authn` chain applies to both sub-apps per the existing router comment. Trust-but-verify: the QA reviewer should add one webhook-path test that asserts both header and envelope `requestId`.

## Required fixes

1. M1 — replace `ContentfulStatusCode` with a local `HttpStatusCode` literal union in `platform/errors.ts`.
2. L1 — delete or document `NOT_FOUND`.
3. L2 — either add `RATE_LIMITED` / `LOCK_CONTENTION` placeholder codes or record the deviation in the ledger.

(L3, L4 are cheap wins and worth folding into the same PR but do not block acceptance.)

## Verdict

**ACCEPT WITH FIXES** — The slice delivers R-API-001 (canonical envelope with `requestId`), R-API-002 (closed catalog), and the contract's hand-rolled-error cleanup. The architecture is sound: middleware order is correct (`requestId` before `setupGate` and `authn`), `http/errors.ts` is gone, the catalog reconciles to every call site except one (L1), and no module boundary is crossed. The Hono-type coupling (M1) is the most consequential concern and should be fixed in this slice because it is the first framework-type leak into `platform/*` and reviewer precedent matters; once one slips in, the next five are easy. L1 (dead `NOT_FOUND`) and L2 (D-CAP-032-D deviation on 429/503 placeholders) are small cleanups that the orchestrator should either fold in or record as deliberate non-implementations in the ledger. Nothing here blocks acceptance.