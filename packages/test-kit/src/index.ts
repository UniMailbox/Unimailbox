/**
 * @unimailbox/test-kit
 *
 * Shared test fixtures, helpers, and stubs. Single public entry point.
 *
 * Exports:
 *   fakeClock(initial)               — deterministic Clock for domain code
 *   fixedIds(...values)              — deterministic IdGenerator
 *   fixtures.user({...})             — User row builder
 *   fixtures.userRole({...})         — user_roles row builder (admin lives here, not on user)
 *   fixtures.installationState({...}) — installation_state row builder
 *   stubOutboundAdapter()            — recorder OutboundProviderAdapter
 *   stubFetch()                      — canned-response fetch replacement
 *   migrationsDb()                   — D1 binding with 0001_initial.sql applied
 *                                     (worker-pool only)
 *   resetAndMigrate()                — reset + apply migrations (worker-pool only)
 *   seedInstallationState({...})     — insert the installation_state row (worker-pool only)
 *   FIXED_TIMESTAMP                  — '2026-01-01 00:00:00' for deterministic seeds
 *
 * What this package must NOT do:
 *   - Import from `apps/worker` (would create a cycle through the harness).
 *   - Mock D1/R2/KV/Queue (per .claude/rules/testing.md §Mocking).
 *   - Call `Date.now()` / `crypto.randomUUID()` (determinism rule).
 *
 * The package depends only on `@unimailbox/contracts` for shared types.
 */
export { fakeClock, type FakeClock } from './clock';
export { fixedIds, type FixedIdGenerator } from './ids';
export {
  fixtures,
  user,
  userRole,
  installationState,
  type UserRowShape,
  type UserRoleRowShape,
  type InstallationStateRowShape,
  type FixtureOverrides,
} from './fixtures';
export {
  stubOutboundAdapter,
  stubFetch,
  type StubOutboundAdapter,
  type RecordedSend,
  type StubFetch,
  type FetchHandler,
} from './stubs';
export { migrationsDb } from './migrationsDb';
export { seedInboundMailbox, INBOUND_RAW_FIXTURE } from './inbound';
export {
  FIXED_TIMESTAMP,
  resetAndMigrate,
  seedInstallationState,
  type SeedInstallationStateOptions,
} from './seed';
