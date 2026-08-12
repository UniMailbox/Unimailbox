# CAP-007 Fix-Up — Consolidated Review Findings

## Reviews received
- Architecture: ACCEPT WITH NOTES
- Code: ACCEPT WITH NOTES

## Fix-up items applied

### MEDIUM — code review

1. **Test helpers duplicated** (setup-gate.worker.test.ts + setup-status.worker.test.ts).
   Both files had byte-identical `seedInstallationState`, `resetAndMigrate`, and `FIXED_TIMESTAMP`.
   - Promoted to `packages/test-kit/src/seed.ts`.
   - `seedInstallationState` signature changed from positional `(status, currentStep)` to
     object `({ status?, currentStep? })` with `currentStep` typed as `InstallationStep`.
   - Both test files now import from `@unimailbox/test-kit`.
   - Resolves D-CAP-006-A.

### LOW — code review

2. **`currentStep` typed as `string`** in the local `seedInstallationState`.
   - Fixed by typing as `InstallationStep` in the test-kit version.

3. **Strict `toBe('application/json')`** in setup-status tests.
   - Changed to `toMatch(/^application\/json\b/)` — survives Hono adding charset.

### Deferred

4. **No DB-failure test at the endpoint level** (both reviewers LOW).
   - Error middleware is a CAP-001 stub. Deferred as D-CAP-007-A.

5. **Redundant exemption tests** (code review LOW).
   - Left as-is — harmless, self-contained blocks.

### No action — incorrect finding

6. **Architecture reviewer: "doctor fix is a no-op"**.
   - Factually incorrect: `ALLOWED['onboarding']` = `Set(['platform','contracts','identity'])`
     does NOT contain `'onboarding'`. The `t !== m` guard is the actual fix.
