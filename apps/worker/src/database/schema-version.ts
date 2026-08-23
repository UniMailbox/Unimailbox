// apps/worker/src/database/schema-version.ts — CAP-021 sentinel.
// The constant the doctor `schema-version` check compares the highest
// migration filename against. Bump this when a new migration lands.
// Hand-written; intentionally not auto-generated.
// CAP-043 Slice 1 fix pass: bumped from '0016' to '0017' after
// migrations/0017_message_user_state_composite_pk.sql (D-CAP-043-F).
export const CURRENT_SCHEMA_VERSION = '0017' as const;
