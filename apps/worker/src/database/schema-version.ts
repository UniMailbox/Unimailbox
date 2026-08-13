// apps/worker/src/database/schema-version.ts — CAP-004 sentinel.
// The constant the doctor `schema-version` check compares the highest
// migration filename against. Bump this when a new migration lands (the
// next capability, e.g. CAP-006, will set it to '0002' once 0002_*.sql
// lands). Hand-written; intentionally not auto-generated.
export const CURRENT_SCHEMA_VERSION = '0002' as const;