// apps/worker/src/database/schema-version.ts — CAP-021 sentinel.
// The constant the doctor `schema-version` check compares the highest
// migration filename against. Bump this when a new migration lands.
// Hand-written; intentionally not auto-generated.
// 0018 closes the audit.read upgrade gap for existing administrator roles.
// 0019 closes the role_policies JSON normalization gap (CAP-036).
// 0020 raises the idempotency_records.response_json CHECK to 524,288
// (CAP-047 PATCH slice) so the GET-compatible PATCH replay body fits.
// 0021 adds attachment_uploads metadata for temporary CACHE KV staging.
// 0022 adds message_attachments consumed-relation rows for CAP-050
// (one-consume-per-upload via UNIQUE index + BEFORE INSERT trigger).
// 0023 moves message stars onto per-user message_user_state rows (CAP-058).
// 0024 adds one sanitized signature per managed domain (CAP-068).
// 0026 adds admin-managed password lifecycle columns for CAP-A1.
// 0027 stores verified, provider-neutral webhook projections for replay.
// 0028 stores received MIME attachment metadata separately from uploads.
export const CURRENT_SCHEMA_VERSION = '0038' as const;
