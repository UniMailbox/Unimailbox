# CAP-038 — Code Review

> Location: `work/reviews/CAP-038-code-review.md`.

**Reviewer:** `code-reviewer` (`.claude/agents/code-reviewer.md`) ·
**Date:** 2026-08-15 ·
**Base:** `f08924a`

**Status:** ACCEPT WITH FIXES

## Summary

The slice is mechanically clean: the deprecated `INVALID_REQUEST` entry is gone,
its type-level and runtime narrowing are correctly collapsed, and every caller
of `envelope()` is provably type-safe against the widened `ErrorCode` union.
`tsc --build` and the 324-case unit-test run both pass. The single finding is a
test-quality defect: the `AC1` "migration-window" test in `errors.test.ts` is
now redundant and its title/comment no longer match what it asserts. Fix is
mechanical — rename the test, drop the redundant assertions (the catalog-shape
test already covers them), or repurpose it to assert the genuine
catalogue-but-unused codes (`RATE_LIMITED` / `LOCK_CONTENTION`) that its inline
comment already references.

## Acceptance criteria — QA reviews only

> Not applicable (this is the code review, not QA). See `CAP-038-qa-review.md`
> for AC1–AC5 evidence. All four `envelope()` call sites pass values that are
> members of the post-slice `ErrorCode` union; verified `tsc --build` exits 0
> and `pnpm test:unit` is 324/324.

## BLOCKER

> Ship-stopping. None found.

## HIGH

> Wrong under a realistic condition. None found.

## MEDIUM

### M1 — `errors.test.ts` AC1 "migration-window" test is now redundant and its name/comment disagree with its assertions

- **Where:** `apps/worker/src/platform/errors.test.ts:50-56`
- **Violates:** `.claude/rules/testing.md` §What must be tested (tests must assert behaviour, not that nothing threw); `.claude/rules/coding.md` §Comments (a comment that no longer matches the code is noise).
- **Failure scenario:** The test title claims to assert "every documented migration-window code is present in the catalog", but the post-slice assertions are `BODY_TOO_LARGE`, `INTERNAL`, `VALIDATION_ERROR` — none of which are migration-window codes (the only one was `INVALID_REQUEST`, deleted in this slice). The inline comment still says "D-CAP-032-D — 429 / 503 status mappings", which references the catalogue-but-unused `RATE_LIMITED` / `LOCK_CONTENTION` codes, but neither is asserted. A reviewer grepping `RATE_LIMITED` in tests finds nothing; the discipline that "every documented status mapping has a present catalog entry" is unverified for the 429 / 503 slots. Additionally, the three live codes that *are* asserted are already proven present by the AC1 catalog test at `:11-21` (every entry value equals its key), making this test belt-and-braces for a subset of a subset.
- **Fix:** Pick one of:
  1. **Repurpose to match the comment.** Assert the actual catalogue-but-unused codes the comment names:
     ```ts
     it('AC1: every documented catalogue-but-unused code is present in the catalog (D-CAP-032-D)', () => {
       // 429 / 503 status mappings — declared for future use, no live site throws these yet.
       expect(ERROR_CODES.RATE_LIMITED).toBe('RATE_LIMITED');
       expect(ERROR_CODES.LOCK_CONTENTION).toBe('LOCK_CONTENTION');
     });
     ```
     This both matches the comment and asserts something the AC1 catalog-shape test does not (live + non-empty distinction).
  2. **Delete the test.** The AC1 catalog-shape test at `:11-21` already proves every entry exists and is well-formed. Keep that one only.

## LOW

### L1 — `code: ErrorCode` parameter widening is a defensive contract regression

- **Where:** `apps/worker/src/http/middleware/error.ts:45`
- **Violates:** Not a hard violation — the parameter widening from `EmittableErrorCode = Exclude<ErrorCode, 'INVALID_REQUEST'>` to `ErrorCode` is provably safe (every previously-passable value is still passable; the `Exclude` was a subset). But the *intent* of the narrowing — "the envelope helper cannot be tricked into emitting a deprecated code" (CAP-032 Arch L4 / Code M1) — is now expressed only in the closed `ERROR_CODES` catalog. A future reviewer who adds a deprecated-but-not-yet-removed entry has no compile-time signal at the envelope boundary to remind them.
- **Failure scenario:** A future slice re-introduces the migration-window pattern (deprecated entry kept in catalog while consumers migrate). Without the narrowing, the envelope helper will silently accept it. This is **not** a current bug — the slice is correct as written — but the belt-and-braces the previous CAP-032 fix slice added is now gone.
- **Fix:** No action required for this slice; the closed catalog *is* the enforcement mechanism and `INVALID_REQUEST` is fully removed. If the migration-window pattern returns for a different code, reintroduce the narrowing at that time. Flagging only for the orchestrator's awareness.

## Not verified

- **`pnpm lint`, `pnpm test:worker`, `pnpm build`, `pnpm scaffold doctor`** — the orchestrator runs these as part of the gate. I ran `pnpm typecheck` and `pnpm test:unit` (both pass); the other four are out of scope for the code review per `.claude/agents/code-reviewer.md` (the orchestrator owns quality-gate coordination).
- **`@ts-expect-error` AC3 demo integrity at runtime** — the demo uses `'R-AUTHZ-004'` (not `INVALID_REQUEST`), and the post-slice `ErrorCode` union still does not contain `'R-AUTHZ-004'` (verified by reading the post-slice `ERROR_CODES` object — no entry has that key). The directive still suppresses a real compile error, so the demo still does its job. I did not instrument a synthetic `ErrorCode = string` widening to confirm the regression-catching behaviour end-to-end, but the comment + directive relationship is unchanged from CAP-032.

## Required fixes

1. M1 — resolve the `errors.test.ts:50-56` test name/comment/assertion mismatch (repurpose to catalogue-but-unused codes, or delete).

---

The slice is otherwise clean: AC1 (no `INVALID_REQUEST` hit in source), AC2 (typecheck passes with `EmittableErrorCode` removed), AC3 (test update passes), and the envelope shape + R-LOG-001 invariants are all preserved. Accepting this slice hinges on the M1 fix landing in the same commit.