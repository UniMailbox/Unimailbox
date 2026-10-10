import { Hono } from 'hono';
import { changeScheduledSendSchema, cancelScheduledSendSchema } from '@unimailbox/contracts';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';
import { listScheduledSends, changeScheduledSend } from '../../modules/outbound-mail';
import { CursorInvalidError } from '../../modules/messages';
import { parseCursorSigningKey } from '../../platform/config';
import { DomainError } from '../../platform/errors';
import { buildAppContext } from '../../app-context';
import type { AppEnv } from '../../platform/env';

export function scheduledSendRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get(
    '/mailboxes/:mailboxId/scheduled-sends',
    requirePermission('message.read'),
    async (c) => {
      const userId = c.get('userId');
      if (!userId)
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Sign in.',
          httpStatus: 401,
        });
      const cursor = c.req.query('cursor');
      try {
        const data = await listScheduledSends(c.env.DB, c.req.param('mailboxId'), userId, {
          cursorSigningKey: await parseCursorSigningKey(c.env),
          ...(cursor ? { cursor } : {}),
        });
        return c.json({ data });
      } catch (error) {
        if (error instanceof CursorInvalidError)
          throw new DomainError({
            code: 'INVALID_CURSOR',
            message: 'Invalid cursor.',
            httpStatus: 400,
          });
        throw error;
      }
    },
  );
  for (const cancelling of [false, true]) {
    const path = cancelling
      ? '/mailboxes/:mailboxId/scheduled-sends/:messageId/cancel'
      : '/mailboxes/:mailboxId/scheduled-sends/:messageId';
    routes.on(
      cancelling ? 'POST' : 'PATCH',
      path,
      requirePermission('message.send'),
      requireIdempotencyKey,
      async (c) => {
        const userId = c.get('userId');
        const key = c.get('idempotencyKey');
        if (!userId || !key)
          throw new DomainError({
            code: 'AUTHENTICATION_REQUIRED',
            message: 'Sign in.',
            httpStatus: 401,
          });
        const rawBody = await c.req.text();
        const common = {
          mailboxId: c.req.param('mailboxId'),
          messageId: c.req.param('messageId'),
          userId,
          idempotencyKey: key,
          rawBody,
          requestId: c.get('requestId') ?? null,
        };
        const input = cancelling
          ? {
              ...common,
              ...parseJsonBody(rawBody, cancelScheduledSendSchema, {
                event: 'scheduled.cancel.invalid_json',
                actorUserId: userId,
              }),
            }
          : {
              ...common,
              ...parseJsonBody(rawBody, changeScheduledSendSchema, {
                event: 'scheduled.change.invalid_json',
                actorUserId: userId,
              }),
            };
        return changeScheduledSend(
          {
            db: c.env.DB,
            outbound: c.env.OUTBOUND,
            audit: buildAppContext(c.env).auditEventWriter,
          },
          input,
        );
      },
    );
  }
  return routes;
}
