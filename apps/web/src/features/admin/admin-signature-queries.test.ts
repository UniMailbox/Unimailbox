import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../infrastructure/api/client';
import {
  adminQueryKeys,
  fetchAdminSignatures,
  signaturePath,
  updateAdminSignature,
} from './admin-queries';

describe('admin signature query contract (CAP-068)', () => {
  it('scopes cache entries to the user and encodes the signature id', () => {
    expect(adminQueryKeys.signatures('u-1')).not.toEqual(adminQueryKeys.signatures('u-2'));
    expect(signaturePath('signature/id')).toBe('/api/v1/admin/signatures/signature%2Fid');
  });

  it('wraps a schema-invalid 2xx response as INVALID_RESPONSE', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: { items: [{ id: 'missing-fields' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });

    await expect(fetchAdminSignatures(apiClient)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 0,
    });
  });

  it('sends the server timestamp as the optimistic-concurrency header', async () => {
    let request: RequestInit | undefined;
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async (_input, init) => {
        request = init;
        return new Response(
          JSON.stringify({
            data: {
              id: '00000000-0000-4000-8000-000000000002',
              domainId: '00000000-0000-4000-8000-000000000001',
              domainName: 'example.com',
              htmlContent: '<p>Updated</p>',
              textContent: 'Updated',
              isEnabled: true,
              createdAt: '2026-09-01 00:00:00',
              updatedAt: '2026-09-01 00:00:01',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    await updateAdminSignature(
      apiClient,
      '00000000-0000-4000-8000-000000000002',
      { htmlContent: '<p>Updated</p>', textContent: 'Updated', isEnabled: true },
      '2026-09-01 00:00:00',
    );
    expect(new Headers(request?.headers).get('If-Match')).toBe('2026-09-01 00:00:00');
  });
});
