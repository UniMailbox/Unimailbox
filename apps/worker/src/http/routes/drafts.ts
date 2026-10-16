import { Hono } from 'hono';
import { buildAppContext } from '../../app-context';
import type { AppEnv } from '../../platform/env';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { operationResponse } from '../operation-response';
import { createDraft, readDraft, updateDraft } from '../../modules/messages';
import { sendDraft } from '../../modules/outbound-mail';
export function draftRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post(
    '/mailboxes/:mailboxId/drafts',
    requirePermission('message.send'),
    requireIdempotencyKey,
    async (c) =>
      operationResponse(
        await createDraft(buildAppContext(c.env), {
          actorUserId: c.get('userId'),
          rawBody: await c.req.text(),
          idempotencyKey: c.get('idempotencyKey'),
          requestId: c.get('requestId'),
          mailboxId: c.req.param('mailboxId'),
        }),
      ),
  );
  routes.get('/drafts/:draftId', requirePermission('message.read'), async (c) =>
    operationResponse(
      await readDraft(buildAppContext(c.env), {
        actorUserId: c.get('userId'),
        draftId: c.req.param('draftId'),
        mailboxId: c.req.query('mailboxId'),
      }),
    ),
  );
  routes.patch(
    '/drafts/:draftId',
    requirePermission('message.send'),
    requireIdempotencyKey,
    async (c) =>
      operationResponse(
        await updateDraft(buildAppContext(c.env), {
          actorUserId: c.get('userId'),
          rawBody: await c.req.text(),
          idempotencyKey: c.get('idempotencyKey'),
          requestId: c.get('requestId'),
          draftId: c.req.param('draftId'),
          ifMatch: c.req.header('If-Match'),
        }),
      ),
  );
  routes.post(
    '/drafts/:draftId/send',
    requirePermission('message.send'),
    requireIdempotencyKey,
    async (c) =>
      operationResponse(
        await sendDraft(
          { ...buildAppContext(c.env), outbound: c.env.OUTBOUND },
          {
            actorUserId: c.get('userId'),
            rawBody: await c.req.text(),
            idempotencyKey: c.get('idempotencyKey'),
            requestId: c.get('requestId'),
            draftId: c.req.param('draftId'),
          },
        ),
      ),
  );
  return routes;
}
