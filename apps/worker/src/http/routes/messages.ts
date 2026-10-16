// Read routes retain transport pagination; mutations delegate to mailbox-authorized use cases.
import { operationResponse } from '../operation-response';

import { messageFolderSchema } from '@unimailbox/contracts';
import { Hono, type Context } from 'hono';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { assertCan } from '../../modules/tenancy';
import {
  listMessagesByMailbox,
  getMessageDetail,
  getMessageThread,
  CursorInvalidError,
  markRead,
  toggleStar,
  softDeleteMessage,
} from '../../modules/messages';
import { DomainError } from '../../platform/errors';

import { parseCursorSigningKey } from '../../platform/config';
import { buildAppContext } from '../../app-context';
import type { AppEnv } from '../../platform/env';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

async function requireMailboxReadAccess(c: Context<AppEnv>, mailboxId: string): Promise<string> {
  const userId = c.get('userId');
  if (!userId) {
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  }

  await assertCan(c.env.DB, userId, mailboxId, 'read');

  return userId;
}

export function messageRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/mailboxes/:mailboxId/messages', requirePermission('message.read'), async (c) => {
    const mailboxId = c.req.param('mailboxId');

    const userId = await requireMailboxReadAccess(c, mailboxId);

    const cursor = c.req.query('cursor') || undefined;
    const rawFolder = c.req.query('folder');
    const folderResult = messageFolderSchema.safeParse(rawFolder ?? 'inbox');
    if (!folderResult.success) {
      throw new DomainError({
        code: 'VALIDATION_ERROR',
        message: 'Invalid folder',
        httpStatus: 400,
      });
    }
    const requestedLimit = parseInt(c.req.query('limit') ?? String(DEFAULT_LIMIT), 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const cursorSigningKey = await parseCursorSigningKey(c.env);

    let result;
    try {
      result = await listMessagesByMailbox(c.env.DB, mailboxId, userId, {
        ...(cursor !== undefined && { cursor }),
        limit,
        folder: folderResult.data,
        cursorSigningKey,
      });
    } catch (error) {
      if (error instanceof CursorInvalidError) {
        throw new DomainError({
          code: 'INVALID_CURSOR',
          message: 'The supplied cursor is invalid or has been tampered with',
          httpStatus: 400,
        });
      }
      throw error;
    }
    return c.json({ data: result });
  });

  routes.get(
    '/mailboxes/:mailboxId/messages/:messageId',
    requirePermission('message.read'),
    async (c) => {
      const mailboxId = c.req.param('mailboxId');
      const messageId = c.req.param('messageId');
      const userId = await requireMailboxReadAccess(c, mailboxId);

      const message = await getMessageDetail(c.env.DB, mailboxId, messageId, userId);
      if (!message) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }
      return c.json({ data: message });
    },
  );

  routes.get(
    '/mailboxes/:mailboxId/messages/:messageId/thread',
    requirePermission('message.read'),
    async (c) => {
      const mailboxId = c.req.param('mailboxId');
      const messageId = c.req.param('messageId');
      const userId = await requireMailboxReadAccess(c, mailboxId);

      const thread = await getMessageThread(c.env.DB, mailboxId, messageId, userId);
      if (!thread) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }
      return c.json({ data: thread });
    },
  );

  routes.patch(
    '/mailboxes/:mailboxId/messages/:messageId/read',
    requirePermission('message.read'),
    requireIdempotencyKey,
    async (c) =>
      operationResponse(
        await markRead(buildAppContext(c.env), {
          actorUserId: c.get('userId'),
          rawBody: await c.req.text(),
          idempotencyKey: c.get('idempotencyKey'),
          requestId: c.get('requestId'),
          mailboxId: c.req.param('mailboxId'),
          messageId: c.req.param('messageId'),
        }),
      ),
  );

  routes.patch(
    '/mailboxes/:mailboxId/messages/:messageId/star',
    requirePermission('message.read'),
    requireIdempotencyKey,
    async (c) =>
      operationResponse(
        await toggleStar(buildAppContext(c.env), {
          actorUserId: c.get('userId'),
          rawBody: await c.req.text(),
          idempotencyKey: c.get('idempotencyKey'),
          requestId: c.get('requestId'),
          mailboxId: c.req.param('mailboxId'),
          messageId: c.req.param('messageId'),
        }),
        c.get('requestId'),
      ),
  );

  routes.delete(
    '/mailboxes/:mailboxId/messages/:messageId',
    requirePermission('message.read'),
    requireIdempotencyKey,
    async (c) =>
      operationResponse(
        await softDeleteMessage(buildAppContext(c.env), {
          actorUserId: c.get('userId'),
          rawBody: await c.req.text(),
          idempotencyKey: c.get('idempotencyKey'),
          requestId: c.get('requestId'),
          mailboxId: c.req.param('mailboxId'),
          messageId: c.req.param('messageId'),
        }),
      ),
  );

  return routes;
}
