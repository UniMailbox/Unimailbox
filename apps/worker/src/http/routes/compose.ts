import { Hono } from 'hono';
import { buildAppContext } from '../../app-context';
import type { AppEnv } from '../../platform/env';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { operationResponse } from '../operation-response';
import { submitMessage } from '../../modules/outbound-mail';
import { getAttachmentByteStore, getAttachmentObjectStore } from '../../platform/cache';
export function composeRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post(
    '/mailboxes/:mailboxId/messages/send',
    requirePermission('message.send'),
    requireIdempotencyKey,
    async (c) =>
      operationResponse(
        await submitMessage(
          {
            ...buildAppContext(c.env),
            outbound: c.env.OUTBOUND,
            attachmentByteStore: getAttachmentByteStore(c.env),
            attachmentObjectStore: getAttachmentObjectStore(c.env),
          },
          {
            actorUserId: c.get('userId'),
            rawBody: await c.req.text(),
            idempotencyKey: c.get('idempotencyKey'),
            requestId: c.get('requestId'),
            mailboxId: c.req.param('mailboxId'),
            origin: c.req.url,
          },
        ),
      ),
  );
  return routes;
}
