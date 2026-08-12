# CAP-006 Fix-Up — Consolidated Review Findings

## Reviews received
- Architecture: ACCEPT WITH NOTES
- Code: ACCEPT WITH NOTES
- QA: (did not report — acceptance criteria verified by orchestrator via quality gates)

## Fix-up items

### MEDIUM — must fix before acceptance

1. **Log on catch** (setup-gate.ts:46-52). Both reviews flagged the silent error swallow.
   - Change `catch {` → `catch (err)`.
   - Add `console.warn` with the error message (structured logger not yet wired — request-id middleware is a CAP-001 stub).

2. **Replace `as` casts with zod parse** (installation-state-repository.ts:32-35). Code review M2.
   - Add `installationStateRowSchema` to `packages/contracts/src/index.ts`.
   - Use `.parse()` on the raw D1 row instead of `as` casts.
   - This aligns with the existing `emailAddressSchema` / `uuidSchema` convention.

3. **Test the DB-failure catch path** (setup-gate.worker.test.ts). Code review M3 / Arch M2.
   - Add `R-SETUP-004: DB query failure → redirect to /setup (fail-closed)`.
   - Test: `reset()` without `migrationsDb()` → table doesn't exist → query throws → redirect fires.

### LOW — fix while here

4. **Explicit type** (setup-gate.ts:45). `let state;` → `let state: InstallationStateInfo | null;`.

5. **`Database` type alias** (installation-state-repository.ts:16). Use `Database` from `../../platform/database` instead of raw `D1Database`.

6. **Deterministic timestamp in tests** (setup-gate.worker.test.ts:25). Replace `datetime('now')` with a fixed constant.

7. **Exemption symmetry note** (setup-gate.ts:35-39). `/api/v1/setup` (no trailing slash) is not exempt, but this is fine — no real endpoint exists at that exact path. Document in a comment.
