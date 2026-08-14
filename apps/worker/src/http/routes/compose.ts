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
// R-OUTBOUND-005: send requires Idempotency-Key; replays return the stored
// response.
// R-API-004: mutating endpoints accept Idempotency-Key; replays return
// the stored response.
//
// On success the route enqueues `{ jobId }` to the OUTBOUND queue and returns
// 202; the queue consumer (entrypoints/queue.ts) calls processOutboundJob,
// which decrypts the credential and calls the Brevo adapter.
//
// CAP-027 wires Idempotency-Key: the record INSERT is appended to the
// route's existing D1 batch so message + job + idempotency row land
// atomically.

import { Hono } from 'hono';
import { composeRequestSchema } from '@unimailbox/contracts';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { assertCan, findMailboxById } from '../../modules/tenancy';
import { checkPermission, createAuditEvent } from '../../modules/admin';
import { prepareCreateOutboundJob } from '../../modules/outbound-mail';
import { createMessageWithRelations } from '../../modules/messages';
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
  isIdempotencyUniqueViolation,
  replayAfterRace,
} from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';
import { parseJsonBody } from '../middleware/parse-json-body';

const SEND_OPERATION =
  'POST /api/v1/mailboxes/:mailboxId/messages/send';

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
   *
   * Idempotency (R-OUTBOUND-005, R-OUTBOUND-006, R-API-004):
   *   - requireIdempotencyKey middleware enforces header presence + format.
   *   - Before the D1 batch, look up the record. If present with a matching
   *     hash, replay the stored response (status + JSON).
   *   - If present with a different hash, throw 409 IDEMPOTENCY_KEY_REUSED.
   *   - Otherwise, append the record INSERT to the route's D1 batch so the
   *     idempotency row lands atomically with the message + job rows.
   */
  routes.post(
    '/mailboxes/:mailboxId/messages/send',
    requirePermission('message.send'),
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

      // R-AUTHZ-003: global permission already checked by middleware; now the
      // mailbox-scoped check. R-AUTHZ-005: admin bypass flows through
      // checkPermission('role.manage').
      const isAdmin = await checkPermission(c.env.DB, userId, 'role.manage');
      await assertCan(c.env.DB, userId, mailboxId, 'send', isAdmin);

      // Read the raw body so the SHA-256 hash is computed over the bytes
      // the client actually sent (a JSON re-serialise would change whitespace
      // and key order, breaking byte-equality replays — see .md §request_hash).
      const rawBody = await c.req.text();
      const requestHash = await sha256Hex(rawBody);

      // Idempotency replay lookup (before parsing — a replay must return the
      // stored response, not re-validate / re-execute).
      const idempotencyKey = c.get('idempotencyKey');
      if (!idempotencyKey) {
        // requireIdempotencyKey middleware should have rejected already;
        // defensive check for direct handler invocation.
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }

      const existing = await findIdempotencyRecord(
        c.env.DB,
        userId,
        SEND_OPERATION,
        idempotencyKey,
      );
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return replayResponse(existing);
      }

      // Parse + validate via helper. R-INPUT-002: malformed JSON returns
      // 400 INVALID_JSON before the D1 batch lands (no idempotency record,
      // so a corrected retry with the same Idempotency-Key succeeds).
      const body = parseJsonBody(rawBody, composeRequestSchema, {
        event: 'messages.send.invalid_json',
        actorUserId: userId,
      });

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

      const now = sqliteTimestamp(systemClock.now());
      const messageId = systemIds.uuid();
      const jobId = systemIds.uuid();
      const idempotencyRecordId = systemIds.uuid();
      const idempotencyNow = sqliteTimestamp(systemClock.now());

      // Build the success body up front so we can store the exact same JSON
      // the client will receive on a replay.
      const successBody = JSON.stringify({
        data: { messageId, status: 'queued' },
      });

      // R-OUTBOUND-006: every row that must exist for the queue consumer to
      // send the message is written in one D1 batch. If any statement fails,
      // D1 rolls the whole batch back — no orphaned 'queued' message. The
      // idempotency record is appended to the same batch (R-API-004).
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
        // 6. Idempotency record (R-API-004, R-OUTBOUND-006).
        prepareCreateIdempotencyRecord(c.env.DB, {
          id: idempotencyRecordId,
          actorId: userId,
          operation: SEND_OPERATION,
          idempotencyKey,
          requestHash,
          responseStatus: 202,
          responseJson: successBody,
          createdAt: idempotencyNow,
        }),
      ];

      try {
        await createMessageWithRelations(c.env.DB, statements);
      } catch (error) {
        // Fix 3: Handle UNIQUE-constraint race — two concurrent requests with
        // the same Idempotency-Key raced to INSERT. Re-read the winner's row
        // and replay it.
        if (isIdempotencyUniqueViolation(error)) {
          return replayAfterRace(
            c.env.DB,
            userId,
            SEND_OPERATION,
            idempotencyKey,
            requestHash,
          );
        }
        throw error;
      }

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

      return new Response(successBody, {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  return routes;
}
