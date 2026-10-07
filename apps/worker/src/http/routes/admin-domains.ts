// http/routes/admin-domains — CAP-066.
// Admin managed-domain transport/authentication surface. Business writes and
// their audit/idempotency invariants live in the admin use case.

import { Hono, type Context } from 'hono';
import {
  createManagedDomainRequestSchema,
  updateManagedDomainOutboundConnectionRequestSchema,
  uuidSchema,
  verifyManagedDomainRequestSchema,
} from '@unimailbox/contracts';
import {
  createAdminManagedDomain,
  deleteAdminManagedDomain,
  listAdminManagedDomains,
  verifyAdminManagedDomain,
  updateAdminManagedDomainOutboundConnection,
} from '../../modules/admin';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { sha256Hex } from '../../platform/idempotency';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import { parseJsonBody } from '../middleware/parse-json-body';

export function adminDomainRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/admin/domains', requirePermission('domain.read'), async (c) => {
    const domains = await listAdminManagedDomains(c.env.DB);
    return c.json({ data: { items: domains } });
  });

  routes.post(
    '/admin/domains',
    requirePermission('domain.manage'),
    requireIdempotencyKey,
    async (c) => {
      const userId = requireUserId(c);
      const idempotencyKey = requireKey(c);
      const rawBody = await c.req.text();
      const body = parseJsonBody(rawBody, createManagedDomainRequestSchema, {
        event: 'admin.domain.create.invalid_json',
        actorUserId: userId,
      });
      const result = await createAdminManagedDomain(
        { db: c.env.DB },
        {
          actorUserId: userId,
          name: body.name,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash: await sha256Hex(rawBody),
        },
      );
      return jsonResult(result.responseJson, result.status);
    },
  );

  routes.patch(
    '/admin/domains/:id/outbound-connection',
    requirePermission('domain.manage'),
    requireIdempotencyKey,
    async (c) => {
      const actorUserId = requireUserId(c);
      const domainId = requireDomainId(c);
      const idempotencyKey = requireKey(c);
      const expectedUpdatedAt = requireIfMatch(c);
      const rawBody = await c.req.text();
      const body = parseJsonBody(rawBody, updateManagedDomainOutboundConnectionRequestSchema, {
        event: 'admin.domain.outbound_connection.invalid_json',
        actorUserId,
      });
      const result = await updateAdminManagedDomainOutboundConnection(
        { db: c.env.DB },
        {
          actorUserId,
          domainId,
          connectionId: body.connectionId,
          expectedUpdatedAt,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash: await sha256Hex(rawBody),
        },
      );
      return jsonResult(result.responseJson, result.status);
    },
  );

  routes.post(
    '/admin/domains/:id/verify',
    requirePermission('domain.manage'),
    requireIdempotencyKey,
    async (c) => {
      const userId = requireUserId(c);
      const domainId = requireDomainId(c);
      const idempotencyKey = requireKey(c);
      const rawBody = await c.req.text();
      parseJsonBody(rawBody, verifyManagedDomainRequestSchema, {
        event: 'admin.domain.verify.invalid_json',
        actorUserId: userId,
      });
      const result = await verifyAdminManagedDomain(
        { db: c.env.DB },
        {
          actorUserId: userId,
          domainId,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash: await sha256Hex(rawBody),
        },
      );
      return jsonResult(result.responseJson, result.status);
    },
  );

  routes.delete(
    '/admin/domains/:id',
    requirePermission('domain.manage'),
    requireIdempotencyKey,
    async (c) => {
      const userId = requireUserId(c);
      const domainId = requireDomainId(c);
      const idempotencyKey = requireKey(c);
      const rawBody = await c.req.text();
      const result = await deleteAdminManagedDomain(
        { db: c.env.DB },
        {
          actorUserId: userId,
          domainId,
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

function requireDomainId(c: Context<AppEnv>): string {
  const id = c.req.param('id');
  if (!id || !uuidSchema.safeParse(id).success) {
    throw new DomainError({
      code: 'VALIDATION_ERROR',
      message: 'domain id must be a UUID',
      httpStatus: 400,
    });
  }
  return id;
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function requireIfMatch(c: Context<AppEnv>): string {
  const value = c.req.header('If-Match');
  if (value === undefined) {
    throw new DomainError({
      code: 'IF_MATCH_REQUIRED',
      message: 'If-Match header required',
      httpStatus: 400,
    });
  }
  const trimmed = value.trim();
  if (!TIMESTAMP_PATTERN.test(trimmed)) {
    throw new DomainError({
      code: 'IF_MATCH_INVALID',
      message: 'If-Match header must match YYYY-MM-DD HH:MM:SS exactly',
      httpStatus: 400,
    });
  }
  return trimmed;
}

function jsonResult(responseJson: string, status: 200 | 201): Response {
  return new Response(responseJson, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
