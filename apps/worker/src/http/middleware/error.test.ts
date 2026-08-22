// error.test.ts — unit tests for the error middleware.
// CAP-032 / R-API-001: every branch emits the canonical envelope
// `{ error: { code, message, requestId } }`.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Hono } from 'hono';
import { DomainError } from '../../platform/errors';
import { errorMiddleware } from './error';
import { requestId } from './request-id';
import type { AppEnv } from '../../platform/env';

// Helper: build a Hono app that mounts requestId + errorMiddleware, then
// dispatch a route that throws the supplied error. Lets us assert the
// full envelope shape end-to-end (status, code, message, requestId).
async function runViaApp(err: unknown): Promise<{
  status: number;
  body: { error: { code: string; message: string; requestId: string } };
  response: Response;
}> {
  const app = new Hono<AppEnv>();
  app.use('*', requestId);
  app.onError(errorMiddleware);
  app.get('/throw', () => {
    throw err;
  });
  const response = await app.request('http://localhost/throw');
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };
  return { status: response.status, body, response };
}

// Helper: invoke the middleware directly with a stub Context. Used by
// tests that need to verify the `c.get('requestId')` fallback when the
// middleware did not run (AC5).
function runDirect(err: unknown, requestId: string | undefined) {
  // Minimal Context stub — only `get('requestId')` is exercised by the
  // middleware in these tests.
  const c = { get: (_k: 'requestId') => requestId } as unknown as Parameters<
    typeof errorMiddleware
  >[1];
  const result = errorMiddleware(err as Error, c);
  return result as Response;
}

describe('errorMiddleware', () => {
  describe('DomainError branch (R-API-001)', () => {
    it('maps DomainError to its httpStatus and emits the canonical envelope', async () => {
      const { status, body } = await runViaApp(
        new DomainError({
          code: 'SETUP_CLAIM_INVALID_TOKEN',
          message: 'Invalid installation token',
          httpStatus: 401,
        }),
      );
      expect(status).toBe(401);
      expect(body.error.code).toBe('SETUP_CLAIM_INVALID_TOKEN');
      expect(body.error.message).toBe('Invalid installation token');
      // R-API-001: requestId is mandatory.
      expect(body.error.requestId).toEqual(expect.any(String));
    });

    it('maps DomainError without httpStatus to 500 INTERNAL', async () => {
      const { status, body } = await runViaApp(
        new DomainError({
          code: 'INTERNAL',
          message: 'No status set',
        }),
      );
      expect(status).toBe(500);
      expect(body.error.code).toBe('INTERNAL');
    });
  });

  describe('ZodError branch (R-API-001)', () => {
    it('maps ZodError to 400 VALIDATION_ERROR', async () => {
      const schema = z.object({ token: z.string().min(1) });
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        const { status, body } = await runViaApp(result.error);
        expect(status).toBe(400);
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toBe('Required');
        expect(body.error.requestId).toEqual(expect.any(String));
      }
    });
  });

  describe('SyntaxError branch (R-INPUT-002 fallback)', () => {
    it('maps SyntaxError to 400 VALIDATION_ERROR', async () => {
      const err = new SyntaxError('Unexpected token in JSON');
      const { status, body } = await runViaApp(err);
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('Invalid JSON');
      expect(body.error.requestId).toEqual(expect.any(String));
    });
  });

  describe('unknown branch (R-API-001)', () => {
    it('maps unknown Error to 500 INTERNAL and logs', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { status, body } = await runViaApp(new Error('something broke'));
      expect(status).toBe(500);
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.message).toBe('Internal server error');
      expect(body.error.requestId).toEqual(expect.any(String));
      // The unknown-error path should log.
      expect(spy).toHaveBeenCalledWith('[error-middleware] unhandled error:', expect.any(Error));
      spy.mockRestore();
    });
  });

  describe('AC5 — defence in depth: missing requestId falls back to <unknown>', () => {
    it('propagates a real requestId through to the envelope', async () => {
      const response = runDirect(
        new DomainError({ code: 'INTERNAL', message: 'with id', httpStatus: 500 }),
        'some-uuid-aaaa-bbbb',
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as {
        error: { code: string; message: string; requestId: string };
      };
      expect(body.error.requestId).toBe('some-uuid-aaaa-bbbb');
      expect(response.headers.get('X-Request-Id')).toBe('some-uuid-aaaa-bbbb');
    });

    it('emits requestId "<unknown>" when c.get("requestId") is undefined', async () => {
      const response = runDirect(
        new DomainError({
          code: 'INTERNAL',
          message: 'no middleware ran',
          httpStatus: 500,
        }),
        undefined,
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as {
        error: { code: string; message: string; requestId: string };
      };
      expect(body.error.requestId).toBe('<unknown>');
      expect(response.headers.get('X-Request-Id')).toBeNull();
    });
  });
});
