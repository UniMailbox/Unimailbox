import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../infrastructure/api/client';
import { adminQueryKeys, fetchAdminDomains, managedDomainPath } from './admin-queries';

describe('admin domain query contract (CAP-066)', () => {
  it('scopes the cache to the authenticated user and URL-encodes resource ids', () => {
    expect(adminQueryKeys.domains('u-1')).not.toEqual(adminQueryKeys.domains('u-2'));
    expect(managedDomainPath('domain/id')).toBe('/api/v1/admin/domains/domain%2Fid');
  });

  it('wraps a schema-invalid 2xx response as INVALID_RESPONSE', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: { items: [{ id: 'not-a-domain' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    await expect(fetchAdminDomains(apiClient)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 0,
    });
  });

  it('passes the query cancellation signal to the API client', async () => {
    let receivedSignal: AbortSignal | undefined;
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async (_input, init) => {
        receivedSignal = init?.signal ?? undefined;
        return new Response(JSON.stringify({ data: { items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    const controller = new AbortController();

    await fetchAdminDomains(apiClient, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });
});
