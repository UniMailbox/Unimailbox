// apps/worker/src/database/schema/index.ts — single public surface for
// the Phase 0 Drizzle schemas. Per .claude/rules/architecture.md §Shape
// a module's index.ts is its entire public API; everything else is private.
//
// Repositories that import these tables live in their owning module
// (CAP-019 identity, CAP-006 onboarding, etc.). The Drizzle declarations
// are typing only — the SQL in migrations/ is the deployable artifact.
export * from './identity';
export * from './onboarding';
export * from './admin';
export * from './outbound-mail';