// request-id.test.ts — AC4 / R-API-001 / CAP-032.
//
// Verifies the request-id middleware:
//   1. Generates a UUIDv4 per request.
//   2. Sets it on the Hono context as `requestId`.
//   3. Echoes it on the response as `X-Request-Id` header.
//   4. Two requests get DISTINCT ids (the middleware is request-scoped).
//   5. The same id appears in the response header AND in the error envelope
//      (cross-check with the error middleware).
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requestId } from './request-id';
import { errorMiddleware } from './error';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';

// UUIDv4 regex: 8-4-4-4-12 hex with the version nibble = 4.
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('requestId middleware (AC4)', () => {
  it('generates a UUIDv4 and stores it on the context', async () => {
    const app = new Hono<AppEnv>();
    let captured: string | undefined;
    app.use('*', requestId);
    app.get('/', (c) => {
      captured = c.get('requestId');
      return c.json({ ok: true });
    });

    const response = await app.request('http://localhost/');
    expect(response.status).toBe(200);
    expect(captured).toMatch(UUID_V4_REGEX);
  });

  it('sets the X-Request-Id response header to the same value', async () => {
    const app = new Hono<AppEnv>();
    let captured: string | undefined;
    app.use('*', requestId);
    app.get('/', (c) => {
      captured = c.get('requestId');
      return c.json({ ok: true });
    });

    const response = await app.request('http://localhost/');
    const header = response.headers.get('X-Request-Id');
    expect(header).toBeDefined();
    expect(header).toBe(captured);
    expect(header).toMatch(UUID_V4_REGEX);
  });

  it('produces a distinct id per request (no module-scoped state)', async () => {
    const app = new Hono<AppEnv>();
    const ids: Array<string | undefined> = [];
    app.use('*', requestId);
    app.get('/', (c) => {
      ids.push(c.get('requestId'));
      return c.json({ ok: true });
    });

    await app.request('http://localhost/');
    await app.request('http://localhost/');
    await app.request('http://localhost/');

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('the same id appears in the response header AND in the error envelope (AC4 cross-check)', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', requestId);
    app.onError(errorMiddleware);
    app.get('/throw', () => {
      throw new DomainError({
        code: 'INTERNAL',
        message: 'kaboom',
        httpStatus: 500,
      });
    });

    const response = await app.request('http://localhost/throw');
    const header = response.headers.get('X-Request-Id');
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    expect(header).toBeDefined();
    expect(header).toBe(body.error.requestId);
    expect(body.error.requestId).toMatch(UUID_V4_REGEX);
  });
});
