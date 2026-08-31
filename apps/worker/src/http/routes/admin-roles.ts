// http/routes/admin-roles — CAP-067.
//
// Transport/authentication boundary for role administration. The admin use
// case owns role writes, audit records, and idempotency; this route only
// validates input and maps the use-case response.

import { Hono, type Context } from 'hono';
import { createRoleRequestSchema, updateRoleRequestSchema } from '@unimailbox/contracts';
import {
  createAdminRole,
  deleteAdminRole,
  listAdminRoles,
  updateAdminRole,
} from '../../modules/admin';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { sha256Hex } from '../../platform/idempotency';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import { parseJsonBody } from '../middleware/parse-json-body';

export function adminRoleRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/admin/roles', requirePermission('role.read'), async (c) => {
    const result = await listAdminRoles(c.env.DB);
    return c.json({ data: result });
  });

  routes.post(
    '/admin/roles',
    requirePermission('role.manage'),
    requireIdempotencyKey,
    async (c) => {
      const userId = requireUserId(c);
      const idempotencyKey = requireKey(c);
      const rawBody = await c.req.text();
      const body = parseJsonBody(rawBody, createRoleRequestSchema, {
        event: 'admin.role.create.invalid_json',
        actorUserId: userId,
      });
      const result = await createAdminRole(
        { db: c.env.DB },
        {
          actorUserId: userId,
          name: body.name,
          description: body.description,
          permissionKeys: body.permissionKeys,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash: await sha256Hex(rawBody),
        },
      );
      return jsonResult(result.responseJson, result.status);
    },
  );

  routes.patch(
    '/admin/roles/:id',
    requirePermission('role.manage'),
    requireIdempotencyKey,
    async (c) => {
      const userId = requireUserId(c);
      const roleId = requireRoleId(c);
      const idempotencyKey = requireKey(c);
      const rawBody = await c.req.text();
      const body = parseJsonBody(rawBody, updateRoleRequestSchema, {
        event: 'admin.role.update.invalid_json',
        actorUserId: userId,
      });
      const result = await updateAdminRole(
        { db: c.env.DB },
        {
          roleId,
          actorUserId: userId,
          name: body.name,
          description: body.description,
          permissionKeys: body.permissionKeys,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash: await sha256Hex(rawBody),
        },
      );
      return jsonResult(result.responseJson, result.status);
    },
  );

  routes.delete(
    '/admin/roles/:id',
    requirePermission('role.manage'),
    requireIdempotencyKey,
    async (c) => {
      const userId = requireUserId(c);
      const roleId = requireRoleId(c);
      const idempotencyKey = requireKey(c);
      const rawBody = await c.req.text();
      const result = await deleteAdminRole(
        { db: c.env.DB },
        {
          roleId,
          actorUserId: userId,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash: await sha256Hex(rawBody),
        },
      );
      return jsonResult(result.responseJson, result.status);
    },
  );

  return routes;
}

function requireUserId(c: Context<AppEnv>): string {
  const userId = c.get('userId');
  if (!userId) {
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  }
  return userId;
}

function requireKey(c: Context<AppEnv>): string {
  const key = c.get('idempotencyKey');
  if (!key) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header required',
      httpStatus: 400,
    });
  }
  return key;
}

function requireRoleId(c: Context<AppEnv>): string {
  const roleId = c.req.param('id')?.trim();
  if (!roleId || roleId.length > 128) {
    throw new DomainError({
      code: 'VALIDATION_ERROR',
      message: 'role id path param required',
      httpStatus: 400,
    });
  }
  return roleId;
}

function jsonResult(responseJson: string, status: 200 | 201): Response {
  return new Response(responseJson, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
