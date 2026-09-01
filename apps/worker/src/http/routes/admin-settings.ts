// http/routes/admin-settings — CAP-069.
//
// Transport/authentication boundary for the global typed settings resource.
// The route does not accept a resource id because this is a single-install
// global projection, not a tenant-scoped object.

import { Hono, type Context } from 'hono';
import { updateSystemSettingsRequestSchema } from '@unimailbox/contracts';
import {
  checkPermission,
  getAdminSystemSettings,
  updateAdminSystemSettings,
} from '../../modules/admin';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';
import { sha256Hex } from '../../platform/idempotency';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';

export function adminSettingsRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/admin/settings', requirePermission('settings.read'), async (c) => {
    const actorUserId = requireUserId(c);
    const canManage = await checkPermission(c.env.DB, actorUserId, 'settings.manage');
    const settings = await getAdminSystemSettings(c.env.DB, {
      environment: c.get('config')?.environment ?? c.env.ENVIRONMENT ?? 'local',
      canManage,
    });
    return c.json({ data: settings });
  });

  routes.patch(
    '/admin/settings',
    requirePermission('settings.manage'),
    requireIdempotencyKey,
    async (c) => {
      const actorUserId = requireUserId(c);
      const idempotencyKey = requireKey(c);
      const expectedUpdatedAt = requireSettingsIfMatch(c);
      const rawBody = await c.req.text();
      const request = parseJsonBody(rawBody, updateSystemSettingsRequestSchema, {
        event: 'admin.settings.update.invalid_json',
        actorUserId,
      });
      const result = await updateAdminSystemSettings(
        {
          db: c.env.DB,
        },
        {
          actorUserId,
          request,
          expectedUpdatedAt,
          environment: c.get('config')?.environment ?? c.env.ENVIRONMENT ?? 'local',
          canManage: true,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash: await sha256Hex(rawBody),
        },
      );
      return jsonResult(result.responseJson, result.status, c.get('requestId') ?? null);
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

const SETTINGS_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function requireSettingsIfMatch(c: Context<AppEnv>): string {
  const value = c.req.header('If-Match');
  if (value === undefined) {
    throw new DomainError({
      code: 'IF_MATCH_REQUIRED',
      message: 'If-Match header required',
      httpStatus: 400,
    });
  }
  const trimmed = value.trim();
  if (!SETTINGS_TIMESTAMP_PATTERN.test(trimmed)) {
    throw new DomainError({
      code: 'IF_MATCH_INVALID',
      message: 'If-Match header must match YYYY-MM-DD HH:MM:SS exactly',
      httpStatus: 400,
    });
  }
  return trimmed;
}

function jsonResult(responseJson: string, status: 200, requestId: string | null): Response {
  return new Response(responseJson, {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(requestId === null ? {} : { 'X-Request-Id': requestId }),
    },
  });
}
