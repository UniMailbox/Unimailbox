// apps/web — API error envelope tests.
//
// CAP-041 AC #19: the deliverable includes tests for every pure module
// in the API infrastructure. `errors.ts` carries the typed `ApiError`
// and the tolerant `parseErrorBody` — both must behave per R-API-002
// (stable machine code).
import { describe, expect, it } from 'vitest';
import { ApiError, parseErrorBody } from './errors';

describe('ApiError', () => {
  it('carries the stable code, status, and optional requestId', () => {
    const err = new ApiError('INVALID_INPUT', 'bad', 400, 'req-1');
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.status).toBe(400);
    expect(err.requestId).toBe('req-1');
    expect(err.message).toBe('bad');
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
  });

  it('omits requestId when not provided', () => {
    const err = new ApiError('BOOM', 'no', 500);
    // The class declares `requestId` as a field; with
    // useDefineForClassFields the field is always present on the
    // instance, but the value is left undefined when not provided.
    expect(err.requestId).toBeUndefined();
  });

  it('is distinguishable from generic Error', () => {
    const err = new ApiError('CODE', 'msg', 409);
    expect(err instanceof ApiError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe('parseErrorBody', () => {
  it('parses a well-formed envelope and returns the code/message/requestId', async () => {
    const response = new Response(
      JSON.stringify({
        error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'key reused', requestId: 'req-2' },
      }),
      { status: 409, headers: { 'x-request-id': 'req-2' } },
    );
    const parsed = await parseErrorBody(response);
    expect(parsed.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(parsed.message).toBe('key reused');
    expect(parsed.requestId).toBe('req-2');
  });

  it('falls back to HTTP_ERROR on non-JSON bodies', async () => {
    const response = new Response('not json', {
      status: 502,
      headers: { 'x-request-id': 'req-fallback' },
    });
    const parsed = await parseErrorBody(response);
    expect(parsed.code).toBe('HTTP_ERROR');
    expect(parsed.message).toContain('502');
    expect(parsed.requestId).toBe('req-fallback');
  });

  it('falls back when the JSON envelope is malformed', async () => {
    const response = new Response(JSON.stringify({ notError: true }), {
      status: 400,
    });
    const parsed = await parseErrorBody(response);
    expect(parsed.code).toBe('HTTP_ERROR');
    expect(parsed.message).toContain('400');
  });

  it('falls back when fields are missing or wrong types', async () => {
    const response = new Response(JSON.stringify({ error: { code: 42, message: null } }), {
      status: 400,
    });
    const parsed = await parseErrorBody(response);
    expect(parsed.code).toBe('HTTP_ERROR');
    expect(parsed.message).toContain('400');
  });

  it('tolerates an empty body', async () => {
    const response = new Response('', { status: 500 });
    const parsed = await parseErrorBody(response);
    expect(parsed.code).toBe('HTTP_ERROR');
    expect(parsed.message).toContain('500');
  });
});
