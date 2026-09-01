import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../infrastructure/api/client';
import { DEFAULT_SYSTEM_SETTINGS } from '@unimailbox/contracts';
import { adminQueryKeys, fetchAdminSettings, updateAdminSettings } from './admin-queries';

const responseData = {
  settings: DEFAULT_SYSTEM_SETTINGS,
  environment: 'local',
  canManage: true,
  updatedAt: '1970-01-01 00:00:00',
};

describe('admin settings query contract (CAP-069)', () => {
  it('R-SETTINGS-007 scopes the cache entry to the signed-in user', () => {
    expect(adminQueryKeys.settings('u-1')).not.toEqual(adminQueryKeys.settings('u-2'));
  });

  it('R-SETTINGS-001 strictly parses the safe response and wraps drift', async () => {
    const invalidClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: { settings: { brevoApiKey: 'secret' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    await expect(fetchAdminSettings(invalidClient)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 0,
    });
  });

  it('R-SETTINGS-007 sends the typed settings projection to PATCH', async () => {
    let captured: RequestInit | undefined;
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async (_input, init) => {
        captured = init;
        return new Response(JSON.stringify({ data: responseData }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await updateAdminSettings(
      apiClient,
      { ...DEFAULT_SYSTEM_SETTINGS, siteTitle: 'Ops' },
      '1970-01-01 00:00:00',
    );
    expect(captured?.method).toBe('PATCH');
    expect(new Headers(captured?.headers).get('If-Match')).toBe('1970-01-01 00:00:00');
    expect(JSON.parse(String(captured?.body))).toMatchObject({ siteTitle: 'Ops' });
  });
});
