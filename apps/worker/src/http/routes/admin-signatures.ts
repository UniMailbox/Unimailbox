// http/routes/admin-signatures — CAP-068.
// Transport/authentication boundary for the per-domain signature resource.
// Signature administration owns validation-independent business invariants;
// this route only parses the request and maps the use-case response.

import { Hono, type Context } from 'hono';
import {
  createSignatureRequestSchema,
  updateSignatureRequestSchema,
  uuidSchema,
} from '@unimailbox/contracts';
import {
  createAdminSignature,
  deleteAdminSignature,
  listAdminSignatures,
  updateAdminSignature,
} from '../../modules/signatures';
import { createAuditEventWriter } from '../../modules/admin';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { sha256Hex } from '../../platform/idempotency';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import { parseJsonBody } from '../middleware/parse-json-body';

export function adminSignatureRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/admin/signatures', requirePermission('signature.read'), async (c) => {
    const signatures = await listAdminSignatures(c.env.DB);
    return c.json({ data: { items: signatures } });
  });

  routes.post(
    '/admin/signatures',
    requirePermission('signature.manage'),
    requireIdempotencyKey,
    async (c) => {
      const actorUserId = requireUserId(c);
      const idempotencyKey = requireKey(c);
      const rawBody = await c.req.text();
      const body = parseJsonBody(rawBody, createSignatureRequestSchema, {
        event: 'admin.signature.create.invalid_json',
        actorUserId,
      });
      const result = await createAdminSignature(
        {
          db: c.env.DB,
          auditEventWriter: createAuditEventWriter(c.env.DB),
        },
        {
          actorUserId,
          request: body,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash: await sha256Hex(rawBody),
        },
      );
      return jsonResult(result.responseJson, result.status, c.get('requestId') ?? null);
    },
  );

  routes.patch(
    '/admin/signatures/:id',
    requirePermission('signature.manage'),
    requireIdempotencyKey,
    async (c) => {
      const actorUserId = requireUserId(c);
      const signatureId = requireSignatureId(c);
      const idempotencyKey = requireKey(c);
      const expectedUpdatedAt = requireSignatureIfMatch(c);
      const rawBody = await c.req.text();
      const body = parseJsonBody(rawBody, updateSignatureRequestSchema, {
        event: 'admin.signature.update.invalid_json',
        actorUserId,
      });
      const result = await updateAdminSignature(
        {
          db: c.env.DB,
          auditEventWriter: createAuditEventWriter(c.env.DB),
        },
        {
          actorUserId,
          signatureId,
          request: body,
          expectedUpdatedAt,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash: await sha256Hex(rawBody),
        },
      );
      return jsonResult(result.responseJson, result.status, c.get('requestId') ?? null);
    },
  );

  routes.delete(
    '/admin/signatures/:id',
    requirePermission('signature.manage'),
    requireIdempotencyKey,
    async (c) => {
      const actorUserId = requireUserId(c);
      const signatureId = requireSignatureId(c);
      const idempotencyKey = requireKey(c);
      const rawBody = await c.req.text();
      const result = await deleteAdminSignature(
        {
          db: c.env.DB,
          auditEventWriter: createAuditEventWriter(c.env.DB),
        },
        {
          actorUserId,
          signatureId,
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

function requireSignatureId(c: Context<AppEnv>): string {
  const id = c.req.param('id');
  if (!id || !uuidSchema.safeParse(id).success) {
    throw new DomainError({
      code: 'VALIDATION_ERROR',
      message: 'signature id must be a UUID',
      httpStatus: 400,
    });
  }
  return id;
}

const SIGNATURE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function requireSignatureIfMatch(c: Context<AppEnv>): string {
  const value = c.req.header('If-Match');
  if (value === undefined) {
    throw new DomainError({
      code: 'IF_MATCH_REQUIRED',
      message: 'If-Match header required',
      httpStatus: 400,
    });
  }
  const trimmed = value.trim();
  if (!SIGNATURE_TIMESTAMP_PATTERN.test(trimmed)) {
    throw new DomainError({
      code: 'IF_MATCH_INVALID',
      message: 'If-Match header must match YYYY-MM-DD HH:MM:SS exactly',
      httpStatus: 400,
    });
  }
  return trimmed;
}

function jsonResult(responseJson: string, status: 200 | 201, requestId: string | null): Response {
  return new Response(responseJson, {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(requestId === null ? {} : { 'X-Request-Id': requestId }),
    },
  });
}
