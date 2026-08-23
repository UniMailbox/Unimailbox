// apps/web — auth queries test.
//
// CAP-042 (Batch 5) AC 20 / AC 22. Tests:
// - `parseSessionResponse` accepts every Better Auth shape documented
//   in `auth-queries.ts` and rejects everything else to `null`.
// - `fetchAuthSession` swallows 401 (no cookie) and rethrows other
//   errors so the router's `beforeLoad` can redirect without leaking
//   the failure.
//
// The mutation tests (sign-in / sign-out / register) live in the
// page-level tests because they need the full TanStack Query +
// RouterProvider stack to assert cache invalidation.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parseSessionResponse, fetchAuthSession } from './auth-queries';
import { ApiError } from '../../infrastructure/api/errors';
import type { ApiClient } from '../../infrastructure/api/client';

const VALID_USER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_EMAIL = 'auth-queries@example.test';
const VALID_DISPLAY_NAME = 'Auth Queries';
const VALID_EXPIRES = '2099-01-01T00:00:00Z';

describe('parseSessionResponse', () => {
  it('returns null for null / undefined / empty input', () => {
    expect(parseSessionResponse(null)).toBeNull();
    expect(parseSessionResponse(undefined)).toBeNull();
  });

  it('returns null for an unwrapped `{ user: null, session: null }`', () => {
    expect(parseSessionResponse({ user: null, session: null })).toBeNull();
  });

  it('returns null for a wrapped `{ data: null }` envelope', () => {
    expect(parseSessionResponse({ data: null })).toBeNull();
  });

  it('returns a descriptor for a valid Better Auth session payload', () => {
    const descriptor = parseSessionResponse({
      user: {
        id: VALID_USER_ID,
        email: VALID_EMAIL,
        name: VALID_DISPLAY_NAME,
      },
      session: {
        userId: VALID_USER_ID,
        expiresAt: VALID_EXPIRES,
      },
    });
    expect(descriptor).not.toBeNull();
    expect(descriptor?.userId).toBe(VALID_USER_ID);
    expect(descriptor?.email).toBe(VALID_EMAIL);
    expect(descriptor?.displayName).toBe(VALID_DISPLAY_NAME);
    expect(descriptor?.expiresAt).toBe(VALID_EXPIRES);
  });

  it('returns a descriptor when the payload is wrapped in a `{ data }` envelope', () => {
    const descriptor = parseSessionResponse({
      data: {
        user: { id: VALID_USER_ID, email: VALID_EMAIL },
        session: { userId: VALID_USER_ID, expiresAt: VALID_EXPIRES },
      },
    });
    expect(descriptor).not.toBeNull();
    expect(descriptor?.userId).toBe(VALID_USER_ID);
  });

  it('returns null when the user is missing a string id', () => {
    expect(
      parseSessionResponse({
        user: { id: 42, email: VALID_EMAIL },
        session: { userId: VALID_USER_ID, expiresAt: VALID_EXPIRES },
      }),
    ).toBeNull();
  });

  it('returns null when the session is missing an expiresAt timestamp', () => {
    expect(
      parseSessionResponse({
        user: { id: VALID_USER_ID, email: VALID_EMAIL },
        session: { userId: VALID_USER_ID },
      }),
    ).toBeNull();
  });

  it('returns null for non-object payloads', () => {
    expect(parseSessionResponse('not-a-session')).toBeNull();
    expect(parseSessionResponse(42)).toBeNull();
  });

  it('treats a missing `name` as `displayName: null`', () => {
    const descriptor = parseSessionResponse({
      user: { id: VALID_USER_ID, email: VALID_EMAIL },
      session: { userId: VALID_USER_ID, expiresAt: VALID_EXPIRES },
    });
    expect(descriptor?.displayName).toBeNull();
  });
});

describe('fetchAuthSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the parsed descriptor when the API returns a valid session', async () => {
    const apiClient = makeClient(
      jsonResponse({
        user: { id: VALID_USER_ID, email: VALID_EMAIL },
        session: { userId: VALID_USER_ID, expiresAt: VALID_EXPIRES },
      }),
    );
    const descriptor = await fetchAuthSession(apiClient);
    expect(descriptor?.userId).toBe(VALID_USER_ID);
  });

  it('returns null when the API responds with 401 (no cookie)', async () => {
    const apiClient = makeClient(
      errorResponse('UNAUTHORIZED', 'Authentication required', 401),
    );
    const descriptor = await fetchAuthSession(apiClient);
    expect(descriptor).toBeNull();
  });

  it('returns null when the API responds with `{ data: null }`', async () => {
    const apiClient = makeClient(jsonResponse({ data: null }));
    expect(await fetchAuthSession(apiClient)).toBeNull();
  });

  it('rethrows non-401 ApiErrors so the error boundary can surface them', async () => {
    const apiClient = makeClient(
      errorResponse('INTERNAL', 'Database unreachable', 500),
    );
    await expect(fetchAuthSession(apiClient)).rejects.toBeInstanceOf(ApiError);
  });
});

function makeClient(response: Response): ApiClient {
  // Mirror the real `ApiClient` behavior: parse the error envelope and
  // throw `ApiError` on non-2xx responses. Otherwise
  // `fetchAuthSession` cannot distinguish "API said no session" from
  // "API blew up", and the router's `beforeLoad` would silently treat
  // a 500 as a logged-out user (a security regression — R-AUTH-006
  // spirit).
  return {
    baseUrl: '',
    async fetch<T>(): Promise<T> {
      if (!response.ok) {
        // Replicate `parseErrorBody` minimally; the real helper lives
        // in `infrastructure/api/errors.ts` and is shared with the
        // production client.
        let code = 'HTTP_ERROR';
        let message = `Request failed with status ${String(response.status)}`;
        try {
          const body = (await response.json()) as
            | { error?: { code?: string; message?: string } }
            | null;
          if (
            body !== null &&
            typeof body === 'object' &&
            body.error &&
            typeof body.error === 'object'
          ) {
            if (typeof body.error.code === 'string') code = body.error.code;
            if (typeof body.error.message === 'string') message = body.error.message;
          }
        } catch {
          // body wasn't JSON — keep the fallback envelope.
        }
        throw new ApiError(code, message, response.status);
      }
      return (await response.json()) as T;
    },
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: { code, message, requestId: 'req-test' } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}