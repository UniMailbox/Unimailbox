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
export { ERROR_CODES, type ErrorCode } from '@unimailbox/contracts';
import type { ErrorCode } from '@unimailbox/contracts';

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
