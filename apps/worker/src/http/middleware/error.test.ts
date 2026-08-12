// error.test.ts — unit tests for the error middleware.
// Covers all four branches: DomainError, ZodError, SyntaxError, unknown.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DomainError } from '../../platform/errors';
import { errorMiddleware } from './error';

// Helper: invoke the middleware and parse the response.
async function runMiddleware(err: unknown) {
  // The middleware ignores the context (_c), so we can pass a minimal stub.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = { json: vi.fn() } as any;
  const result = errorMiddleware(err as Error, c);
  expect(result).toBeInstanceOf(Response);
  const body = await (result as Response).json();
  return { status: (result as Response).status, body };
}

describe('errorMiddleware', () => {
  it('maps DomainError to its httpStatus', async () => {
    const err = new DomainError({
      code: 'SETUP_CLAIM_INVALID_TOKEN',
      message: 'Invalid installation token',
      httpStatus: 401,
    });
    const { status, body } = await runMiddleware(err);
    expect(status).toBe(401);
    expect(body).toEqual({
      error: { code: 'SETUP_CLAIM_INVALID_TOKEN', message: 'Invalid installation token' },
    });
  });

  it('maps DomainError without httpStatus to 500', async () => {
    const err = new DomainError({
      code: 'SOMETHING_WRONG',
      message: 'No status set',
    });
    const { status, body } = await runMiddleware(err);
    expect(status).toBe(500);
    expect(body.error.code).toBe('SOMETHING_WRONG');
  });

  it('maps ZodError to 400 VALIDATION_ERROR', async () => {
    const schema = z.object({ token: z.string().min(1) });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const { status, body } = await runMiddleware(result.error);
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('Required');
    }
  });

  it('maps SyntaxError to 400 VALIDATION_ERROR', async () => {
    const err = new SyntaxError('Unexpected token in JSON');
    const { status, body } = await runMiddleware(err);
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid JSON');
  });

  it('maps unknown Error to 500 INTERNAL', async () => {
    // Silence console.error for this test — the middleware logs the error.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('something broke');
    const { status, body } = await runMiddleware(err);
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
    // The unknown-error path should log.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('maps non-Error thrown value to 500 INTERNAL', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, body } = await runMiddleware('string error');
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL');
    spy.mockRestore();
  });
});
