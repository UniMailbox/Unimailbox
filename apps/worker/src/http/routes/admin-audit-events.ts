// http/routes/admin-audit-events — CAP-044 Slice 2 (AC 10; CAP-033
// absorbed, D-CAP-044-E). Hono sub-app for the audit-event query API.
//
// GET /api/v1/admin/audit-events — composable filters + cursor pagination
// over the immutable audit trail.
//
// R-AUTHZ-001/002: requires the closed-enum 'audit.read' permission
// (D-CAP-044-D), checked against the database per request via
// requirePermission. R-AUTHZ-005: the permission rides the administrator
// role, never a hardcoded identity list.
// R-AUDIT-003/004: read-only surface — this route offers no mutation; rows
// are returned as stored (metadata stays the opaque JSON text).
// R-SECRET-003: no secret material is reachable through audit queries —
// metadata emitted by the reveal endpoint carries ids, not values.

import { Hono } from 'hono';
import { requirePermission } from '../middleware/authz';
import {
  queryAuditEvents,
  AuditCursorInvalidError,
  AuditRowInvalidError,
} from '../../modules/admin';
import { auditEventQueryParamsSchema } from '@unimailbox/contracts';
import { parseCursorSigningKey } from '../../platform/config';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';

export function adminAuditEventRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * GET /api/v1/admin/audit-events
   *
   * Query (all optional, composable; validated by
   * auditEventQueryParamsSchema from contracts — a ZodError surfaces as
   * 400 VALIDATION_ERROR via the error middleware):
   *   actorUserId   — uuid; events emitted by one actor
   *   resourceType + resourceId — PAIR; events on one resource. Supplying
   *                   one without the other is a 400 (the schema's refine).
   *   action        — one value of the closed AuditAction enum
   *   cursor        — opaque HMAC-signed cursor from a prior page
   *   limit         — page size, default 50, clamped to 50 in the repository
   *
   * Response: `{ data: { items, nextCursor } }` (R-API-004/005).
   *
   * - Requires authn + requirePermission('audit.read')
   */
  routes.get('/admin/audit-events', requirePermission('audit.read'), async (c) => {
    const params = auditEventQueryParamsSchema.parse(c.req.query());

    // R-API-005: resolve the HMAC key from the Secrets Store binding. A
    // missing key fails closed via the ConfigError path in platform/config.
    const cursorSigningKey = await parseCursorSigningKey(c.env);

    try {
      const result = await queryAuditEvents(
        c.env.DB,
        {
          ...(params.actorUserId !== undefined && { actorUserId: params.actorUserId }),
          ...(params.resourceType !== undefined && { resourceType: params.resourceType }),
          ...(params.resourceId !== undefined && { resourceId: params.resourceId }),
          ...(params.action !== undefined && { action: params.action }),
        },
        {
          ...(params.cursor !== undefined && { cursor: params.cursor }),
          ...(params.limit !== undefined && { limit: params.limit }),
          cursorSigningKey,
        },
      );
      return c.json({ data: result });
    } catch (error) {
      // R-API-005: a tampered or malformed cursor surfaces as a single
      // stable 400 INVALID_CURSOR. Malformed and tampered tokens are
      // observationally equivalent; one code keeps the surface stable.
      if (error instanceof AuditCursorInvalidError) {
        throw new DomainError({
          code: 'INVALID_CURSOR',
          message: 'The supplied cursor is invalid or has been tampered with',
          httpStatus: 400,
        });
      }
      // Fix pass (b): a stored row violated the read contract (action
      // outside the closed enum). The audit trail is forensic — surface
      // the corruption server-side with a stable code instead of
      // returning a page the client cannot parse. Never skipped silently.
      if (error instanceof AuditRowInvalidError) {
        throw new DomainError({
          code: 'AUDIT_ROW_INVALID',
          message: 'An audit event row failed validation; the audit trail may be corrupt',
          httpStatus: 500,
        });
      }
      throw error;
    }
  });

  return routes;
}
