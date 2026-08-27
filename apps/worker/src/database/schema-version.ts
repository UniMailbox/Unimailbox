// apps/worker/src/database/schema-version.ts — CAP-021 sentinel.
// The constant the doctor `schema-version` check compares the highest
// migration filename against. Bump this when a new migration lands.
// Hand-written; intentionally not auto-generated.
// 0018 closes the audit.read upgrade gap for existing administrator roles.
export const CURRENT_SCHEMA_VERSION = '0018' as const;
