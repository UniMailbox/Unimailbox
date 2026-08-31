import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../infrastructure/api/client';
import { adminQueryKeys, fetchAdminRoles, rolePath } from './admin-queries';

describe('admin role query contract (CAP-067)', () => {
  it('scopes role data to the authenticated user and encodes resource ids', () => {
    expect(adminQueryKeys.roles('u-1')).not.toEqual(adminQueryKeys.roles('u-2'));
    expect(rolePath('role/id')).toBe('/api/v1/admin/roles/role%2Fid');
  });

  it('wraps a schema-invalid 2xx response as INVALID_RESPONSE', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: { roles: [{ id: 'administrator' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });

    await expect(fetchAdminRoles(apiClient)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 0,
    });
  });
});
