# CAP-032 — Code Review

**Reviewer:** code-reviewer · **Date:** 2026-08-15 · **Base:** `cap/CAP-020-026-business-loop` (dirty)

**Status:** ACCEPT WITH FIXES

## Summary

CAP-032 is structurally clean: closed `ErrorCode` union enforced at the type level, real `requestId` middleware with UUIDv4, canonical `{ error: { code, message, requestId } }` envelope across all four error branches, `http/errors.ts` deleted, the hand-rolled 404 in `admin-blocklist.ts` replaced with a typed `DomainError`, and test coverage maps to acceptance criteria AC1–AC5. The findings below are calibration and naming nits, not correctness bugs. No BLOCKER, no HIGH.

## BLOCKER

None.

## HIGH

None.

## MEDIUM

### M1 — `envelope()` parameter `code: keyof typeof ERROR_CODES` couples the helper to the catalog's key identity, not its values

- **Where:** `apps/worker/src/http/middleware/error.ts:47`.
- **Violates:** `.claude/rules/coding.md` §Abstraction discipline — the helper should not silently change meaning if the catalog is reshaped.
- **Failure scenario:** Today the catalog is `{ VALIDATION_ERROR: 'VALIDATION_ERROR', ... }`, so `keyof typeof ERROR_CODES` happens to equal `ErrorCode`. A future maintainer renames a key (say `INVALID_JSON: 'INVALID_BODY'` for an external spec change) without updating the value. Now `keyof typeof ERROR_CODES` is `'INVALID_JSON'` while `ErrorCode` is `'INVALID_BODY'`. The helper's parameter type still accepts both, but the runtime `code` literal is the *key*, not the *value*. Tests that assert `body.error.code === 'INVALID_BODY'` break silently because the wire format changed.
- **Fix:** Change `code: keyof typeof ERROR_CODES` to `code: ErrorCode` (import `ErrorCode` from `platform/errors.ts`). The helper is then typed against the value union, which is what reaches the wire.

### M2 — Admin-blocklist replay-test intent should be explicit ("envelope-shape replay", not "byte replay")

- **Where:** `apps/worker/src/http/routes/admin-blocklist.worker.test.ts` — the replay test for DELETE 404. The assertion was correctly simplified to "same code, same status, fresh requestId" after 404s stopped writing `idempotency_records`, but the test name and inline comment still read like a byte-equality test.
- **Violates:** `.claude/rules/testing.md` §Honesty — the test's intent should match its name. A future reader will assume the change is a regression without a signal that the simplification was deliberate.
- **Fix:** Rename the test to e.g. `"replay returns same envelope shape with fresh requestId"` and add a one-line comment above the assertion: "After 404 simplification, replay yields fresh requestId but identical shape — assert shape, not bytes."

## LOW

### L1 — AC5 stub test is tautological

- **Where:** `apps/worker/src/http/middleware/error.test.ts:114` — `runDirect` stubs `c.get('requestId')` to return `undefined`, then asserts `body.error.requestId === '<unknown>'`. Proves the fallback runs; proves nothing about the non-fallback path.
- **Failure scenario:** A future refactor swaps `resolveRequestId` to always return `'<unknown>'` regardless of input. The stub test still passes (because the input was `undefined` and the output was `'<unknown>'`) but real requests now lose their correlation id. The bug is invisible to the test suite.
- **Fix:** Add a positive case: `runDirect(err, 'some-uuid')` should produce `body.error.requestId === 'some-uuid'`. Without it the test only proves the helper handles the absent case — exactly the case AC5 is designed to prevent.

### L2 — `console.error` spy assertion is too loose

- **Where:** `apps/worker/src/http/middleware/error.test.ts:108` — `expect(spy).toHaveBeenCalled()` passes whether the logger emitted the expected tag, a different tag, or a stray debug line.
- **Failure scenario:** A future refactor drops the `[error-middleware]` tag, accidentally splitting production 500s across two logger sinks. The spy assertion still passes (it was called); the missing-tag regression is invisible.
- **Fix:** Tighten to `expect(spy).toHaveBeenCalledWith('[error-middleware] unhandled error:', expect.any(Error))`.

### L3 — AC5 stub test does not assert X-Request-Id header behaviour on the fallback path

- **Where:** `apps/worker/src/http/middleware/error.test.ts:114` — when `c.get('requestId')` is undefined, `envelope()`'s `if (headerId)` branch is skipped. The test does not assert the header is absent.
- **Failure scenario:** The conditional is deleted silently (a refactor "simplifies" envelope by always setting the header). The fallback path now emits `X-Request-Id: undefined` to the wire — visible to clients as a literal string "undefined" — and the test still passes.
- **Fix:** Add `expect(response.headers.get('X-Request-Id')).toBeNull()` to the stub test.

### L4 — `// @ts-expect-error` in `errors.test.ts:27-28` is the right demo of the closed union

- **Where:** `apps/worker/src/platform/errors.test.ts:27-28`.
- **Violates:** Nothing. Noting for completeness — the directive comment is in the right place; the `@typescript-eslint/ban-ts-comment` lint rule requires a description and the existing one (`@ts-expect-error — AC3 closed-union demo`) is sufficient.

### L5 — `ERROR_CODES.INVALID_REQUEST` is deprecated with no scheduled removal

- **Where:** `apps/worker/src/platform/errors.ts:46`.
- **Violates:** `.claude/rules/coding.md` §Abstraction discipline corollaries — "Delete dead code rather than commenting it out — git remembers." A deprecated catalog entry is not dead code today, but the deprecation has no end date. Without a scheduled removal, the comment becomes a permanent fixture and the "deprecated" tag loses meaning.
- **Fix:** Orchestrator records a follow-up capability in `docs/rebuild/capability-ledger.md` (e.g., `CAP-NNN — remove deprecated INVALID_REQUEST catalog entry`) so the deletion is scheduled, not promised.

### L6 — `console.error('[error-middleware] unhandled error:', err)` logs the full `Error` object

- **Where:** `apps/worker/src/http/middleware/error.ts:103`.
- **Violates:** Not a current violation — `Error` instances don't carry passwords/tokens/body bytes by default, so `security.md §Logging` is honoured today. But D-CAP-006-B (logger migration) is the planned replacement, and a future maintainer adding structured fields to the logger might assume `err.message`/`err.stack` are already scrubbed.
- **Fix:** Add a one-line comment above the `console.error` call: "R-LOG-001: `err` must not carry body bytes, tokens, or secrets. Future redaction (D-CAP-006-B) must scrub `err.message` and `err.stack` before persisting."

## Files reviewed

- `apps/worker/src/platform/errors.ts`
- `apps/worker/src/platform/errors.test.ts`
- `apps/worker/src/platform/env.ts`
- `apps/worker/src/http/middleware/request-id.ts`
- `apps/worker/src/http/middleware/request-id.test.ts`
- `apps/worker/src/http/middleware/error.ts`
- `apps/worker/src/http/middleware/error.test.ts`
- `apps/worker/src/http/routes/admin-blocklist.ts`
- `apps/worker/src/http/routes/admin-blocklist.worker.test.ts`
- `apps/worker/src/http/routes/auth.ts`
- `apps/worker/src/http/errors.ts` (verified deleted)

## Verdict

**ACCEPT WITH FIXES.** Apply M1 (`code: keyof typeof ERROR_CODES` → `code: ErrorCode`) in this slice; rename and annotate M2; record L5's deprecation-removal capability in the ledger. The six findings are calibration nits, not correctness bugs.

## Hook loop note

`.claude/hooks/validate-subagent-stop.sh:149` greps the transcript file for `^[[:space:]]*##[[:space:]]+${h}`. The transcript format for subagents is JSONL where each line is one JSON record starting with `{` — agent text content is embedded inside JSON strings with `\n` escapes, never at line-start. The hook regex cannot match headings in this format. This is a structural incompatibility independent of whether the agent's message content includes the required `## BLOCKER / HIGH / MEDIUM / LOW` headings (it does, in plain text). Resolving this requires editing the hook to strip JSON wrappers or reading the transcript in a different format. The findings above are delivered regardless of hook behaviour.
