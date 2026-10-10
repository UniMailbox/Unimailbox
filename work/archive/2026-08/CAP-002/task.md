# CAP-002 — Test harness (unit + worker pool)

**Phase:** 0 · **Status:** In Progress · **Started:** 2026-08-12

## Goal

`pnpm test:unit` runs vitest across every workspace package's pure code (domain logic, state machines, pure functions, `email-core`) against the platform primitives with deterministic fake clocks and ID generators; `pnpm test:worker` runs vitest against real Cloudflare bindings (D1, R2, KV, Queue) via `@cloudflare/vitest-pool-workers`; and `packages/test-kit` exposes the shared fixtures and helpers every later capability's tests will use.

## Scope

- **Vitest workspace config** at the repo root (`vitest.workspace.ts`) covering all six testable workspace members:
  - `apps/worker` — runs both unit and worker-pool tests (worker-pool requires the `SELF` env)
  - `packages/contracts` — unit only
  - `packages/email-core` — unit only
  - `packages/config` — unit only
  - `packages/test-kit` — unit only (no self-tests; the package is helpers)
  - `apps/web` — unit tests for non-component utilities only (component tests deferred until a feature page lands in CAP-006+)
- **`@cloudflare/vitest-pool-workers` configuration** for `apps/worker`:
  - `vitest.config.ts` extended to support both `node` (for pure primitives) and `workers` (for binding-backed tests) environments
  - `wrangler.jsonc` already provides 7 bindings; `defineWorkersConfig` reads it via `poolOptions.workers.wrangler.configPath`
  - **Bump `@cloudflare/vitest-pool-workers` to ≥ 0.21.x** to resolve the deferred peer mismatch (`vitest@4.x` compatibility). D-CAP-001-A.
- **`packages/test-kit` real exports**:
  - `fakeClock(initial: Date)` — `Clock` implementation that returns the seeded time and advances on `.advance(ms)`
  - `fixedIds(...values: string[])` — `IdGenerator` that returns the next value from the list, then throws on exhaustion
  - `fixtures.user({ ... })` — builder for a `User` row-shape used by identity tests
  - `fixtures.installationState({ ... })` — builder for an `installation_state` row-shape (placeholder fields — full row shape lands in CAP-004)
  - `stubOutboundAdapter()` — `OutboundProviderAdapter` that records sends without making HTTP
  - `stubFetch()` — fetch replacement that returns canned responses per-URL
- **Demonstrative unit tests** that prove the harness works:
  - `apps/worker/src/platform/clock.test.ts` — fakeClock determinism + advance()
  - `apps/worker/src/platform/ids.test.ts` — fixedIds sequence + exhaustion throw
  - `apps/worker/src/platform/crypto.test.ts` — round-trip via the platform crypto stub (full PBKDF2 verification lands with CAP-010; CAP-002 only proves the harness)
  - `apps/worker/src/platform/errors.test.ts` — `DomainError.code` is stable, `.cause` round-trips, `.toJSON` produces the canonical envelope shape `{ code, message }`
  - `packages/email-core/src/index.test.ts` — at least one pure-function test (the package's `index.ts` currently has a placeholder; the implementer should add one trivial pure function so the test has something to verify)
  - `packages/contracts/src/index.test.ts` — round-trip a sample zod schema (parse → safeParse → fail with stable error shape)
- **Demonstrative worker-pool tests**:
  - `apps/worker/src/platform/database.test.ts` — `db.prepare('SELECT 1 AS n').first()` returns `{ n: 1 }` against the real D1 binding
  - `apps/worker/src/platform/cache.test.ts` — `cache.put/get` against the real `CACHE` KV binding
  - `apps/worker/src/http/router.test.ts` — `app.fetch(new Request('http://x/healthz'))` returns 200 with `{ok:true,surface:'router'}` (the existing handler, run through the pool)
  - `apps/worker/src/entrypoints/inbound-email.test.ts` — invoking the stub handler with a synthetic `Message` produces `setReject` (verifies the stub is inert and observable)
- **Vitest setup file** for worker-pool tests that:
  - Disables any console output the pool would otherwise leak
  - Sets `process.env.ENVIRONMENT = 'local'` so `platform/config.ts` narrows to the `'local'` branch
- **Coverage threshold** (informational, not gating): set `coverage.thresholds.lines = 70` for `apps/worker/src/platform/**` and `packages/email-core/**`. Real coverage reporting lands with the first feature capability.
- **Root `package.json` scripts updated**:
  - `pnpm test` → runs both unit and worker in sequence (no `wrangler deploy` anywhere — the legacy process defect this rule exists to prevent)
  - `pnpm test:unit` → `vitest run --project unit` (vitest workspace project)
  - `pnpm test:worker` → `vitest run --project workers` (vitest workspace project, requires pool)
  - `pnpm test:watch` → `vitest --watch`
- **`@cloudflare/vitest-pool-workers` version bumped** to ≥ 0.21.x; `vitest` stays at 4.x; per-package `package.json` `devDependencies` updated.

## Out of scope

- Real tests for business rules. (Every R-* test belongs to the capability that implements the rule.)
- The setup-state-machine tests. (CAP-008 — the harness will be in place for it.)
- The Brevo/Resend/CF-Sendmail adapter tests. (Phase 1.)
- Migration verify tests. (CAP-004 ships the first migration; verify runs per migration.)
- UI component tests in `apps/web/`. (CAP-006+ — needs a real component to test.)
- Coverage thresholds for `apps/web/`, `modules/*`, `integrations/*`. (Deferred.)
- CI workflow. (Not in any Phase 0 capability.)
- A live HTTP smoke test against a deployed preview. (CAP-005.)

## Business rules

No business rules are *implemented* by CAP-002. The capability's job is to enforce the testing rules from `.claude/rules/testing.md` so that every later capability's tests are produced under them.

| Rule (from `.claude/rules/testing.md`) | What CAP-002 must enable |
|---|---|
| "Never mock D1, R2, KV, or Queue." | Worker-pool config binds against `wrangler.jsonc`; tests import `env` from `cloudflare:test` and use it directly. |
| "Do mock outbound provider HTTP." | `stubOutboundAdapter()` returns a recorder adapter; tests assert on the recorded calls. |
| "Fixtures and builders live in `packages/test-kit/`." | The package exports builders; the contract forbids copy-pasting fixtures. |
| "Domain code takes `Clock` and `ids` from `platform/` precisely so tests can inject fixed values." | `fakeClock` and `fixedIds` are part of `test-kit`; the platform interfaces they implement are stable. |
| "Never wire a deploy into a test script." | `pnpm test` is a pure vitest invocation. No `wrangler deploy` anywhere. |
| "Report test results exactly as they happened." | Vitest's default reporter does this; no custom masking. |

## Acceptance criteria

- [ ] 1. `pnpm install` succeeds with **no peer-dep warnings** about `vitest` vs `@cloudflare/vitest-pool-workers`. (Resolves D-CAP-001-A.)
- [ ] 2. `pnpm typecheck` exits 0.
- [ ] 3. `pnpm lint` exits 0.
- [ ] 4. `pnpm test:unit` exits 0 and reports at least 6 passing tests (one per demonstrative file above).
- [ ] 5. `pnpm test:worker` exits 0 and reports at least 4 passing tests against real Cloudflare bindings (one per demonstrative worker test above).
- [ ] 6. `pnpm test` runs unit and worker in sequence; total runtime under 60 seconds on a clean run.
- [ ] 7. `grep -rE 'sleep|setTimeout.*[0-9]{3,}' apps packages --include='*.test.ts'` returns no matches (no `sleep` in tests).
- [ ] 8. `grep -rE 'Date\.now\(\)|crypto\.randomUUID\(\)' apps packages --include='*.test.ts'` returns no matches in test files (tests must inject).
- [ ] 9. `grep -rE 'jest\.fn|vi\.fn.*mocks.*D1|mocks.*R2|mocks.*KV|mocks.*Queue' apps packages --include='*.test.ts'` returns no matches (no mocking of D1/R2/KV/Queue).
- [ ] 10. `pnpm exec vitest --project unit run --coverage --coverage.provider=v8` exits 0 and reports ≥ 70% lines covered in `apps/worker/src/platform/**` and `packages/email-core/**`. (Workers-pool coverage deferred — `@vitest/coverage-v8` is incompatible with workerd; see D-CAP-002-A.)
- [ ] 11. `packages/test-kit` exports are typed and importable from every workspace package **except `packages/contracts`** (which would cycle because `test-kit` depends on `contracts`).
- [ ] 12. Existing tests from CAP-001 (the `echo ... && exit 0` placeholders) are gone — `pnpm test:unit` actually invokes vitest.

## Vertical slice

Layers this touches, in dependency order:

- [x] root config — `vitest.workspace.ts`, root `package.json` scripts
- [x] apps/worker test config — `apps/worker/vitest.config.ts` extended with project mix
- [x] apps/worker tests — `apps/worker/src/platform/{clock,ids,crypto,errors,database,cache}.test.ts`, `apps/worker/src/http/router.test.ts`, `apps/worker/src/entrypoints/inbound-email.test.ts`
- [x] apps/worker setup — `apps/worker/test/setup.ts` (or per-file setup where vitest supports it)
- [x] packages/test-kit — `packages/test-kit/src/{clock,ids,fixtures,stubs,index}.ts` + tests
- [x] packages/email-core test — `packages/email-core/src/index.test.ts` (adds one trivial pure function first)
- [x] packages/contracts test — `packages/contracts/src/index.test.ts`

New module dependency edges introduced: none outside what CAP-001 already permitted. Tests live next to the code they test (`*.test.ts` co-located). `test-kit` is a regular package dependency; nothing reads its internals except through its `index.ts`.

## File ownership

One writer for this capability.

| Agent | Owns |
|---|---|
| implementer-1 | Everything in Scope, top to bottom. |

If the slice turns out to need splitting, the orchestrator splits before delegation. This is single-implementer by default.

## Reading list

Exactly what the implementer reads:

- `CLAUDE.md` — entry point
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/coding.md` (TS strict, no `any`, naming)
- `.claude/rules/testing.md` (every "must test" rule, mocking rules, determinism rules)
- `.claude/rules/architecture.md` (test-kit is a regular package, follows the public-surface rule)
- `.claude/rules/security.md` §Logging (tests must not log secrets/tokens/bodies — but tests don't log at all here)
- `work/active/CAP-001-monorepo-scaffold/task.md` (the prior contract — re-read to understand what platform/* looks like)
- `apps/worker/wrangler.jsonc` (what bindings the pool will use)
- `apps/worker/vitest.config.ts` (current stub to be extended)
- `packages/test-kit/src/index.ts` (current placeholder to be replaced)
- `packages/email-core/src/index.ts` (the placeholder to extend with a pure function so it has something to test)
- `packages/contracts/src/index.ts` (existing zod schemas to round-trip in the test)
- `@cloudflare/vitest-pool-workers` docs as needed (the implementer may consult official docs via WebFetch; report any pinning decisions in the handoff)
- `docs/rebuild/02-business-discovery/business-rules.md` (skim — no `R-*` rules implemented by CAP-002, but the test naming convention requires `R-*` IDs eventually)

## Dependencies

- Requires: CAP-001 (Implemented — provides the workspace, the platform primitives, the wrangler config)
- Blocks: every capability from CAP-003 onwards that needs to demonstrate a business rule with a test

## Decisions made during this capability

Open decisions to resolve before or during implementation. The implementer proposes; the orchestrator decides.

| Decision | Options | Default if no answer |
|---|---|---|
| Vitest workspace layout | single `vitest.workspace.ts` at root + per-project `vitest.config.ts` (vs single root config) | workspace file + per-project configs |
| Pool mixing per package | `apps/worker` has both `unit` and `workers` projects; `packages/*` have `unit` only | per-project configs in `apps/worker/vitest.config.ts` |
| `@cloudflare/vitest-pool-workers` version | 0.21.x (current), 0.22.x (newer), 0.30.x (newest stable) | latest stable ≥ 0.21.x that pairs with `vitest@4.x` |
| `coverage` provider | `v8` vs `istanbul` | `v8` (default in vitest 4; faster) |
| Test naming convention | `*.test.ts` (co-located) vs `test/**/*.test.ts` (separate) | co-located `*.test.ts` next to the file under test |
| Coverage thresholds | gate now vs record-only | record-only for the first capability; gating starts when a feature capability demands it |

### Deferred decisions (logged during CAP-002 review-fix pass)

| ID | Decision | Outcome |
|---|---|---|
| **D-CAP-002-A** | Worker-pool v8 coverage is incompatible with workerd (`@vitest/coverage-v8` imports `node:inspector/promises`, which workerd does not provide). | **Deferred.** Coverage is measured against the `unit` project only (criterion #10). The first capability that needs workers-pool coverage will switch to `@vitest/coverage-istanbul` or move the coverage measurement to the unit project. |
| **D-CAP-002-B** | `packages/test-kit` depends on `@unimailbox/contracts`. Importing `test-kit` from `contracts` would cycle. | **Deferred.** Criterion #11 excludes `packages/contracts` with the cycle recorded as the reason. If a future capability needs a contract test that uses `test-kit` helpers, the helper is moved to packages/contracts/src/test-helpers and re-exported via `test-kit`. |
| **D-CAP-002-C** | `UserRowShape` no longer carries `passwordHash` (the previous `$`-delimited string violated ADR-006). | **Deferred.** The four-column shape `passwordAlgorithm` / `passwordIterations` / `passwordSalt` / `passwordHash` lands with CAP-004 (identity). |

## Open questions

Blockers needing the operator.

1. Are we OK with the worker-pool tests running against `wrangler.jsonc` with placeholder IDs? `wrangler dev --test-mode` uses an in-memory simulator for the local pool, so placeholder IDs do not matter — but the implementer should confirm against the pool's actual behaviour.
2. Should `pnpm test` be the canonical gate (matches `.claude/rules/testing.md` §Quality gates) or should `pnpm test:unit && pnpm test:worker` remain the explicit gate? Default: `pnpm test` runs both in sequence, and the explicit forms remain available for selective runs.