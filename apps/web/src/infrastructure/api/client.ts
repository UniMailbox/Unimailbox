import { getLanguage } from '../i18n/locale';
import { AVATAR_MAX_BYTES, EDITOR_FILE_MAX_BYTES } from '@unimailbox/contracts';
// apps/web — API client.
//
// CAP-041 wires the wizard's HTTP surface. The client is the only place that
// adds Idempotency-Key, Authorization, and x-request-id headers (ADR-004);
// step components never touch them. The retry policy lives in `retry.ts` and
// is applied here for 5xx / 429 responses only — 4xx is deterministic and the
// operator must retry explicitly via the <ErrorPanel>.
//
// Construction:
//   const apiClient = createApiClient({
//     baseUrl: '',
//     getSessionToken: () => useSetupSession.getState().sessionToken,
//   });
//
// The base URL defaults to the same-origin so the Worker's SPA fallback can
// proxy requests. Tests override `baseUrl` to point at a mocked fetch.
//
// Security MEDIUM #5 (CAP-041 fix): the client enforces a 1 MB body cap
// before the fetch call. Anything larger throws a typed `ApiError` with
// code `PAYLOAD_TOO_LARGE` so the browser never receives a generic
// NetworkError from a too-large body.
import { ApiError, parseErrorBody } from './errors';
import { defaultRetryPolicy, isRetryableStatus, sleep } from './retry';

/** Maximum request body size, in bytes. */
export const MAX_BODY_BYTES = 1_048_576;

export interface ApiClientInit {
  readonly baseUrl: string;
  readonly getSessionToken: () => string | null;
  readonly fetchImpl?: typeof fetch;
  readonly retryPolicy?: typeof defaultRetryPolicy;
  readonly uuid?: () => string;
}

export interface ApiRequestInit {
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Explicitly disable automatic retries for paid inference calls. */
  readonly retry?: boolean;
  /** Binary attachment response; errors still use the normal API envelope. */
  readonly responseType?: 'arrayBuffer';
  /** Used by tests to assert retry behaviour without sleeping in real time. */
  readonly retryDelays?: number[];
}

export interface ApiClient {
  readonly baseUrl: string;
  fetch<T>(path: string, init?: ApiRequestInit): Promise<T>;
}

/**
 * `createApiClient` — factory that returns a configured client. The session
 * token is read through the `getSessionToken` getter so the client never
 * imports the setup store directly; the caller wires the dependency.
 */
export function createApiClient(init: ApiClientInit): ApiClient {
  const fetchImpl = init.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const retryPolicy = init.retryPolicy ?? defaultRetryPolicy;
  const uuid = init.uuid ?? defaultUuid;
  const retryDelaysByCall: number[] = [];

  const client: ApiClient = {
    baseUrl: init.baseUrl,
    async fetch<T>(path: string, requestInit: ApiRequestInit = {}): Promise<T> {
      const method = requestInit.method ?? 'GET';
      const url = joinUrl(init.baseUrl, path);
      const headers = new Headers(requestInit.headers);

      // D-CAP-041-1: every request gets a request-id (server correlates to
      // its log stream). Step components and the API client add this
      // here; tests can inject a deterministic uuid via the factory.
      headers.set('x-request-id', uuid());

      // D-CAP-041-2 / Security MEDIUM #4 (CAP-041 fix): every non-safe
      // request (PUT, PATCH, DELETE, POST) gets a fresh Idempotency-Key.
      // The server rejects reuse with a different body (409
      // IDEMPOTENCY_KEY_REUSED). GET/HEAD are safe — never need one.
      const idempotent = method !== 'GET' && method !== 'HEAD' && !headers.has('Idempotency-Key');
      if (idempotent) {
        headers.set('Idempotency-Key', uuid());
      }

      // D-CAP-041-3: Authorization: Bearer <sessionToken> after /claim.
      // The client reads the value from the store via the getter; step
      // components never read the token.
      const sessionToken = init.getSessionToken();
      if (sessionToken !== null) {
        headers.set('Authorization', `Bearer ${sessionToken}`);
      }

      headers.set('Accept', 'application/json');
      headers.set('Accept-Language', getLanguage());

      // D-CAP-042-auth-ct: when the body is an object, JSON-stringify it
      // AND set Content-Type: application/json unless the caller already
      // provided one. `fetch()` defaults the Content-Type for a string
      // body to `text/plain;charset=UTF-8`, which Better Auth's
      // `sign-in/email` (and any other strict-JSON route) rejects with
      // 415 `UNSUPPORTED_MEDIA_TYPE`. Tolerated for years by every
      // setup/admin/messages route because those handlers call
      // `c.req.text()` and parse the JSON themselves — that luck ends
      // the moment a route validates the header, which Better Auth
      // does at its handler boundary. Setting the header here is
      // idempotent: callers that already provided one keep their value.
      if (
        requestInit.body !== undefined &&
        typeof requestInit.body !== 'string' &&
        !(requestInit.body instanceof Blob) &&
        !headers.has('Content-Type')
      ) {
        headers.set('Content-Type', 'application/json');
      }

      const binary = requestInit.body instanceof Blob;
      const requestBody = binary
        ? (requestInit.body as Blob)
        : requestInit.body === undefined
          ? undefined
          : typeof requestInit.body === 'string'
            ? requestInit.body
            : JSON.stringify(requestInit.body);

      // Security MEDIUM #5 (CAP-041 fix): guard against oversized payloads
      // BEFORE the fetch call. Returning a typed error means the browser
      // never sees a generic NetworkError, and the wizard's <ErrorPanel>
      // can surface the machine code per R-API-002.
      const bodyBytes =
        requestBody instanceof Blob
          ? requestBody.size
          : new TextEncoder().encode(requestBody ?? '').byteLength;
      const bodyLimit =
        binary && /^\/api\/v1\/(?:mailboxes|admin\/domains)\/[^/]+\/editor-assets$/.test(path)
          ? EDITOR_FILE_MAX_BYTES
          : binary && path === '/api/v1/auth/me/avatar'
            ? AVATAR_MAX_BYTES
            : MAX_BODY_BYTES;
      if (bodyBytes > bodyLimit) {
        throw new ApiError('BODY_TOO_LARGE', 'Request body exceeds the upload limit', 413);
      }

      let attempt = 0;
      let lastError: unknown = null;
      while (true) {
        attempt += 1;
        // CAP-042 Batch 8 (M-3 fix): set `credentials: 'include'`
        // explicitly so the browser carries the HttpOnly Better Auth
        // cookie on every fetch. The browser default (`same-origin`)
        // already includes cookies for same-origin requests, but a
        // future split-host deployment (CDN + Worker origin) would
        // drop the cookie under the default policy. Explicit is
        // defensive and matches the comment in `auth-queries.ts` and
        // `auth-session-store.ts`.
        const fetchInit: RequestInit = {
          method,
          headers,
          credentials: 'include',
        };
        if (requestBody !== undefined) {
          fetchInit.body = requestBody;
        }
        if (requestInit.signal !== undefined) {
          fetchInit.signal = requestInit.signal;
        }
        let response: Response;
        try {
          response = await fetchImpl(url, fetchInit);
        } catch (cause) {
          if (requestInit.signal?.aborted) throw cause;
          throw new ApiError('NETWORK_ERROR', 'Could not connect', 0);
        }

        if (response.ok) {
          if (requestInit.responseType === 'arrayBuffer') {
            return (await response.arrayBuffer()) as T;
          }
          // Empty 204 — return undefined as `void`-shaped data.
          if (response.status === 204) {
            return undefined as T;
          }
          const text = await response.text();
          if (text.length === 0) {
            return undefined as T;
          }
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new ApiError(
              'INVALID_RESPONSE',
              'Server returned a non-JSON response',
              response.status,
              response.headers.get('x-request-id') ?? undefined,
            );
          }
        }

        // Non-2xx — try to retry per the policy.
        if (requestInit.retry !== false && isRetryableStatus(response.status)) {
          const delay = retryPolicy.nextDelay(attempt, { status: response.status });
          if (delay !== null && attempt < retryPolicy.maxAttempts + 1) {
            retryDelaysByCall.push(delay);
            if (requestInit.retryDelays !== undefined) {
              requestInit.retryDelays.push(delay);
            }
            await sleep(delay, abortController(requestInit.signal));
            continue;
          }
        }

        // After this point the response is non-retryable. Parse the error
        // envelope and throw.
        const parsed = await parseErrorBody(response.clone());
        lastError = new ApiError(parsed.code, parsed.message, response.status, parsed.requestId);
        throw lastError;
      }
    },
  };

  return client;
}

function abortController(signal: AbortSignal | undefined): AbortController {
  // `sleep` needs an AbortController — wrap the caller's signal so the
  // caller's `controller.abort()` propagates into the retry wait.
  const controller = new AbortController();
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  return controller;
}

function joinUrl(base: string, path: string): string {
  if (base === '') return path;
  if (base.endsWith('/') && path.startsWith('/')) {
    return base + path.slice(1);
  }
  if (!base.endsWith('/') && !path.startsWith('/')) {
    return base + '/' + path;
  }
  return base + path;
}

function defaultUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID; the wizard
  // runs in happy-dom / modern browsers / Cloudflare Workers, all of
  // which expose it. Keep the fallback for older test environments.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
