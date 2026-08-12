// error middleware — CAP-001 stub.
// DomainError → HTTP status mapping lands with the platform/errors module.
import type { ErrorHandler } from 'hono';
import type { AppEnv } from '../../platform/env';

export const errorMiddleware: ErrorHandler<AppEnv> = async (err, c) => {
  // CAP-001 stub — no Variables are set yet (request-id middleware is a no-op).
  // Real implementation reads c.get('requestId') once that middleware populates
  // a Variables<{ requestId: string }> type.
  return c.json(
    {
      error: {
        code: 'INTERNAL',
        message: 'error middleware not yet implemented',
      },
    },
    500,
  );
  // The argument is reserved for future DomainError → status mapping.
  void err;
};