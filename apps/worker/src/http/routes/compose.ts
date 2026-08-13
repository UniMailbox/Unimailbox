// http/routes/compose — CAP-023 send endpoint.
// Hono sub-app for POST /api/v1/mailboxes/:mailboxId/messages/send.
//
// R-AUTHZ-003: Two layers — requirePermission('message.send') on the route,
// then mailbox-scoped assertCan(..., 'send', isAdmin) inside the handler.
// R-AUTHZ-004: assertCan authorises against the path's mailboxId, never a
// client-supplied owner ID.
// R-OUTBOUND-006: message + recipients + mailbox_message + outbound_jobs
// rows are written in one D1 batch so a crash between them cannot leave a
// 'queued' message with no job (or vice versa).
//
// On success the route enqueues `{ jobId }` to the OUTBOUND queue and returns
// 202; the queue consumer (entrypoints/queue.ts) calls processOutboundJob,
// which decrypts the credential and calls the Brevo adapter.

import { Hono } from 'hono';
import { composeRequestSchema } from '@unimailbox/contracts';
import { requirePermission } from '../middleware/authz';
import { assertCan, findMailboxById } from '../../modules/tenancy';
import { checkPermission, createAuditEvent } from '../../modules/admin';
import { prepareCreateOutboundJob } from '../../modules/outbound-mail';
import { createMessageWithRelations } from '../../modules/messages';
import { systemIds } from '../../platform/ids';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';

/**
 * SQLite datetime string: 'YYYY-MM-DD HH:MM:SS' UTC. Matches the migration's
 * DEFAULT (datetime('now')) and D1's existing rows.
 */
function sqliteNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export function composeRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * POST /api/v1/mailboxes/:mailboxId/messages/send
   *
   * Compose a reply or a new message. Persists the message with status
   * 'queued', creates an outbound_jobs row in the same D1 batch, and enqueues
   * the job for the queue consumer to send via the active provider connection.
   *
   * Returns 202 { data: { messageId, status: 'queued' } } — the message has
   * been accepted but not yet handed to the provider.
   */
  routes.post(
    '/mailboxes/:mailboxId/messages/send',
    requirePermission('message.send'),
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

      // R-AUTHZ-003: global permission already checked by middleware; now the
      // mailbox-scoped check. R-AUTHZ-005: admin bypass flows through
      // checkPermission('role.manage').
      const isAdmin = await checkPermission(c.env.DB, userId, 'role.manage');
      await assertCan(c.env.DB, userId, mailboxId, 'send', isAdmin);

      // Parse the body with the closed contract schema. composeRequestSchema
      // applies defaults for cc / subject / htmlBody / textBody.
      const body = composeRequestSchema.parse(await c.req.json());

      // Look up the mailbox so we can construct the from address and verify
      // it exists. findMailboxById returns the full localPart@domain.name.
      const mailbox = await findMailboxById(c.env.DB, mailboxId);
      if (!mailbox) {
        throw new DomainError({
          code: 'MAILBOX_NOT_FOUND',
          message: 'Mailbox not found',
          httpStatus: 404,
        });
      }

      // Resolve the active provider connection. There is exactly one outbound
      // provider in Phase 1 (Brevo); we pick the first 'active' row. CAP-024
      // will tighten this to the connection on the managed domain.
      const connection = await c.env.DB
        .prepare(
          "SELECT id FROM provider_connections WHERE status = 'active' ORDER BY created_at ASC LIMIT 1",
        )
        .first<{ id: string }>();
      if (!connection) {
        throw new DomainError({
          code: 'PROVIDER_CONNECTION_NOT_FOUND',
          message: 'No active provider connection',
          httpStatus: 409,
        });
      }

      const now = sqliteNow();
      const messageId = systemIds.uuid();
      const jobId = systemIds.uuid();

      // R-OUTBOUND-006: every row that must exist for the queue consumer to
      // send the message is written in one D1 batch. If any statement fails,
      // D1 rolls the whole batch back — no orphaned 'queued' message.
      const statements: D1PreparedStatement[] = [
        // 1. Message row, status 'queued', from the mailbox address.
        c.env.DB.prepare(
          `INSERT INTO messages (
             id, from_address, from_name, subject, html_body, text_body,
             message_id_header, in_reply_to_header, references_header,
             status, created_by_user_id, created_at, updated_at
           ) VALUES (?, ?, '', ?, ?, ?, NULL, ?, ?, 'queued', ?, ?, ?)`,
        ).bind(
          messageId,
          mailbox.address,
          body.subject,
          body.htmlBody,
          body.textBody,
          body.inReplyTo ?? null,
          body.references ?? '',
          userId,
          now,
          now,
        ),
        // 2. 'to' recipients.
        ...body.to.map((r) =>
          c.env.DB.prepare(
            `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
             VALUES (?, ?, ?, ?, 'to', ?)`,
          ).bind(systemIds.uuid(), messageId, r.address, r.displayName ?? '', now),
        ),
        // 3. 'cc' recipients (bcc is intentionally not exposed on compose).
        ...body.cc.map((r) =>
          c.env.DB.prepare(
            `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
             VALUES (?, ?, ?, ?, 'cc', ?)`,
          ).bind(systemIds.uuid(), messageId, r.address, r.displayName ?? '', now),
        ),
        // 4. Mailbox association. A composed message starts in 'sent' — it
        // represents the user's own outbound copy.
        c.env.DB.prepare(
          `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
           VALUES (?, ?, ?, 1, 0, 'sent', ?)`,
        ).bind(systemIds.uuid(), mailboxId, messageId, now),
        // 5. Outbound job — the bridge to the queue consumer.
        prepareCreateOutboundJob(c.env.DB, {
          id: jobId,
          messageId,
          providerConnectionId: connection.id,
          createdAt: now,
          updatedAt: now,
        }),
      ];

      await createMessageWithRelations(c.env.DB, statements);

      // Hand the job to the queue. The consumer (entrypoints/queue.ts) reads
      // the job, decrypts the credential, calls the adapter, and updates
      // message + job status.
      await c.env.OUTBOUND.send(JSON.stringify({ jobId }));

      // R-AUDIT-001: record the state transition.
      await createAuditEvent(c.env.DB, {
        id: systemIds.uuid(),
        actorUserId: userId,
        action: 'message.send',
        resourceType: 'message',
        resourceId: messageId,
        createdAt: now,
      });

      return c.json({ data: { messageId, status: 'queued' } }, 202);
    },
  );

  return routes;
}
