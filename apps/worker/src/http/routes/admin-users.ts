// http/routes/admin-users — CAP-044 Slice 3 (AC 17). Hono sub-app for
// the admin users-list API.
//
// GET /api/v1/admin/users — keyset cursor pagination over the identity
// module's users table (newest first), consumed by the web admin Users
// page.
//
// D-CAP-044-H: the users table is identity-owned; this route calls the
// identity module's public `listUsers` through the allowed
// admin → identity edge — the only new module code in identity for this
// slice. No cross-module table access.
//
// R-AUTHZ-001/002: requires the closed-enum 'user.read' permission,
// checked against the database per request via requirePermission.
// R-AUTHZ-005: the permission rides roles, never a hardcoded identity
// list.
// R-SECRET-003 / AC 16: the response carries NO credential material —
// the repository enumerates exactly the five non-credential columns and
// the contracts schema is .strict(), so a leaked password column cannot
// parse client-side either. Asserted by a dedicated worker test that
// walks every key of the serialized JSON against
// /password|salt|hash|credential|secret|token/i (the users table's
// credential columns are password_algorithm, password_iterations,
// password_salt, password_hash — none may ever leave the repository).

import { Hono } from 'hono';
import { requirePermission } from '../middleware/authz';
import { listUsers, UserCursorInvalidError, UserRowInvalidError } from '../../modules/identity';
import { userListQueryParamsSchema } from '@unimailbox/contracts';
import { parseCursorSigningKey } from '../../platform/config';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';

export function adminUserRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * GET /api/v1/admin/users
   *
   * Query (all optional; validated by userListQueryParamsSchema from
   * contracts — a ZodError surfaces as 400 VALIDATION_ERROR via the
   * error middleware):
   *   cursor — opaque HMAC-signed cursor from a prior page (surface
   *            'admin-users'; a cursor from another paginated API is a
   *            400, R-API-005)
   *   limit  — page size, default 50, clamped to 50 in the repository
   *
   * Response: `{ data: { items, nextCursor } }` (R-API-004/005) where
   * each item is `{ id, email, displayName, status, createdAt }` —
   * nothing else (AC 16).
   *
   * - Requires authn + requirePermission('user.read')
   */
  routes.get('/admin/users', requirePermission('user.read'), async (c) => {
    const params = userListQueryParamsSchema.parse(c.req.query());

    // R-API-005: resolve the HMAC key from the Secrets Store binding. A
    // missing key fails closed via the ConfigError path in platform/config.
    const cursorSigningKey = await parseCursorSigningKey(c.env);

    try {
      const result = await listUsers(c.env.DB, {
        ...(params.cursor !== undefined && { cursor: params.cursor }),
        ...(params.limit !== undefined && { limit: params.limit }),
        cursorSigningKey,
      });
      return c.json({ data: result });
    } catch (error) {
      // R-API-005: a tampered, malformed, or cross-surface cursor
      // surfaces as a single stable 400 INVALID_CURSOR. Malformed and
      // tampered tokens are observationally equivalent; one code keeps
      // the surface stable.
      if (error instanceof UserCursorInvalidError) {
        throw new DomainError({
          code: 'INVALID_CURSOR',
          message: 'The supplied cursor is invalid or has been tampered with',
          httpStatus: 400,
        });
      }
      // Fix (d), the CAP-044 Slice 2 fix (b) precedent: a stored row
      // violated the read contract (status outside the closed
      // users.status enum). Surface the corruption as a visible 500
      // with the dedicated USER_ROW_INVALID code (registry granted in
      // this fix pass) instead of returning a page the client cannot
      // parse; never skipped silently.
      if (error instanceof UserRowInvalidError) {
        throw new DomainError({
          code: 'USER_ROW_INVALID',
          message: 'A user row failed validation; the users table may be corrupt',
          httpStatus: 500,
        });
      }
      throw error;
    }
  });

  return routes;
}
