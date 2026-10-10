import {
  createApiClient,
  type ApiClient,
  type ApiClientInit,
  type ApiRequestInit,
} from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
import { setAccessToken, useAuthSession } from './auth-session-store';

/** Recover an expired access token without discarding an open form. */
export function createAuthenticatedApiClient(init: ApiClientInit): ApiClient {
  const client = createApiClient(init);
  let recovery: { token: string; promise: Promise<string | null> } | undefined;

  return {
    baseUrl: client.baseUrl,
    async fetch<T>(path: string, requestInit: ApiRequestInit = {}): Promise<T> {
      const session = useAuthSession.getState().session;
      const token = useAuthSession.getState().accessToken;
      // Authentication/setup have their own recovery and credential contracts.
      const recoverable =
        session !== null &&
        token !== null &&
        path.startsWith('/api/v1/') &&
        (!path.startsWith('/api/v1/auth/') ||
          path.startsWith('/api/v1/auth/me/') ||
          path === '/api/v1/auth/change-password') &&
        !path.startsWith('/api/v1/setup/');
      const headers = new Headers(requestInit.headers);
      const method = requestInit.method ?? 'GET';
      // Reuse the same mutation identity if the first attempt was unauthorized.
      if (recoverable && method !== 'GET' && method !== 'HEAD' && !headers.has('Idempotency-Key')) {
        headers.set('Idempotency-Key', (init.uuid ?? (() => crypto.randomUUID()))());
      }
      const request = { ...requestInit, headers: Object.fromEntries(headers.entries()) };
      try {
        return await client.fetch<T>(path, request);
      } catch (error) {
        if (
          !recoverable ||
          !(error instanceof ApiError) ||
          error.status !== 401 ||
          requestInit.signal?.aborted ||
          useAuthSession.getState().session !== session
        ) {
          throw error;
        }
        if (recovery?.token !== token) {
          recovery = {
            token,
            promise: (async () => {
              // Another protected request may already have renewed this session.
              const current = useAuthSession.getState().accessToken;
              if (current !== token) return current;
              try {
                const result = await client.fetch<{ data?: { accessToken?: unknown } }>(
                  '/api/v1/auth/refresh',
                  { method: 'POST', body: {} },
                );
                const renewed = result.data?.accessToken;
                if (
                  typeof renewed !== 'string' ||
                  renewed.length === 0 ||
                  useAuthSession.getState().session !== session
                ) {
                  return null;
                }
                setAccessToken(renewed);
                return renewed;
              } catch {
                return null;
              }
            })(),
          };
        }
        const renewed = await recovery.promise;
        if (
          renewed === null ||
          useAuthSession.getState().session !== session ||
          useAuthSession.getState().accessToken !== renewed ||
          requestInit.signal?.aborted
        ) {
          throw error;
        }
        // One replay only. A second 401 is surfaced; permission failures never renew.
        return client.fetch<T>(path, request);
      }
    },
  };
}
