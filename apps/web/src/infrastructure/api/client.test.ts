// apps/web — API client tests.
// CAP-041 AC #14: Idempotency-Key on every non-safe request, Authorization:
// Bearer after the session token is set. AC #15: 5xx/429 retried with
// exponential backoff; 4xx other than 409/429 is not retried.
//
// H3 (CAP-041 fix): the retry test now uses vi.useFakeTimers() +
// vi.advanceTimersByTime() — no real-time sleep. The previous test slept
// 3000ms, blocking the suite.
//
// Security MEDIUM #4 (CAP-041 fix): Idempotency-Key now covers PUT, PATCH,
// DELETE, POST — GET/HEAD stay free.
//
// Security MEDIUM #5 (CAP-041 fix): the client throws ApiError('PAYLOAD_TOO_LARGE')
// before fetch for bodies > 1 MB.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { ApiError } from './errors';

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

describe('createApiClient', () => {
  let calls: FetchCall[] = [];
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    calls = [];
    fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches a fresh Idempotency-Key to every POST', async () => {
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl,
    });
    await client.fetch('/api/v1/setup/claim', { method: 'POST', body: {} });
    await client.fetch('/api/v1/setup/claim', { method: 'POST', body: {} });
    const headers = calls.map((c) => c.init.headers as Headers);
    const first = headers[0]?.get('Idempotency-Key');
    const second = headers[1]?.get('Idempotency-Key');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toEqual(second);
    // Security MEDIUM #6 (CAP-041 fix): assert UUID shape.
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('attaches Idempotency-Key to PUT/PATCH/DELETE (Security MEDIUM #4)', async () => {
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl,
    });
    await client.fetch('/api/v1/messages/1', { method: 'PUT', body: { read: true } });
    await client.fetch('/api/v1/messages/1', { method: 'PATCH', body: { read: true } });
    await client.fetch('/api/v1/messages/1', { method: 'DELETE' });
    const headers = calls.map((c) => c.init.headers as Headers);
    expect(headers[0]?.has('Idempotency-Key')).toBe(true);
    expect(headers[1]?.has('Idempotency-Key')).toBe(true);
    expect(headers[2]?.has('Idempotency-Key')).toBe(true);
  });

  it('does not attach Idempotency-Key to GET', async () => {
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl,
    });
    await client.fetch<{ data: { ok: true } }>('/api/v1/setup/status');
    const headers = calls[0]?.init.headers as Headers;
    expect(headers.has('Idempotency-Key')).toBe(false);
  });

  it('does not attach Idempotency-Key to HEAD', async () => {
    // Even though the wizard does not call HEAD, the contract demands the
    // client treat HEAD as safe.
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl,
    });
    // fetchImpl signature does not declare HEAD via the helper; cast.
    await client.fetch('/api/v1/setup/status', { method: 'HEAD' });
    const headers = calls[0]?.init.headers as Headers;
    expect(headers.has('Idempotency-Key')).toBe(false);
  });

  it('attaches Authorization: Bearer <token> when sessionToken is set', async () => {
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => 'session-token-abc',
      fetchImpl,
    });
    await client.fetch('/api/v1/setup/preflight', { method: 'POST', body: {} });
    const headers = calls[0]?.init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer session-token-abc');
  });

  it('omits Authorization when sessionToken is null', async () => {
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl,
    });
    await client.fetch('/api/v1/setup/claim', { method: 'POST', body: {} });
    const headers = calls[0]?.init.headers as Headers;
    expect(headers.has('Authorization')).toBe(false);
  });

  it('attaches x-request-id to every request (UUID-shaped)', async () => {
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl,
    });
    await client.fetch('/api/v1/setup/status');
    const headers = calls[0]?.init.headers as Headers;
    const requestId = headers.get('x-request-id');
    expect(requestId).not.toBeNull();
    // Security MEDIUM #6 (CAP-041 fix): x-request-id is also UUID-shaped
    // so server logs correlate cleanly.
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('retries on 5xx with exponential backoff and then succeeds (H3 — no real-time sleep)', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const flakyFetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        attempt += 1;
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, init: init ?? {} });
        if (attempt < 3) {
          return Promise.resolve(new Response('boom', { status: 503 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    ) as unknown as typeof fetch;
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: flakyFetch,
    });
    // H3 (CAP-041 fix): `retryDelays` lets the test assert on the actual
    // delay values the retry policy chose, with no real-time sleep.
    const retryDelays: number[] = [];
    const promise = client.fetch<{ data: { ok: boolean } }>(
      '/api/v1/setup/status',
      { retryDelays },
    );
    // First retry after 1s (2^(1-1) * 1000 = 1000ms). Advance just past.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;
    expect(result.data.ok).toBe(true);
    expect(attempt).toBe(3);
    // Backoff must be 1s, 2s — exponential, no NaN, no zero, no negative.
    expect(retryDelays).toEqual([1_000, 2_000]);
  });

  it('exhausts retries on persistent 5xx and throws ApiError', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const alwaysFail = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        attempt += 1;
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, init: init ?? {} });
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: 'BOOM', message: 'no' } }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    ) as unknown as typeof fetch;
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: alwaysFail,
    });
    // H3 (CAP-041 fix): capture every delay the policy chose before each
    // retry so we can assert the backoff is exactly exponential with cap.
    const retryDelays: number[] = [];
    const promise = client.fetch('/api/v1/setup/status', { retryDelays });
    // Attach the rejection handler immediately so the unhandled rejection
    // filter (test-setup.ts) does not flag this as a leak.
    const settled = expect(promise).rejects.toBeInstanceOf(ApiError);
    // Drive the queue: 1s + 2s + 4s + 8s + 16s = 31s, but the policy
    // caps at 30s. We advance per-attempt.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(31_000);
    }
    await settled;
    expect(attempt).toBeGreaterThanOrEqual(3);
    // 5 retries, each with a delay capped at MAX_RETRY_DELAY (30s) and
    // exponentially backed from 1s. A regression producing [NaN, ...] or
    // [0, ...] would fail here.
    expect(retryDelays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it('does not retry on 400', async () => {
    const fetchMock = vi.fn(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'INVALID_INPUT', message: 'bad' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: fetchMock,
    });
    await expect(
      client.fetch('/api/v1/setup/claim', { method: 'POST', body: {} }),
    ).rejects.toBeInstanceOf(ApiError);
    expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it('throws ApiError with the envelope code on 4xx', async () => {
    const fetchMock = vi.fn(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'key reused',
              requestId: 'req-1',
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: fetchMock,
    });
    try {
      await client.fetch('/api/v1/setup/claim', { method: 'POST', body: {} });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      if (error instanceof ApiError) {
        expect(error.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(error.status).toBe(409);
        expect(error.requestId).toBe('req-1');
      }
    }
  });

  it('parses the JSON body and returns it as T', async () => {
    const fetchMock = vi.fn(
      () =>
        new Response(JSON.stringify({ data: { status: 'setup', currentStep: 'claim' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: fetchMock,
    });
    const result = await client.fetch<{
      data: { status: string; currentStep: string };
    }>('/api/v1/setup/status');
    expect(result.data.status).toBe('setup');
    expect(result.data.currentStep).toBe('claim');
  });

  // Security MEDIUM #5 (CAP-041 fix): the client enforces a 1 MB body
  // cap before fetch. Anything larger throws a typed ApiError. This
  // avoids a generic NetworkError from the browser.
  it('throws PAYLOAD_TOO_LARGE before fetch when body exceeds 1 MB', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: fetchMock,
    });
    const oversized = { blob: 'x'.repeat(2_000_000) };
    let caught: unknown = null;
    try {
      await client.fetch('/api/v1/messages/send', {
        method: 'POST',
        body: oversized,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    if (caught instanceof ApiError) {
      expect(caught.code).toBe('PAYLOAD_TOO_LARGE');
      expect(caught.status).toBe(413);
    }
    // The cap fires BEFORE the fetch — the mock is not called.
    expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});