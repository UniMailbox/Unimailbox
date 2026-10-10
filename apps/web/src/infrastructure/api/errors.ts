import { errorMessage } from '../i18n/error-messages';
// apps/web — API error envelope.
// The Worker returns `{ error: { code, message, requestId } }` (R-API-002).
// The client parses that envelope, throws a typed `ApiError` on any
// non-2xx response, and the rest of the wizard surfaces `code` as the
// sub-line under the human message. The error is the only place the
// `code` field is interpreted — no `instanceof` checks upstream.
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
  };
}

/**
 * `ApiError` — typed error thrown by the API client on any non-2xx
 * response. The `code` is the stable machine identifier from the
 * server; tests assert against this field. `requestId` is recorded for
 * correlation with the Worker log; never logged on the client because
 * logs may leave the browser.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(code: string, message: string, status: number, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    Object.defineProperty(this, 'message', { get: () => errorMessage(code), configurable: true });
    this.code = code;
    this.status = status;
    if (requestId !== undefined) {
      this.requestId = requestId;
    }
  }
}

/**
 * Pull a typed error body out of any response. Tolerant of malformed
 * JSON — falls back to a generic code so the wizard never crashes on
 * a misbehaving origin. Never throws.
 */
export async function parseErrorBody(response: Response): Promise<{
  code: string;
  message: string;
  requestId?: string | undefined;
}> {
  const fallback: {
    code: string;
    message: string;
    requestId?: string | undefined;
  } = {
    code: 'HTTP_ERROR',
    message: `Request failed with status ${String(response.status)}`,
    requestId: response.headers.get('x-request-id') ?? undefined,
  };
  try {
    const body = (await response.json()) as Partial<ApiErrorBody> | null;
    if (
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      body.error &&
      typeof body.error === 'object'
    ) {
      const err = body.error;
      const code = typeof err.code === 'string' ? err.code : fallback.code;
      const message = typeof err.message === 'string' ? err.message : fallback.message;
      const requestId = typeof err.requestId === 'string' ? err.requestId : fallback.requestId;
      return { code, message, requestId };
    }
  } catch {
    // body wasn't JSON — fall through to the generic envelope
  }
  return fallback;
}
