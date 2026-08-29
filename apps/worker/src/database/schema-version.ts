// apps/worker/src/database/schema-version.ts — CAP-021 sentinel.
// The constant the doctor `schema-version` check compares the highest
// migration filename against. Bump this when a new migration lands.
// Hand-written; intentionally not auto-generated.
// 0018 closes the audit.read upgrade gap for existing administrator roles.
// 0019 closes the role_policies JSON normalization gap (CAP-036).
// 0020 raises the idempotency_records.response_json CHECK to 524,288
// (CAP-047 PATCH slice) so the GET-compatible PATCH replay body fits.
// 0021 adds attachment_uploads metadata for temporary CACHE KV staging.
export const CURRENT_SCHEMA_VERSION = '0021' as const;
