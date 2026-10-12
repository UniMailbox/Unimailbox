import { Hono } from 'hono';
import { aiReplyRequestSchema } from '@unimailbox/contracts';
import { buildAppContext } from '../../app-context';
import { generateAiReply } from '../../modules/messages';
import { sha256Hex } from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';

export function aiReplyRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post(
    '/mailboxes/:mailboxId/ai-reply',
    requirePermission('message.read'),
    requirePermission('message.send'),
    requireIdempotencyKey,
    async (c) => {
      const actorUserId = c.get('userId');
      const idempotencyKey = c.get('idempotencyKey');
      if (!actorUserId || !idempotencyKey)
        throw new Error('Missing authenticated mutation context');
      const mailboxId = c.req.param('mailboxId');
      const raw = await c.req.text();
      const request = parseJsonBody(raw, aiReplyRequestSchema, {
        event: 'ai.reply.invalid_json',
        actorUserId,
      });
      const context = buildAppContext(c.env);
      const response = await generateAiReply(
        {
          db: c.env.DB,
          ai: context.ai,
          auditEventWriter: context.auditEventWriter,
        },
        {
          actorUserId,
          mailboxId,
          request,
          idempotencyKey,
          requestHash: await sha256Hex(JSON.stringify({ mailboxId, body: raw })),
          requestId: c.get('requestId') ?? '<unknown>',
        },
      );
      return new Response(response.responseJson, {
        status: response.responseStatus,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    },
  );
  return routes;
}
