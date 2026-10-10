# CAP-006 — Setup gate: `GET /` → 302 `/setup` while `installation_state.status != 'complete'`

**Phase:** 0 · **Status:** In Progress · **Started:** 2026-08-12

## Goal

While the system is not yet installed (`installation_state.status !== 'complete'` or the row is absent), every non-setup HTTP route 302-redirects to `/setup`. This is the gate that forces the operator through the setup wizard before any other route is reachable.

## Scope

- **Onboarding module — installation-state reader.** A repository function that reads the single `installation_state` row (id = 1) and returns its `status` + `currentStep`, or `null` when the row does not exist (fresh DB).
- **Setup-gate middleware.** A Hono middleware that:
  - Exempts `/healthz`, `/setup`, and `/api/v1/setup/*` paths.
  - Reads installation state from D1 on every request.
  - If `status !== 'complete'` (including when the row is absent), returns `302` with `Location: /setup`.
  - Otherwise calls `next()`.
- **Router wiring.** Mount the middleware in `buildRouter()` so it runs after `requestId` and before route handlers.
- **Cross-boundary contract type.** `InstallationStateInfo` in `packages/contracts`.
- **Worker-pool tests** proving every gate behaviour against a real D1 binding.

## Out of scope

- **Seeding the `installation_state` row.** The row is absent on a fresh DB and the gate treats that as "not complete." CAP-007 (`GET /setup/status`) owns seeding the initial row with `status='setup', current_step='claim'`.
- **`/setup/status`, `/setup/claim`, `/setup/preflight` endpoints.** Those are CAP-007, CAP-008, CAP-009.
- **Caching the installation-state read.** Per-request D1 hit is correct for Phase 0. Optimization is a later concern.
- **Serving the React app at `GET /`.** That is CAP-016. When installation is complete, `GET /` falls through to the normal router (404 for now).
- **API-specific gate behaviour** (e.g. returning 503 instead of 302 for API routes). Phase 0 has no non-setup API routes, so every non-exempt route getting 302 is correct. A future capability can refine this if needed.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-SETUP-001` | While `installation_state.status !== 'complete'`, every non-`/setup` route returns 302 to `/setup`. Source: `.claude/rules/architecture.md` §API conventions. |
| `R-SETUP-002` | A fresh DB (no `installation_state` row) is treated as `status = 'setup'` — the gate redirects. |
| `R-SETUP-003` | `/healthz` is always reachable regardless of installation state (health checks must not be gated). |

> Note: `R-SETUP-*` IDs are allocated here for this capability's invariants. They do not yet appear in `docs/rebuild/02-business-discovery/business-rules.md` because the setup-gate rule is stated in `.claude/rules/architecture.md` §API conventions. If the implementer identifies a need to formalise these in the business-rules doc, flag it as a proposal.

## Acceptance criteria

Objectively checkable. Each maps to a worker-pool test.

- [ ] 1. Fresh DB (no `installation_state` row): `GET /` returns 302 with `Location: /setup`.
- [ ] 2. `installation_state.status = 'setup'`: `GET /` returns 302 with `Location: /setup`.
- [ ] 3. `installation_state.status = 'complete'`: `GET /` does NOT return 302 (falls through to the normal router — 404 is acceptable since there is no `/` handler yet).
- [ ] 4. `/healthz` returns 200 regardless of installation state (both fresh DB and `status='setup'`).
- [ ] 5. `GET /setup` is NOT redirected (exempt path) — returns 404 (no handler yet), not 302.
- [ ] 6. `GET /api/v1/setup/status` is NOT redirected (exempt path) — returns 404, not 302.
- [ ] 7. A non-exempt path under `/api/v1/` (e.g. `/api/v1/messages`) returns 302 when installation is incomplete.
- [ ] 8. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 9. `pnpm scaffold doctor` exits 0 (10/10 checks pass).

## Vertical slice

Layers this touches, in dependency order:

- [x] contract schema — `packages/contracts/src/index.ts` — add `InstallationStateInfo` + `InstallationStep`
- [ ] repository — `apps/worker/src/modules/onboarding/installation-state-repository.ts` (new, private)
- [ ] module public API — `apps/worker/src/modules/onboarding/index.ts` — export `getInstallationState`
- [ ] middleware — `apps/worker/src/http/middleware/setup-gate.ts` (new)
- [ ] route wiring — `apps/worker/src/http/router.ts` — mount the middleware
- [ ] tests — `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (new)

New module dependency edges introduced: **none.** The `onboarding` module already depends on `platform/*` and `contracts/*` per the architecture rules table. The HTTP middleware layer imports from `modules/onboarding` (via its `index.ts`), which is the standard entrypoint → module direction.

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| implementer | `packages/contracts/src/index.ts` (add types only — do not modify existing exports) |
| implementer | `apps/worker/src/modules/onboarding/installation-state-repository.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/http/middleware/setup-gate.ts` (new) |
| implementer | `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (new) |
| implementer | `apps/worker/src/http/router.ts` |

## Reading list

Read exactly these — not the whole `docs/` tree:

- `CLAUDE.md` (the Claude Code entry point)
- this file (`work/active/CAP-006-setup-gate/task.md`)
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md` — especially §Dependency direction, §API conventions (the 302 rule), §Forbidden
- `.claude/rules/coding.md` — §Structure, §Naming, §Errors
- `.claude/rules/testing.md` — §Mocking, §Determinism, §Quality gates
- `docs/rebuild/05-target-architecture/api-design.md` lines 105-121 (setup routes)
- Existing code to match idiom:
  - `apps/worker/src/http/router.ts` (where to mount the middleware)
  - `apps/worker/src/http/middleware/request-id.ts` (middleware pattern)
  - `apps/worker/src/http/middleware/error.ts` (middleware pattern)
  - `apps/worker/src/modules/onboarding/index.ts` (current stub)
  - `apps/worker/src/database/schema/onboarding.ts` (table shape — `installation_state`)
  - `apps/worker/src/platform/env.ts` (Env type, Database alias)
  - `apps/worker/src/platform/database.ts` (Database = D1Database)
  - `apps/worker/src/http/router.worker.test.ts` (worker-pool test pattern using `SELF.fetch`)
  - `packages/test-kit/src/migrationsDb.ts` (how to get a migrated D1 in tests)
  - `packages/test-kit/src/fixtures.ts` (installationState fixture builder)
  - `migrations/0001_initial.sql` lines 52-69 (installation_state DDL)

## Dependencies

- Requires: CAP-004 (initial schema — `installation_state` table exists) — Implemented
- Blocks: CAP-007 (`GET /setup/status`), CAP-008 (`POST /setup/claim`), CAP-009 (`POST /setup/preflight`)

## Design guidance

### Installation-state repository

```typescript
// modules/onboarding/installation-state-repository.ts (private file)
export async function getInstallationState(
  db: D1Database,
): Promise<InstallationStateInfo | null>
```

Query: `SELECT status, current_step FROM installation_state WHERE id = 1`. Return `null` when no row. The `id = 1` constraint is enforced by `CHECK (id = 1)` in the DDL — there is at most one row.

### Contract type

```typescript
// packages/contracts/src/index.ts — add these exports
export type InstallationStep =
  | 'claim' | 'preflight' | 'administrator' | 'domain'
  | 'cloudflare-verify' | 'inbound-smoke' | 'brevo'
  | 'outbound-smoke' | 'complete';

export interface InstallationStateInfo {
  readonly status: 'setup' | 'complete';
  readonly currentStep: InstallationStep;
}
```

These mirror the `status` and `current_step` enums in the DDL but live in contracts for cross-boundary use (architecture rule: Drizzle row types must not cross a module boundary).

### Setup-gate middleware

The middleware receives `AppEnv` bindings. It needs `c.env.DB` to query installation state. Exempt paths:

- `/healthz` — exact match
- `/setup` and `/setup/*` — prefix match (React client routes)
- `/api/v1/setup/*` — prefix match (setup API endpoints)

For all other paths: read installation state. If `null` or `status !== 'complete'`, return `c.redirect('/setup', 302)`. Otherwise `await next()`.

**Important:** Use `c.redirect('/setup', 302)` — Hono's redirect helper. The `Location` header must be `/setup`.

### Test approach

Worker-pool test file: `apps/worker/src/http/middleware/setup-gate.worker.test.ts`.

Use `SELF.fetch('http://localhost/...')` to exercise the full request pipeline (the test goes through the real entrypoint, router, and middleware — same pattern as `router.worker.test.ts`).

For each test, seed the D1 directly with raw SQL (`db.prepare('INSERT INTO installation_state ...').bind(...).run()`). Use `migrationsDb()` from test-kit to get a migrated DB, then insert the row. Use `reset()` from `cloudflare:test` in `beforeEach` to start clean.

Test matrix:
| Scenario | Installation state | Request path | Expected status | Expected Location |
|---|---|---|---|---|
| Fresh DB | (no row) | `GET /` | 302 | `/setup` |
| Setup status | `status='setup'` | `GET /` | 302 | `/setup` |
| Complete status | `status='complete'` | `GET /` | 404 (no handler) | — |
| Healthz (fresh) | (no row) | `GET /healthz` | 200 | — |
| Healthz (setup) | `status='setup'` | `GET /healthz` | 200 | — |
| Setup page exempt | `status='setup'` | `GET /setup` | 404 (no handler) | — |
| Setup API exempt | `status='setup'` | `GET /api/v1/setup/status` | 404 (no handler) | — |
| Non-setup API gated | `status='setup'` | `GET /api/v1/messages` | 302 | `/setup` |

**Wait** — there is a subtlety. The worker-pool test uses `SELF.fetch`, which goes through the real `wrangler.jsonc` bindings. The D1 binding in the test environment starts empty (no migrations applied). The test must apply migrations before seeding. Use `migrationsDb()` which applies `0001_initial.sql` and returns the D1 binding, then seed directly.

But there's another subtlety: `SELF.fetch` uses the test's own D1 binding (from `cloudflare:test`'s `env.DB`), and `migrationsDb()` also uses `env.DB` — they are the same binding. So applying migrations via `migrationsDb()` before `SELF.fetch` ensures the schema is present when the request hits the middleware.

However, `reset()` in `beforeEach` clears D1 data but NOT the `d1_migrations` tracking table — so calling `migrationsDb()` after `reset()` is a no-op for schema (idempotent), and data is cleared. This is the pattern used in `migrationsDb.worker.test.ts`.

## Decisions made during this capability

1. **Fail-closed on DB error (R-SETUP-004).** If `getInstallationState` throws (e.g., table missing, D1 outage), the middleware redirects to `/setup` and logs a `console.warn`. This prevents a broken DB from exposing the app. The structured logger replaces `console.warn` once request-id middleware is real (currently a CAP-001 stub). Logged in implementation log.

2. **`{ redirect: 'manual' }` in worker-pool tests.** `SELF.fetch` follows redirects by default — tests asserting 302 must pass `{ redirect: 'manual' }` to observe the redirect response itself. This is a testing pattern that all future redirect-asserting tests must follow. Logged in implementation log.

3. **Middleware order: `requestId` before `setupGate`.** Infrastructure middleware runs first, then gates, then routes. The implementer initially reversed this; corrected during orchestrator integration.

4. **Zod schemas for installation state types.** Contracts exports `installationStepSchema` and `installationStateInfoSchema` (zod), not just types. The repository uses `.parse()` instead of `as` casts. Aligns with existing `emailAddressSchema`/`uuidSchema` convention and satisfies the doctor's `tests-cover-contracts` check.

5. **`Database` type alias from `platform/database.ts`.** The repository takes `Database` (which is `type Database = D1Database`), not the raw `D1Database` type. This sets the convention for all future repositories.

## Open questions

(None.)
