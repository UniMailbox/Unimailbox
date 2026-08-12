# CAP-007 — `GET /api/v1/setup/status` → `{ currentStep: 'claim' }` on a fresh DB

**Phase:** 0 · **Status:** In Progress · **Started:** 2026-08-12

## Goal

A `GET /api/v1/setup/status` endpoint that returns the current installation state in the success
envelope `{ "data": { "status": ..., "currentStep": ... } }`. On a fresh DB (no `installation_state`
row), the response defaults to `{ "status": "setup", "currentStep": "claim" }` — the first step of
the setup wizard. This endpoint is the first real API route and establishes the route-handler
pattern for all future setup endpoints.

## Scope

- **`getSetupStatus` use case** in the onboarding module. Calls the existing `getInstallationState`
  repository. When the row is absent (fresh DB), returns
  `{ status: 'setup', currentStep: 'claim' }`. Otherwise returns the row's state.
- **Make the repository private (D-CAP-006-C).** The onboarding module's `index.ts` exports
  `getSetupStatus` instead of `getInstallationState`. The repository file itself stays unchanged —
  it just stops being re-exported.
- **Update `setup-gate.ts`** to import `getSetupStatus` instead of `getInstallationState`. The gate
  no longer handles `null` (the use case absorbs it), but DB errors still propagate to the catch
  block for the fail-closed redirect (R-SETUP-004).
- **`GET /api/v1/setup/status` route handler.** Thin: calls the use case, wraps the result in the
  success envelope `{ "data": ... }`. No request body to validate (GET).
- **Setup routes file** `http/routes/setup.ts` — a Hono sub-app for `/api/v1/setup/*` endpoints.
  The router mounts it at `/api/v1/setup`.
- **Worker-pool tests** proving every behaviour against a real D1 binding.

## Out of scope

- **`POST /api/v1/setup/claim`** — CAP-008.
- **`POST /api/v1/setup/preflight`** — CAP-009.
- **Seeding the `installation_state` row.** No write operations in this capability.
- **Authentication / setup session.** The status endpoint is public (it must be reachable before
  the operator claims the installation token).
- **Caching the status read.** Per-request D1 hit is correct for Phase 0.
- **Cursor pagination, idempotency, authorization.** This is a read-only public GET.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-SETUP-002` | A fresh DB (no `installation_state` row) is treated as `status = 'setup'` — the endpoint returns `currentStep: 'claim'`. |
| `R-SETUP-003` | The setup gate does not block `/api/v1/setup/status` (already exempted in CAP-006). |

No new business rules. The default-on-fresh-DB behaviour is the same invariant as CAP-006's
setup-gate, now exposed via an API endpoint.

## Acceptance criteria

Objectively checkable. Each maps to a worker-pool test unless noted.

- [ ] 1. Fresh DB (no `installation_state` row): `GET /api/v1/setup/status` returns 200 with body `{"data":{"status":"setup","currentStep":"claim"}}`.
- [ ] 2. `installation_state` row with `status='setup', current_step='claim'`: returns 200 with `{"data":{"status":"setup","currentStep":"claim"}}`.
- [ ] 3. `installation_state` row with `status='setup', current_step='domain'`: returns 200 with `{"data":{"status":"setup","currentStep":"domain"}}`.
- [ ] 4. `installation_state` row with `status='complete', current_step='complete'`: returns 200 with `{"data":{"status":"complete","currentStep":"complete"}}`.
- [ ] 5. The response `Content-Type` is `application/json`.
- [ ] 6. The endpoint is reachable through the setup gate (not 302'd) on both fresh and seeded DBs.
- [ ] 7. The success envelope shape is `{ "data": T }` (architecture rule §API conventions).
- [ ] 8. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 9. `pnpm scaffold doctor` exits 0 (10/10 checks pass).

## Vertical slice

Layers this touches, in dependency order:

- [ ] use case — `apps/worker/src/modules/onboarding/setup-status.ts` (new, private file)
- [ ] module public API — `apps/worker/src/modules/onboarding/index.ts` — export `getSetupStatus`, stop exporting `getInstallationState`
- [ ] gate update — `apps/worker/src/http/middleware/setup-gate.ts` — import `getSetupStatus`
- [ ] route handler — `apps/worker/src/http/routes/setup.ts` (new)
- [ ] route wiring — `apps/worker/src/http/router.ts` — mount `setupRoutes()` at `/api/v1/setup`
- [ ] tests — `apps/worker/src/http/routes/setup-status.worker.test.ts` (new)

No new module dependency edges. The HTTP layer imports from `modules/onboarding` via its `index.ts`
— the same direction as CAP-006.

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| implementer | `apps/worker/src/modules/onboarding/setup-status.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/http/middleware/setup-gate.ts` |
| implementer | `apps/worker/src/http/routes/setup.ts` (new) |
| implementer | `apps/worker/src/http/router.ts` |
| implementer | `apps/worker/src/http/routes/setup-status.worker.test.ts` (new) |

## Reading list

Read exactly these — not the whole `docs/` tree:

- `CLAUDE.md` (the Claude Code entry point)
- this file (`work/active/CAP-007-setup-status/task.md`)
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md` — especially §Dependency direction, §API conventions (response envelope, status codes), §Forbidden
- `.claude/rules/coding.md` — §Structure (route handler pattern), §Naming
- `.claude/rules/testing.md` — §Mocking, §Determinism, §Quality gates
- `docs/rebuild/05-target-architecture/api-design.md` lines 105-121 (setup routes), lines 48-53 (success envelope)
- Existing code to match idiom:
  - `apps/worker/src/http/router.ts` (where to mount the sub-app)
  - `apps/worker/src/http/middleware/setup-gate.ts` (current consumer of `getInstallationState`)
  - `apps/worker/src/modules/onboarding/index.ts` (current public API)
  - `apps/worker/src/modules/onboarding/installation-state-repository.ts` (repository — stays private)
  - `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (worker-pool test pattern, `{ redirect: 'manual' }` note, seed helpers)
  - `apps/worker/src/http/router.worker.test.ts` (SELF.fetch pattern)
  - `apps/worker/src/platform/env.ts` (Env type)
  - `apps/worker/src/platform/database.ts` (Database = D1Database)
  - `packages/contracts/src/index.ts` (InstallationStateInfo type, zod schemas)
  - `migrations/0001_initial.sql` lines 52-65 (installation_state DDL)

## Dependencies

- Requires: CAP-006 (setup gate, onboarding repository) — Implemented
- Blocks: CAP-008 (`POST /setup/claim`), CAP-009 (`POST /setup/preflight`)

## Design guidance

### `getSetupStatus` use case

```typescript
// modules/onboarding/setup-status.ts (private file, exported through index.ts)
import type { Database } from '../../platform/database';
import type { InstallationStateInfo } from '@unimailbox/contracts';
import { getInstallationState } from './installation-state-repository';

/**
 * Returns the installation state. On a fresh DB (no row), defaults to
 * { status: 'setup', currentStep: 'claim' } — the first setup-wizard step.
 *
 * DB errors propagate to the caller (the setup gate catches them for
 * fail-closed behaviour, R-SETUP-004).
 */
export async function getSetupStatus(
  db: Database,
): Promise<InstallationStateInfo> {
  const state = await getInstallationState(db);
  if (!state) {
    return { status: 'setup', currentStep: 'claim' };
  }
  return state;
}
```

### Module public API

```typescript
// modules/onboarding/index.ts
// modules/onboarding — owner of installation_state, registration_keys.
// Exports: getSetupStatus — the installation-state use case.
// The repository (getInstallationState) is private (D-CAP-006-C).
export { getSetupStatus } from './setup-status';
```

### Setup-gate update

The gate switches from `getInstallationState` to `getSetupStatus`. Behaviour is identical:
`getSetupStatus` returns `{ status: 'setup', currentStep: 'claim' }` for a fresh DB instead of
`null`, so the `!state` check is removed — `getSetupStatus` never returns null. The DB-error catch
block stays (errors propagate from the use case).

```typescript
// setup-gate.ts — changed lines
import { getSetupStatus } from '../../modules/onboarding';

// ...
let state: InstallationStateInfo;
try {
  state = await getSetupStatus(c.env.DB);
} catch (err) {
  // R-SETUP-004: fail-closed — same as before.
  // ...
}
if (state.status !== 'complete') {
  return c.redirect('/setup', 302);
}
```

### Setup routes sub-app

```typescript
// http/routes/setup.ts
import { Hono } from 'hono';
import { getSetupStatus } from '../../modules/onboarding';
import type { AppEnv } from '../../platform/env';

export function setupRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/status', async (c) => {
    const status = await getSetupStatus(c.env.DB);
    return c.json({ data: status });
  });

  return routes;
}
```

### Router wiring

```typescript
// router.ts — add after /healthz
router.route('/api/v1/setup', setupRoutes());
```

### Test approach

Worker-pool test file: `apps/worker/src/http/routes/setup-status.worker.test.ts`.

Use `SELF.fetch('http://localhost/api/v1/setup/status')` to exercise the full pipeline. Seed the D1
directly with raw SQL (same pattern as `setup-gate.worker.test.ts`). Use `reset()` + `migrationsDb()`
in `beforeEach`, then optionally seed a row.

Test matrix:

| Scenario | Installation state | Expected status | Expected body |
|---|---|---|---|
| Fresh DB | (no row) | 200 | `{"data":{"status":"setup","currentStep":"claim"}}` |
| Setup / claim | `status='setup', current_step='claim'` | 200 | `{"data":{"status":"setup","currentStep":"claim"}}` |
| Setup / domain | `status='setup', current_step='domain'` | 200 | `{"data":{"status":"setup","currentStep":"domain"}}` |
| Complete | `status='complete', current_step='complete'` | 200 | `{"data":{"status":"complete","currentStep":"complete"}}` |

Additional checks:
- `Content-Type` header is `application/json`.
- Use `FIXED_TIMESTAMP` constant (determinism rule).
- The endpoint is NOT 302'd by the setup gate (exempt path).

## Decisions made during this capability

1. **`getSetupStatus` absorbs the null case.** The repository returns `null` for a fresh DB; the use
   case returns the default `{ status: 'setup', currentStep: 'claim' }`. This means callers never
   handle null — the gate and the route handler both get a guaranteed `InstallationStateInfo`.

2. **Setup routes sub-app (`http/routes/setup.ts`).** A Hono sub-app for `/api/v1/setup/*` endpoints.
   CAP-008 (claim) and CAP-009 (preflight) will add routes to the same file. The router mounts it at
   `/api/v1/setup`.

3. **Response shape is `{ "data": InstallationStateInfo }`.** Returns both `status` and
   `currentStep`. The acceptance criterion mentions only `currentStep`, but the React client needs
   `status` to know whether to redirect away from `/setup` when installation is complete. The extra
   field does not break the criterion.

## Open questions

(None.)
