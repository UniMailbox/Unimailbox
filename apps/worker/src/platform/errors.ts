// platform/errors — CAP-001 stub.
// Stable machine-readable `code`. The HTTP error middleware is the ONLY place
// that maps code → status (per .claude/rules/coding.md §Errors).
//
// R-AUTHZ-* / R-DATA-* / R-SECRET-* etc. all surface as DomainError instances.
//
// `toJSON()` produces the canonical envelope inner shape `{ code, message }`
// the HTTP error middleware wraps in `{ error: { ... } }` — see
// .claude/rules/architecture.md §API conventions and http/errors.ts.
export type ErrorCode = string;

export interface DomainErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly httpStatus?: number;
  readonly cause?: unknown;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number | undefined;
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
   * the only consumer; tests assert on this directly.
   */
  toJSON(): { code: ErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}