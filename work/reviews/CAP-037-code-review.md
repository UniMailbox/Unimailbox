# Code Review — CAP-037 (INVALID_JSON guard on POST /api/v1/admin/blocklist)

**Reviewer:** code-reviewer (subagent, typescript-code-reviewer)
**Date:** 2026-08-14
**Branch:** `cap/CAP-020-026-business-loop`
**Scope:** Single-endpoint mechanical fix — port the INVALID_JSON guard from
`apps/worker/src/http/routes/admin-role-policies.ts:132-151` to
`apps/worker/src/http/routes/admin-blocklist.ts:88`. Resolves deferred CAP-035
finding L1.

**Status:** ACCEPT WITH FIXES (M1 + L2 applied; M2 promoted to ledger; L1 accepted).

---

## Summary

The fix is a verbatim mirror of an already-audited pattern (the role-policy
guard from CAP-035 fix slice M1). It introduces no new abstraction, no new
dependency, no schema change. The diff is +22/-1 in `admin-blocklist.ts`
(import + try/catch wrapping) and +20/-0 in `admin-blocklist.worker.test.ts`
(one test inside the existing `describe('POST /api/v1/admin/blocklist', …)`
block). The test uses a fresh UUID for the `Idempotency-Key`, mirrors the
established pattern from `admin-role-policies.worker.test.ts:672-693`, and
asserts both the status code and the stable `INVALID_JSON` code.

The findings below are documentation drift, not code defects. The code in
the working tree is correct.

---

## Acceptance criteria (QA only)

N/A — code review.

---

## BLOCKER

None.

## HIGH

None.

## MEDIUM

### M1 — Contract and ledger overstate pre-fix severity

- **Where:** `work/active/CAP-037-invalid-json-blocklist/task.md:5-9` (original
  text); `docs/rebuild/capability-ledger.md` Pending row for CAP-037 (original
  text).
- **Violates:** `.claude/rules/documentation.md` §"One fact, one home" and
  §"Documentation update gate" — the documentation must not mis-state the
  before/after behavior of the capability.
- **Failure scenario:** A future agent reading only the ledger row (per
  CLAUDE.md §State recovery step 3) concludes that the pre-fix code returned
  HTTP 500 for malformed JSON and that the fix prevents a 500 → 400 regression.
  The pre-fix code already returned 400 (via `error.ts:31-41`'s `SyntaxError`
  branch). The actual defect is **generic** `VALIDATION_ERROR` code conflated
  with zod structural failures, and **no audit log line**. The fix swaps
  `VALIDATION_ERROR` for a stable dedicated `INVALID_JSON` and adds the
  structured warn log. Mis-stating the before/after will mislead the next
  investigation into "where else does malformed JSON return 500".
- **Fix:** Update contract `task.md:5-9` and the ledger row to state the
  accurate pre-fix behavior. Both corrected.

### M2 — INVALID_JSON path does not write an `idempotency_records` row

- **Where:** `apps/worker/src/http/routes/admin-blocklist.ts:96-108` (new
  guard); same pattern at `apps/worker/src/http/routes/admin-role-policies.ts:132-151`.
- **Violates:** Not a violation — this is intentional per ADR-004
  (`.claude/rules/security.md` §Idempotency). Recorded as a documentation gap
  for CAP-031 to codify.
- **Failure scenario:** A future contributor reads the DELETE 404 path
  (`admin-blocklist.ts:229-251` — which DOES write an idempotency record for a
  404 outcome) and "fixes" the INVALID_JSON guard the same way: stores
  `sha256('{not valid json')` and replays it on retry. Per ADR-004, the same
  Idempotency-Key + a corrected body would then return
  `409 IDEMPOTENCY_KEY_REUSED`, blocking legitimate client retries. The fix
  would be reverted, or worse, shipped and silently break clients.
- **Fix:** Document the gap. Recorded as **D-CAP-037-A** in the capability
  ledger, promoted to **CAP-031** (request validation + 1 MB body limit) as
  the natural owner — CAP-031 touches every POST/PUT/DELETE route and can
  codify the rule "do not write idempotency record on client-side validation
  failures" once.

## LOW

### L1 — Test header drops "Security M1" provenance tag

- **Where:** New test in
  `apps/worker/src/http/routes/admin-blocklist.worker.test.ts` (inside the
  `describe('POST /api/v1/admin/blocklist', …)` block).
- **Fix:** Acceptable per the capability contract `task.md:104-105` — the
  contract explicitly cites `CAP-037` (not `CAP-035 Security M1`) as the
  provenance tag for the new test. No action.

### L2 — Contract cites wrong line range for the role-policy guard

- **Where:** `work/active/CAP-037-invalid-json-blocklist/task.md:8, 20, 92, 109`.
- **Violates:** `.claude/rules/coding.md` §Naming — comment citations should
  be accurate.
- **Failure scenario:** A future implementer asked to mirror the guard in a
  third site (`compose.ts`, `mailboxes.ts`, `setup.ts`, or `admin.ts` per
  CAP-031) navigates to `:128-151` in `admin-role-policies.ts` and finds only
  the comment block — the actual guard code is at `:132-151`. They either
  give up or copy the comment, producing a broken mirror.
- **Fix:** Replace `:128-151` with `:132-151` in the contract. Note:
  `:128-131` is the preceding comment block, `:132-151` is the try/catch.

---

## Not verified

- **Test coverage of the zod `ZodError` fall-through.** The new test only
  exercises the `SyntaxError` branch. The pre-existing zod validation tests
  for the blocklist endpoint cover the `ZodError → 400 VALIDATION_ERROR`
  fall-through implicitly, so no new test is needed, but I did not add one.
  Verifiable by re-running `pnpm test:worker` filtered to
  `admin-blocklist.worker.test.ts`.
- **Helper extraction across `admin-role-policies.ts` and `admin-blocklist.ts`.**
  Per the capability contract and Rule of Three, this is deliberately NOT
  done. If a third site lands (CAP-031 territory), the extract becomes the
  CAP-031 decision. Not in scope for this slice.
