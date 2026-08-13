// http/routes/messages — CAP-022 inbox routes.
// Hono sub-app for /api/v1/mailboxes/:mailboxId/messages endpoints: list, detail, mark-read.
//
// R-AUTHZ-003: Two layers — requirePermission('message.read') on every route,
// then mailbox-scoped assertCan(..., 'read', isAdmin) inside the handler.
// R-AUTHZ-004: assertCan authorises against the path's mailboxId, never a client
// body value.
// R-MESSAGE-005: isRead resolves per requesting user (see message-read-repository).
// R-API-004: PATCH /messages/:id/read requires Idempotency-Key; replays return
// the stored response.

import { Hono } from 'hono';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { assertCan } from '../../modules/tenancy';
import { checkPermission } from '../../modules/admin';
import {
  listMessagesByMailbox,
  getMessageDetail,
  markMessageAsRead,
} from '../../modules/messages';
import { systemIds } from '../../platform/ids';
import { systemClock } from '../../platform/clock';
import { DomainError } from '../../platform/errors';
import {
  findIdempotencyRecord,
  prepareCreateIdempotencyRecord,
  replayResponse,
  assertSameRequestHash,
  sha256Hex,
  sqliteTimestamp,
} from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';

const MARK_READ_OPERATION =
  'PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

export function messageRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * GET /api/v1/mailboxes/:mailboxId/messages
   *
   * Cursor-paginated inbox list, newest first.
   *
   * Query:
   *   cursor — opaque base64 cursor returned by a prior page (optional)
   *   limit  — page size, default 50, clamped to 50
   */
  routes.get(
    '/mailboxes/:mailboxId/messages',
    requirePermission('message.read'),
    async (c) => {
      const userId = c.get('userId');
      if (!userId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }

      const mailboxId = c.req.param('mailboxId');
      const cursor = c.req.query('cursor') || undefined;
      const requestedLimit = parseInt(c.req.query('limit') ?? String(DEFAULT_LIMIT), 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

      // R-AUTHZ-003: global permission already checked by middleware; now the
      // mailbox-scoped check. R-AUTHZ-005: admin bypass flows through
      // checkPermission('role.manage').
      const isAdmin = await checkPermission(c.env.DB, userId, 'role.manage');
      await assertCan(c.env.DB, userId, mailboxId, 'read', isAdmin);

      const result = await listMessagesByMailbox(c.env.DB, mailboxId, userId, {
        ...(cursor !== undefined && { cursor }),
        limit,
      });
      return c.json({ data: result });
    },
  );

  /**
   * GET /api/v1/mailboxes/:mailboxId/messages/:messageId
   *
   * Single message detail, including bodies and recipients.
   */
  routes.get(
    '/mailboxes/:mailboxId/messages/:messageId',
    requirePermission('message.read'),
    async (c) => {
      const userId = c.get('userId');
      if (!userId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }

      const mailboxId = c.req.param('mailboxId');
      const messageId = c.req.param('messageId');

      const isAdmin = await checkPermission(c.env.DB, userId, 'role.manage');
      await assertCan(c.env.DB, userId, mailboxId, 'read', isAdmin);

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

  /**
   * PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read
   *
   * Marks the message as read for the requesting user (R-MESSAGE-005).
   * Idempotent: re-marking a read message returns 200 with no change.
   *
   * Idempotency (R-API-004):
   *   - requireIdempotencyKey middleware enforces header presence + format.
   *   - Before markMessageAsRead (which is itself an atomic D1 batch of two
   *     writes), look up an existing record. If found with matching hash,
   *     replay the stored response. If found with different hash, 409.
   *   - Strict-mode note: markMessageAsRead owns its batch internally and
   *     does not expose a hook to append the idempotency record. The route
   *     therefore does best-effort (record INSERT as a separate statement).
   *     Re-marking a read message is a no-op, so a retry between the batch
   *     and the record INSERT re-runs safely.
   */
  routes.patch(
    '/mailboxes/:mailboxId/messages/:messageId/read',
    requirePermission('message.read'),
    requireIdempotencyKey,
    async (c) => {
      const userId = c.get('userId');
      if (!userId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }

      const mailboxId = c.req.param('mailboxId');
      const messageId = c.req.param('messageId');

      const isAdmin = await checkPermission(c.env.DB, userId, 'role.manage');
      await assertCan(c.env.DB, userId, mailboxId, 'read', isAdmin);

      // PATCH has no required body; allow an empty body and hash the bytes
      // we received (a missing body becomes ""). Clients retrying with a
      // different Idempotency-Key always start a fresh record.
      const rawBody = await c.req.text();
      const requestHash = await sha256Hex(rawBody);

      const idempotencyKey = c.get('idempotencyKey');
      if (!idempotencyKey) {
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }

      const existing = await findIdempotencyRecord(
        c.env.DB,
        userId,
        MARK_READ_OPERATION,
        idempotencyKey,
      );
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return replayResponse(existing);
      }

      // Resolve the mailbox_message row for this mailbox+message pair. The
      // mailbox-scoped assertCan above already guarantees access to the mailbox;
      // a missing row here means the message is simply not in this mailbox.
      const mailboxMessage = await c.env.DB
        .prepare(
          'SELECT id FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ?',
        )
        .bind(mailboxId, messageId)
        .first<{ id: string }>();

      if (!mailboxMessage) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      await markMessageAsRead(c.env.DB, mailboxMessage.id, userId);

      const now = sqliteTimestamp(systemClock.now());
      const successBody = JSON.stringify({ data: { ok: true } });

      await prepareCreateIdempotencyRecord(c.env.DB, {
        id: systemIds.uuid(),
        actorId: userId,
        operation: MARK_READ_OPERATION,
        idempotencyKey,
        requestHash,
        responseStatus: 200,
        responseJson: successBody,
        createdAt: now,
      }).run();

      return new Response(successBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  return routes;
}
