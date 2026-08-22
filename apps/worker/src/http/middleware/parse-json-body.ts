// http/middleware/parse-json-body — CAP-031 / ADR-004 / D-CAP-037-A.
//
// Single helper that combines `JSON.parse` + zod schema parse for route
// handlers. Returns a parsed-and-validated object, or throws a typed
// `DomainError({ code: 'INVALID_JSON', httpStatus: 400 })` on bad JSON.
//
// Why this helper exists (R-INPUT-001, R-INPUT-002, R-API-004):
//
//   1. `JSON.parse(rawBody)` throws `SyntaxError` on malformed input.
//      Without a catch, the error falls into the error middleware's
//      SyntaxError branch and surfaces as `400 VALIDATION_ERROR` — a
//      generic code that hides the difference between "JSON malformed"
//      and "JSON valid but schema wrong".
//
//   2. More importantly, on a malformed request the route MUST NOT
//      write an `idempotency_records` row (D-CAP-037-A / R-API-004).
//      If `JSON.parse` throws *before* the D1 batch, no record lands
//      and the client can correct the body + retry with the same
//      Idempotency-Key. Centralising the JSON parse means the no-record
//      rule travels with the helper, not with every call site.
//
// Contract:
//   - `SyntaxError` → `DomainError({ code: 'INVALID_JSON', httpStatus: 400 })`
//     with a structured `logger.warn` (no body bytes — `.claude/rules/security.md`
//     §Logging forbids logging request bodies).
//   - `ZodError` is **not** caught here; it re-throwns so the error
//     middleware maps it to `400 VALIDATION_ERROR` as before. This keeps
//     the helper focused on JSON syntax, not schema structure. A future
//     change to that surface (CAP-032) is its own decision.

import { DomainError } from '../../platform/errors';
import { logger } from '../../platform/logger';

export interface ParseJsonBodyContext {
  readonly event: string;
  readonly actorUserId?: string;
}

export function parseJsonBody<T>(
  rawBody: string,
  schema: { parse(data: unknown): T },
  ctx: ParseJsonBodyContext,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    if (error instanceof SyntaxError) {
      // R-LOG-001: never log the body bytes. Event + actorUserId only.
      // LogFields has `actorUserId?: string` (not `string | undefined`),
      // so under `exactOptionalPropertyTypes` we must omit the field rather
      // than pass `undefined` explicitly.
      const fields: { event: string; actorUserId?: string } = {
        event: ctx.event,
      };
      if (ctx.actorUserId !== undefined) {
        fields.actorUserId = ctx.actorUserId;
      }
      logger.warn(fields);
      throw new DomainError({
        code: 'INVALID_JSON',
        message: 'Request body is not valid JSON',
        httpStatus: 400,
      });
    }
    throw error;
  }

  return schema.parse(parsed);
}
