import { Hono } from 'hono';
import { DomainError } from '../../platform/errors';
import { adminUserMailboxAccessRequestSchema, uuidSchema } from '@unimailbox/contracts';
import type { AppEnv } from '../../platform/env';
import { buildAppContext } from '../../app-context';
import { listUserMailboxAccess, setUserMailboxAccess } from '../../modules/tenancy';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';
import {
  isIdempotencyUniqueViolation,
  replayAfterRace,
  sha256Hex,
} from '../../platform/idempotency';

export function adminUserMailboxRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get(
    '/admin/mailboxes',
    requirePermission('user.read'),
    requirePermission('mailbox.share'),
    async (c) => {
      return c.json({ data: { items: await listUserMailboxAccess(c.env.DB, null, true) } });
    },
  );
  routes.get(
    '/admin/users/:id/mailboxes',
    requirePermission('user.read'),
    requirePermission('mailbox.share'),
    async (c) => {
      const userId = uuidSchema.parse(c.req.param('id'));
      return c.json({ data: { items: await listUserMailboxAccess(c.env.DB, userId, true) } });
    },
  );
  routes.put(
    '/admin/users/:id/mailboxes/:mailboxId',
    requirePermission('user.manage'),
    requirePermission('mailbox.share'),
    requireIdempotencyKey,
    async (c) => {
      const userId = uuidSchema.parse(c.req.param('id'));
      const mailboxId = uuidSchema.parse(c.req.param('mailboxId'));
      const actorUserId = c.get('userId');
      const idempotencyKey = c.get('idempotencyKey');
      if (!actorUserId)
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      if (!idempotencyKey)
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      const rawBody = await c.req.text();
      const request = parseJsonBody(rawBody, adminUserMailboxAccessRequestSchema, {
        event: 'admin.user_mailboxes.invalid_json',
        actorUserId,
      });
      const requestHash = await sha256Hex(JSON.stringify(request));
      try {
        const result = await setUserMailboxAccess(
          { db: c.env.DB, auditEventWriter: buildAppContext(c.env).auditEventWriter },
          {
            actorUserId,
            userId,
            mailboxId,
            hasGlobalShare: true,
            request,
            requestId: c.get('requestId') ?? null,
            idempotencyKey,
            requestHash,
          },
        );
        return new Response(result.responseJson, {
          status: result.status,
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': c.get('requestId') ?? '' },
        });
      } catch (error) {
        if (isIdempotencyUniqueViolation(error)) {
          const response = await replayAfterRace(
            c.env.DB,
            actorUserId,
            `PUT /api/v1/admin/users/${userId}/mailboxes/${mailboxId}`,
            idempotencyKey,
            requestHash,
          );
          response.headers.set('X-Request-Id', c.get('requestId') ?? '');
          return response;
        }
        throw error;
      }
    },
  );
  return routes;
}
