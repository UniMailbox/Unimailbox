// platform/errors — CAP-001 stub.
// Stable machine-readable `code`. The HTTP error middleware is the ONLY place
// that maps code → status (per .claude/rules/coding.md §Errors).
//
// R-AUTHZ-* / R-DATA-* / R-SECRET-* etc. all surface as DomainError instances.
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
  override readonly cause: unknown;

  constructor(options: DomainErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DomainError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.meta = options.meta;
  }
}