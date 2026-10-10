// Shared stable machine codes. Display text belongs to the client locale catalog.
export const ERROR_CODES = {
  // Auth (401 / 403)
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  USER_BANNED: 'USER_BANNED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  REFRESH_TOKEN_REQUIRED: 'REFRESH_TOKEN_REQUIRED',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',
  INVALID_JSON: 'INVALID_JSON',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  // CAP-042 (AC 14): cookie and bearer principals both resolved but
  // disagreed. 401 with a stable code; never logs the credential
  // material (R-SECRET-003). The cataloguing here is the R-API-002
  // extension point — adding a code requires editing this object so
  // the next conflict path lands at the same code.
  CONFLICTING_PRINCIPALS: 'CONFLICTING_PRINCIPALS',

  // Idempotency (400 / 409)
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_REQUEST_PENDING: 'IDEMPOTENCY_REQUEST_PENDING',

  // Concurrency / optimistic locking (400 / 412) — CAP-047 draft PATCH slice.
  // `If-Match` carries the RFC-3339 `updated_at` returned by GET; the route
  // rejects missing / malformed / weak / quoted / non-canonical headers
  // with `IF_MATCH_INVALID` (400), and a header that no longer matches the
  // stored value with `STALE_IF_MATCH` (412).
  IF_MATCH_REQUIRED: 'IF_MATCH_REQUIRED',
  IF_MATCH_INVALID: 'IF_MATCH_INVALID',
  STALE_IF_MATCH: 'STALE_IF_MATCH',

  // Resource resolution (404 / 409)
  DOMAIN_NOT_FOUND: 'DOMAIN_NOT_FOUND',
  DOMAIN_NOT_ACTIVE: 'DOMAIN_NOT_ACTIVE',
  DOMAIN_NAME_TAKEN: 'DOMAIN_NAME_TAKEN',
  DOMAIN_ADDRESS_TAKEN: 'DOMAIN_ADDRESS_TAKEN',
  DOMAIN_ALREADY_MANAGED: 'DOMAIN_ALREADY_MANAGED',
  DOMAIN_IN_USE: 'DOMAIN_IN_USE',
  MAILBOX_NOT_FOUND: 'MAILBOX_NOT_FOUND',
  MAILBOX_MEMBER_USER_NOT_FOUND: 'MAILBOX_MEMBER_USER_NOT_FOUND',
  MAILBOX_MEMBER_DUPLICATE: 'MAILBOX_MEMBER_DUPLICATE',
  MAILBOX_OWNER_CANNOT_BE_MEMBER: 'MAILBOX_OWNER_CANNOT_BE_MEMBER',
  MAILBOX_MEMBER_NOT_FOUND: 'MAILBOX_MEMBER_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  INVALID_SCHEDULE_TIME: 'INVALID_SCHEDULE_TIME',
  SCHEDULE_STATE_CONFLICT: 'SCHEDULE_STATE_CONFLICT',
  // CAP-043 Slice 1 / R-API-005: the cursor HMAC returned a tampered or
  // malformed payload (or the route layer received a signature mismatch).
  // 400 with the stable code; clients should refetch from the start.
  INVALID_CURSOR: 'INVALID_CURSOR',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  ROLE_NAME_TAKEN: 'ROLE_NAME_TAKEN',
  ROLE_PERMISSION_NOT_FOUND: 'ROLE_PERMISSION_NOT_FOUND',
  SYSTEM_ROLE_PROTECTED: 'SYSTEM_ROLE_PROTECTED',
  ROLE_IN_USE: 'ROLE_IN_USE',
  // CAP-068 domain-signature administration.
  SIGNATURE_NOT_FOUND: 'SIGNATURE_NOT_FOUND',
  SIGNATURE_ALREADY_EXISTS: 'SIGNATURE_ALREADY_EXISTS',
  BLOCKLIST_ENTRY_NOT_FOUND: 'BLOCKLIST_ENTRY_NOT_FOUND',
  PROVIDER_CONNECTION_NOT_FOUND: 'PROVIDER_CONNECTION_NOT_FOUND',
  PROVIDER_CONNECTION_NOT_ACTIVE: 'PROVIDER_CONNECTION_NOT_ACTIVE',
  WEBHOOK_CONNECTION_NOT_FOUND: 'WEBHOOK_CONNECTION_NOT_FOUND',
  WEBHOOK_NOT_CONFIGURED: 'WEBHOOK_NOT_CONFIGURED',
  WEBHOOK_SIGNATURE_MISSING: 'WEBHOOK_SIGNATURE_MISSING',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  REGISTRATION_CODE_INVALID: 'REGISTRATION_CODE_INVALID',
  REGISTRATION_CODE_EXPIRED: 'REGISTRATION_CODE_EXPIRED',
  REGISTRATION_CODE_REVOKED: 'REGISTRATION_CODE_REVOKED',
  REGISTRATION_CODE_EXHAUSTED: 'REGISTRATION_CODE_EXHAUSTED',
  USER_EMAIL_TAKEN: 'USER_EMAIL_TAKEN',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  REGISTRATION_DISABLED: 'REGISTRATION_DISABLED',
  INITIAL_PASSWORD_EXPIRED: 'INITIAL_PASSWORD_EXPIRED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',

  // Setup (400 / 409)
  SETUP_ALREADY_COMPLETE: 'SETUP_ALREADY_COMPLETE',
  SETUP_ADMINISTRATOR_EXISTS: 'SETUP_ADMINISTRATOR_EXISTS',
  SETUP_ADMINISTRATOR_REQUIRED: 'SETUP_ADMINISTRATOR_REQUIRED',
  SETUP_BREVO_ALREADY_CONFIGURED: 'SETUP_BREVO_ALREADY_CONFIGURED',
  SETUP_BREVO_NOT_CONFIGURED: 'SETUP_BREVO_NOT_CONFIGURED',
  SETUP_CLAIM_INVALID_TOKEN: 'SETUP_CLAIM_INVALID_TOKEN',
  SETUP_DOMAIN_REQUIRED: 'SETUP_DOMAIN_REQUIRED',
  SETUP_SESSION_REQUIRED: 'SETUP_SESSION_REQUIRED',
  SETUP_SESSION_INVALID: 'SETUP_SESSION_INVALID',

  // Mailbox authz (403) — used by modules/tenancy/authorizer.ts
  MAILBOX_ACCESS_DENIED: 'MAILBOX_ACCESS_DENIED',

  // Provider (502)
  PROVIDER_CONFIG_ERROR: 'PROVIDER_CONFIG_ERROR',
  PROVIDER_CONNECTION_FAILED: 'PROVIDER_CONNECTION_FAILED',
  PROVIDER_SEND_FAILED: 'PROVIDER_SEND_FAILED',

  // Body / transport (413)
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',

  // Rate limit / contention (429 / 503) — D-CAP-032-D catalogue-but-unused.
  // No route emits these today; declared so the next capability that needs
  // them has the catalog slot pre-allocated.
  RATE_LIMITED: 'RATE_LIMITED',
  LOCK_CONTENTION: 'LOCK_CONTENTION',

  // Server-side (500)
  INTERNAL: 'INTERNAL',
  INVALID_EMAIL: 'INVALID_EMAIL',
  AVATAR_INVALID: 'AVATAR_INVALID',
  AVATAR_NOT_FOUND: 'AVATAR_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  PASSWORD_MISMATCH: 'PASSWORD_MISMATCH',
  PASSWORD_LENGTH: 'PASSWORD_LENGTH',
  FIELD_REQUIRED: 'FIELD_REQUIRED',
  SUBJECT_TOO_LONG: 'SUBJECT_TOO_LONG',
  BODY_TOO_LONG: 'BODY_TOO_LONG',

  // CAP-044 Slice 2 fix (b): a stored audit_events row failed the read
  // contract (e.g. an `action` outside the closed AuditAction enum). The
  // audit trail is a forensic surface — the violation must surface as a
  // visible 500, never as a silently skipped row or a 200 the client
  // cannot parse. Distinct from INTERNAL so operators can tell data
  // corruption apart from a generic failure.
  AUDIT_ROW_INVALID: 'AUDIT_ROW_INVALID',

  // CAP-044 Slice 3 fix (d): the users twin of AUDIT_ROW_INVALID — a
  // stored users row failed the read contract (e.g. a status outside
  // the closed users.status enum). Same posture: a visible 500, never a
  // silently skipped row or a 200 the client cannot parse; distinct
  // from INTERNAL so operators can tell data corruption apart from a
  // generic failure. (Unreachable through D1 today — users.status
  // carries a CHECK constraint — the repository's safeParse is
  // defense-in-depth against schema drift.)
  USER_ROW_INVALID: 'USER_ROW_INVALID',

  // CAP-050: a compose-time `attachmentUploadId` is missing, foreign to
  // the actor/mailbox, expired, already consumed, or its KV bytes are
  // gone. Every one of those paths collapses to this single stable
  // code so we never disclose ownership or lifecycle details to the
  // client (R-API-002 / R-AUTHZ-004). Mapped to 400 — the request was
  // syntactically valid, but one of its inputs cannot be honored.
  ATTACHMENT_UPLOAD_NOT_FOUND: 'ATTACHMENT_UPLOAD_NOT_FOUND',
  DRAFT_CACHE_ERROR: 'DRAFT_CACHE_ERROR',
  DRAFT_LOAD_FAILED: 'DRAFT_LOAD_FAILED',
  DRAFT_SAVE_FAILED: 'DRAFT_SAVE_FAILED',
  HTTP_ERROR: 'HTTP_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  UNKNOWN: 'UNKNOWN',
} as const satisfies Readonly<Record<string, string>>;

/**
 * Closed union of all error codes. Derived from the catalog so adding a
 * code to ERROR_CODES automatically widens this union. Routes can ONLY
 * use a code that appears here — TypeScript will reject any other string
 * literal at the call site of `new DomainError({ code: ... })`.
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
