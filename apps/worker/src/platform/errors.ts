// platform/errors — CAP-032: closed machine-readable error catalog.
//
// R-API-001: every error response is `{ error: { code, message, requestId } }`.
// R-API-002: `code` is stable across releases. The closed ERROR_CODES catalog
//   is the enforcement mechanism — adding a code requires editing this file.
// R-API-003: HTTP status mapping is real (400 / 401 / 403 / 404 / 409 / 413 /
//   429 / 502 / 503); the catalog records each mapping as `httpStatus`.
//
// The HTTP error middleware is the ONLY place that maps code → status
// (per .claude/rules/coding.md §Errors). Routes `throw new DomainError(...)`
// and the middleware renders the canonical envelope.
//
// Codes in this catalog fall into two buckets:
//
//   1. **Live** — emitted by at least one route or module today.
//   2. **Catalogued but unused** — declared for future use (D-CAP-032-D).
//      Today no site throws `429` / `503`; .claude/rules/architecture.md
//      §API conventions documents them; the catalog records the mapping.

/**
 * HTTP status codes that the error catalog can emit. Framework-neutral:
 * `platform/*` must not depend on Hono's `ContentfulStatusCode`. Status
 * codes recorded here are the ones the catalog actually maps to today
 * (D-CAP-032-D plus the live set).
 */
export type HttpStatusCode =
  | 200
  | 201
  | 204
  | 400
  | 401
  | 403
  | 404
  | 409
  | 412
  | 413
  | 429
  | 500
  | 502
  | 503;

/**
 * The canonical error-code catalog.
 *
 * `as const` makes each value a literal type so the derived `ErrorCode`
 * union is a closed set. Adding a code requires editing this object — that
 * is the whole point (R-API-002).
 */
export const ERROR_CODES = {
  // Auth (401 / 403)
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  USER_BANNED: 'USER_BANNED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
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
  MAILBOX_NOT_FOUND: 'MAILBOX_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  // CAP-043 Slice 1 / R-API-005: the cursor HMAC returned a tampered or
  // malformed payload (or the route layer received a signature mismatch).
  // 400 with the stable code; clients should refetch from the start.
  INVALID_CURSOR: 'INVALID_CURSOR',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  BLOCKLIST_ENTRY_NOT_FOUND: 'BLOCKLIST_ENTRY_NOT_FOUND',
  PROVIDER_CONNECTION_NOT_FOUND: 'PROVIDER_CONNECTION_NOT_FOUND',
  WEBHOOK_CONNECTION_NOT_FOUND: 'WEBHOOK_CONNECTION_NOT_FOUND',
  WEBHOOK_NOT_CONFIGURED: 'WEBHOOK_NOT_CONFIGURED',
  WEBHOOK_SIGNATURE_MISSING: 'WEBHOOK_SIGNATURE_MISSING',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  REGISTRATION_CODE_INVALID: 'REGISTRATION_CODE_INVALID',
  REGISTRATION_CODE_EXPIRED: 'REGISTRATION_CODE_EXPIRED',
  REGISTRATION_CODE_REVOKED: 'REGISTRATION_CODE_REVOKED',
  REGISTRATION_CODE_EXHAUSTED: 'REGISTRATION_CODE_EXHAUSTED',
  USER_EMAIL_TAKEN: 'USER_EMAIL_TAKEN',

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
} as const satisfies Readonly<Record<string, string>>;

/**
 * Closed union of all error codes. Derived from the catalog so adding a
 * code to ERROR_CODES automatically widens this union. Routes can ONLY
 * use a code that appears here — TypeScript will reject any other string
 * literal at the call site of `new DomainError({ code: ... })`.
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * The canonical error envelope returned by every `/api/v1/*` endpoint.
 * R-API-001: `code` and `requestId` are mandatory; `message` is human-readable.
 */
export interface HttpErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    /** UUIDv4 produced by the request-id middleware. */
    readonly requestId: string;
  };
}

export interface DomainErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly httpStatus?: HttpStatusCode;
  readonly cause?: unknown;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: HttpStatusCode | undefined;
  readonly meta: Readonly<Record<string, unknown>> | undefined;
  // `cause` is inherited from Error.prototype; do NOT redeclare it as a class
  // field — with `useDefineForClassFields: true` (TS default for ES2022 +
  // module ESNext) the field declaration would shadow Error's instance
  // assignment and reset `cause` to `undefined`.

  constructor(options: DomainErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DomainError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.meta = options.meta;
  }

  /**
   * Serialise to the canonical envelope inner shape. The HTTP middleware is
   * the only consumer; tests assert on this directly. `requestId` is added
   * by the middleware from `c.get('requestId')`, not by DomainError itself.
   */
  toJSON(): { code: ErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}
