// apps/web — admin-queries tests.
//
// CAP-044 Slice 2 (AC 14). The pure URL builder `auditEventsPath` is the
// single source of the request path AND the query key (via
// `adminQueryKeys.auditEvents`), so these tests pin the wire format for
// every filter combination the page can produce: dropped empty values,
// deterministic param order, URL encoding, and cursor chaining.
//
// Slice 2 fix pass (f): the page fetcher's schema-invalid detection —
// a 2xx JSON body that does not match auditEventListResponseSchema must
// surface as ApiError INVALID_RESPONSE, never a raw ZodError.
import { describe, expect, it } from 'vitest';
import { adminQueryKeys, auditEventsPath, fetchAuditEventsPage } from './admin-queries';
import { createApiClient } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';

const ACTOR = '00000000-0000-4000-8000-00000000000a';

describe('auditEventsPath (CAP-044 Slice 2 / AC 14)', () => {
  it('builds the bare path when no filter is set', () => {
    expect(auditEventsPath({})).toBe('/api/v1/admin/audit-events');
  });

  it('appends actorUserId alone', () => {
    expect(auditEventsPath({ actorUserId: ACTOR })).toBe(
      `/api/v1/admin/audit-events?actorUserId=${ACTOR}`,
    );
  });

  it('appends the resource pair together, in order', () => {
    expect(auditEventsPath({ resourceType: 'message', resourceId: 'm-1' })).toBe(
      '/api/v1/admin/audit-events?resourceType=message&resourceId=m-1',
    );
  });

  it('appends action alone', () => {
    expect(auditEventsPath({ action: 'message.send' })).toBe(
      '/api/v1/admin/audit-events?action=message.send',
    );
  });

  it('composes every filter in a deterministic order', () => {
    expect(
      auditEventsPath({
        actorUserId: ACTOR,
        resourceType: 'mailbox',
        resourceId: 'mb-1',
        action: 'mailbox.create',
      }),
    ).toBe(
      `/api/v1/admin/audit-events?actorUserId=${ACTOR}` +
        '&resourceType=mailbox&resourceId=mb-1&action=mailbox.create',
    );
  });

  it('chains the cursor after the filters', () => {
    expect(auditEventsPath({ action: 'setup.claim' }, 'opaque.cursor+1=')).toBe(
      '/api/v1/admin/audit-events?action=setup.claim&cursor=opaque.cursor%2B1%3D',
    );
  });

  it('drops empty-string filter values — the server schema would 400 on them', () => {
    expect(
      auditEventsPath({
        actorUserId: '',
        resourceType: '',
        resourceId: '',
      }),
    ).toBe('/api/v1/admin/audit-events');
    // A cursor of '' is equally never sent.
    expect(auditEventsPath({}, '')).toBe('/api/v1/admin/audit-events');
  });

  it('URL-encodes values carrying reserved characters', () => {
    expect(auditEventsPath({ resourceType: 'a b', resourceId: 'x/y?z' })).toBe(
      '/api/v1/admin/audit-events?resourceType=a+b&resourceId=x%2Fy%3Fz',
    );
  });
});

describe('adminQueryKeys.auditEvents (CAP-044 Slice 2)', () => {
  it('keys identical filter sets identically — the key derives from the path', () => {
    expect(adminQueryKeys.auditEvents('u-1', { action: 'message.send' })).toEqual(
      adminQueryKeys.auditEvents('u-1', { action: 'message.send' }),
    );
  });

  it('keys different filter sets differently', () => {
    expect(adminQueryKeys.auditEvents('u-1', { action: 'message.send' })).not.toEqual(
      adminQueryKeys.auditEvents('u-1', { action: 'setup.claim' }),
    );
  });

  it('lives inside the admin family so future invalidation can sweep it', () => {
    const key = adminQueryKeys.auditEvents('u-1', {});
    expect(key[0]).toBe('admin');
    expect(key[1]).toBe('audit-events');
  });
});

describe('adminQueryKeys userId scoping (Slice 3 fix (a) — cross-user cache disclosure)', () => {
  // Ruling 1: sign-out nulls only the session entry; admin keys survive.
  // Without the userId in the key, user B's mount after user A signs out
  // would render A's cached rows under B's 403 session (the data-first
  // contract keeps them on screen). A different user is a different key.
  it("scopes every data key to the userId — a different user never reuses another user's cache entry", () => {
    expect(adminQueryKeys.auditEvents('u-1', {})).not.toEqual(
      adminQueryKeys.auditEvents('u-2', {}),
    );
    expect(adminQueryKeys.users('u-1')).not.toEqual(adminQueryKeys.users('u-2'));
    expect(adminQueryKeys.connections('u-1')).not.toEqual(adminQueryKeys.connections('u-2'));
    expect(adminQueryKeys.webhookEvents('u-1')).not.toEqual(adminQueryKeys.webhookEvents('u-2'));
  });

  it('keys the same user stably — the scoping adds no instability within one session', () => {
    expect(adminQueryKeys.users('u-1')).toEqual(adminQueryKeys.users('u-1'));
    expect(adminQueryKeys.connections('u-1')).toEqual(adminQueryKeys.connections('u-1'));
    expect(adminQueryKeys.webhookEvents('u-1')).toEqual(adminQueryKeys.webhookEvents('u-1'));
  });
});

describe('fetchAuditEventsPage (Slice 2 fix (f))', () => {
  it('throws ApiError INVALID_RESPONSE for a schema-invalid 2xx body, never a raw ZodError', async () => {
    // The body IS JSON and the status IS 2xx — the ApiClient hands it
    // through; only the contracts schema detects the drift (nextCursor
    // is not a string|null). Before fix (f) this surfaced as a raw
    // ZodError from the page hook.
    const body = JSON.stringify({ data: { items: [], nextCursor: 42 } });
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl,
    });

    const failure = fetchAuditEventsPage(apiClient, {});
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
