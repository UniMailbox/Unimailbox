import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedApiClient } from './auth-api-client';
import {
  clearAuthSession,
  resetAuthSessionForTesting,
  setAuthSession,
  useAuthSession,
} from './auth-session-store';

function response(status = 200, data: unknown = { ok: true }): Response {
  return new Response(
    JSON.stringify(
      status === 200
        ? { data }
        : { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' } },
    ),
    { status },
  );
}
function session(): void {
  setAuthSession({
    userId: 'user-a',
    email: 'a@example.test',
    displayName: null,
    expiresAt: '',
    accessToken: 'expired',
  });
}
function makeClient(handler: (path: string, init: RequestInit) => Promise<Response>) {
  const fetchImpl = vi.fn((path: RequestInfo | URL, init?: RequestInit) =>
    handler(String(path), init ?? {}),
  );
  return {
    fetchImpl,
    client: createAuthenticatedApiClient({
      baseUrl: '',
      getSessionToken: () => useAuthSession.getState().accessToken,
      fetchImpl: fetchImpl as typeof fetch,
    }),
  };
}

describe('protected request session recovery', () => {
  beforeEach(() => {
    resetAuthSessionForTesting();
    session();
  });

  it('renews an expired form save once and preserves body and idempotency key', async () => {
    const attempts: {
      token: string | null;
      key: string | null;
      body: BodyInit | null | undefined;
    }[] = [];
    const { client, fetchImpl } = makeClient(async (path, init) => {
      if (path.endsWith('/auth/refresh')) {
        expect(init.credentials).toBe('include');
        expect(init.body).toBe('{}');
        return response(200, { accessToken: 'renewed' });
      }
      const headers = new Headers(init.headers);
      attempts.push({
        token: headers.get('Authorization'),
        key: headers.get('Idempotency-Key'),
        body: init.body,
      });
      return headers.get('Authorization') === 'Bearer renewed' ? response() : response(401);
    });
    await expect(
      client.fetch('/api/v1/admin/signatures', { method: 'POST', body: { isEnabled: false } }),
    ).resolves.toEqual({ data: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(attempts.map((a) => a.token)).toEqual(['Bearer expired', 'Bearer renewed']);
    expect(attempts[0]?.key).toBeTruthy();
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(attempts[1]?.body).toBe(attempts[0]?.body);
  });

  it('shares one refresh across concurrent protected requests', async () => {
    const { client, fetchImpl } = makeClient(async (path, init) => {
      if (path.endsWith('/auth/refresh')) return response(200, { accessToken: 'renewed' });
      return new Headers(init.headers).get('Authorization') === 'Bearer renewed'
        ? response()
        : response(401);
    });
    await Promise.all([
      client.fetch('/api/v1/admin/roles'),
      client.fetch('/api/v1/admin/settings'),
    ]);
    expect(fetchImpl.mock.calls.filter(([path]) => path === '/api/v1/auth/refresh')).toHaveLength(
      1,
    );
  });

  it.each(['/api/v1/auth/login', '/api/v1/setup/claim'])(
    'does not recover %s credentials',
    async (path) => {
      const { client, fetchImpl } = makeClient(async () => response(401));
      await expect(client.fetch(path, { method: 'POST', body: {} })).rejects.toMatchObject({
        status: 401,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('does not renew a permission denial', async () => {
    const { client, fetchImpl } = makeClient(async () => response(403));
    await expect(client.fetch('/api/v1/admin/settings')).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a second 401 without a refresh loop', async () => {
    const { client, fetchImpl } = makeClient(async (path) =>
      path.endsWith('/auth/refresh') ? response(200, { accessToken: 'renewed' }) : response(401),
    );
    await expect(client.fetch('/api/v1/admin/settings')).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not revive a session or replay a save when logout occurs during refresh', async () => {
    let finish: ((result: Response) => void) | undefined;
    const { client, fetchImpl } = makeClient(async (path) =>
      path.endsWith('/auth/refresh')
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : response(401),
    );
    const request = client.fetch('/api/v1/admin/settings', { method: 'PUT', body: {} });
    const rejected = expect(request).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(finish).toBeDefined());
    clearAuthSession();
    finish?.(response(200, { accessToken: 'renewed' }));
    await rejected;
    expect(useAuthSession.getState().accessToken).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('preserves the original error when refresh fails', async () => {
    const { client, fetchImpl } = makeClient(async () => response(401));
    await expect(client.fetch('/api/v1/admin/settings')).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
