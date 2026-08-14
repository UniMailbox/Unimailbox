// http/routes/admin-role-policies — D-CAP-021 / CAP-035.
// Hono sub-app for /api/v1/admin/roles/:id/policy endpoints.
//
// R-INBOUND-006: per-role policies (banEmail + availDomain). Empty arrays
// mean "allow all" for availDomain; banEmail is empty by default. Patterns
// are stored as JSON text — see migration's deferred-normalization comment.
//
// R-AUTHZ-001: requires 'role.manage' (matches the role-administration
// permission key from the closed enum).
//
// CAP-027 / ADR-004: writes enforce Idempotency-Key. Reads do not.

import { Hono } from 'hono';
import {
  setRolePolicyRequestSchema,
  type RolePolicy,
} from '@unimailbox/contracts';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import {
  getRolePolicy,
  prepareSetRolePolicy,
  prepareCreateAuditEvent,
} from '../../modules/admin';
import { systemIds } from '../../platform/ids';
import { systemClock } from '../../platform/clock';
import {
  sha256Hex,
  sqliteTimestamp,
  prepareCreateIdempotencyRecord,
  findIdempotencyRecord,
  assertSameRequestHash,
} from '../../platform/idempotency';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import { parseJsonBody } from '../middleware/parse-json-body';

export function adminRolePolicyRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // GET /api/v1/admin/roles/:id/policy
  routes.get(
    '/roles/:id/policy',
    requirePermission('role.manage'),
    async (c) => {
      const roleId = c.req.param('id');
      if (!roleId) {
        throw new DomainError({
          code: 'VALIDATION_ERROR',
          message: 'role id path param required',
          httpStatus: 400,
        });
      }

      const policy = await getRolePolicy(c.env.DB, roleId);
      if (!policy) {
        // Absent row is the implicit default — return 200 with empty
        // arrays rather than 404. The client treats empty availDomain as
        // "allow all" (BF-100); empty banEmail is the trivial default.
        const empty: RolePolicy = {
          roleId,
          banEmail: [],
          availDomain: [],
          updatedBy: null,
          updatedAt: '',
        };
        return c.json({ data: empty });
      }
      return c.json({ data: policy });
    },
  );

  // PUT /api/v1/admin/roles/:id/policy — replace both arrays atomically.
  routes.put(
    '/roles/:id/policy',
    requirePermission('role.manage'),
    requireIdempotencyKey,
    async (c) => {
      const userId = c.get('userId');
      if (!userId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }

      const roleId = c.req.param('id');
      if (!roleId) {
        throw new DomainError({
          code: 'VALIDATION_ERROR',
          message: 'role id path param required',
          httpStatus: 400,
        });
      }

      // H1: include the path roleId in the operation string so two PUTs
      // against different role ids do not share an idempotency record.
      // Different resources → different idempotency namespace.
      const operation = `PUT /api/v1/admin/roles/${roleId}/policy`;

      const idempotencyKey = c.get('idempotencyKey');
      if (!idempotencyKey) {
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }

      const rawBody = await c.req.text();
      const requestHash = await sha256Hex(rawBody);

      const existing = await findIdempotencyRecord(
        c.env.DB,
        userId,
        operation,
        idempotencyKey,
      );
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return new Response(existing.responseJson, {
          status: existing.responseStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // R-INPUT-002 / D-CAP-037-A: helper throws INVALID_JSON before the
      // D1 batch, so no idempotency_records row is written on malformed
      // bodies (a corrected retry with the same Idempotency-Key succeeds).
      const body = parseJsonBody(rawBody, setRolePolicyRequestSchema, {
        event: 'role_policy.put.invalid_json',
        actorUserId: userId,
      });

      const now = sqliteTimestamp(systemClock.now());

      const policy = {
        roleId,
        banEmail: [...body.banEmail],
        availDomain: [...body.availDomain],
        updatedBy: userId,
        updatedAt: now,
      };

      const responseJson = JSON.stringify({ data: policy });

      // R-AUDIT-001: every state transition writes an audit row. The
      // business write, the audit row, and the idempotency record all
      // land in one D1 batch so a crash between them cannot produce a
      // state change without the matching audit entry.
      await c.env.DB.batch([
        prepareSetRolePolicy(c.env.DB, {
          roleId,
          banEmail: body.banEmail,
          availDomain: body.availDomain,
          updatedBy: userId,
          updatedAt: now,
        }),
        prepareCreateAuditEvent(c.env.DB, {
          id: systemIds.uuid(),
          actorUserId: userId,
          action: 'role_policy.set',
          resourceType: 'role_policy',
          resourceId: roleId,
          createdAt: now,
        }),
        prepareCreateIdempotencyRecord(c.env.DB, {
          id: systemIds.uuid(),
          actorId: userId,
          operation,
          idempotencyKey,
          requestHash,
          responseStatus: 200,
          responseJson,
          createdAt: now,
        }),
      ]);

      return new Response(responseJson, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  return routes;
}