// error middleware — maps DomainError → HTTP status, ZodError → 400, unknown → 500.
// CAP-008 implements the real error mapping (replacing the CAP-001 stub).
import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import type { AppEnv } from '../../platform/env';
import { DomainError } from '../../platform/errors';

export const errorMiddleware: ErrorHandler<AppEnv> = (err, _c) => {
  // Handle ZodError (validation failures from schema.parse at the route boundary)
  if (err instanceof ZodError) {
    return Response.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: err.errors[0]?.message ?? 'Validation failed',
        },
      },
      { status: 400 },
    );
  }

  // Handle DomainError (application errors with known HTTP status)
  if (err instanceof DomainError) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.httpStatus ?? 500 },
    );
  }

  // Handle SyntaxError (JSON parsing failures from c.req.json())
  if (err instanceof SyntaxError) {
    return Response.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid JSON',
        },
      },
      { status: 400 },
    );
  }

  // Unknown errors → 500. Log so production 500s are visible.
  // TODO: replace with structured logger once requestId middleware is real
  // (D-CAP-006-B) and include requestId in the error envelope (API conventions).
  console.error('[error-middleware] unhandled error:', err);

  return Response.json(
    { error: { code: 'INTERNAL', message: 'Internal server error' } },
    { status: 500 },
  );
};
