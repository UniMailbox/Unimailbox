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
//
// CAP-050 extends the same D1 batch with attachment-consume rows. The
// ordering is load-bearing (see `statements` below):
//
//   1. messages row
//   2. message_recipients (to + cc)
//   3. mailbox_messages
//   4. message_attachments INSERTs — must precede (5) so the
//      `message_attachments_upload_consumable` BEFORE INSERT trigger
//      observes the pre-transition `status='uploaded'` row.
//   5. UPDATE attachment_uploads ... SET status='consumed' — the
//      `attachment_uploads_consume_once` trigger prevents any second
//      transition from a non-`uploaded` state.
//   6. outbound_jobs
//   7. message.send audit
//   8. attachment.consumed audit per upload (R-AUDIT-001)
//   9. idempotency_records
//
// The route preflights every attachmentUploadId against D1 metadata
// (authorising against the path mailbox and authenticated actor) and
// against the live CACHE bytes (length must equal the D1 metadata)
// BEFORE the batch begins. Any of the four unavailable conditions
// (missing, foreign, expired, already-consumed, KV-missing or
// length-mismatched) collapses to the single stable
// ATTACHMENT_UPLOAD_NOT_FOUND 400 envelope so we never disclose
// ownership or lifecycle details to the caller.

import { Hono } from 'hono';
import { composeRequestSchema } from '@unimailbox/contracts';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { assertCan, findMailboxById } from '../../modules/tenancy';
import { checkPermission, prepareCreateAuditEvent } from '../../modules/admin';
import { prepareCreateOutboundJob } from '../../modules/outbound-mail';
import {
  createMessageWithRelations,
  listAttachmentUploadsForConsume,
  prepareConsumeAttachmentUpload,
  prepareCreateMessageAttachment,
  type AttachmentUploadForConsumeRow,
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
  isIdempotencyUniqueViolation,
  replayAfterRace,
} from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';
import { getAttachmentByteStore } from '../../platform/cache';
import { parseJsonBody } from '../middleware/parse-json-body';

const SEND_OPERATION = 'POST /api/v1/mailboxes/:mailboxId/messages/send';

/** CAP-050 — stable surface for any "this upload is unusable" preflight. */
function throwAttachmentUnavailable(): never {
  throw new DomainError({
    code: 'ATTACHMENT_UPLOAD_NOT_FOUND',
    message: 'One or more attachment uploads are unavailable',
    httpStatus: 400,
  });
}

/**
 * CAP-050 — a UNIQUE-violation message that names `message_attachments`
 * is the consume-race signature (the second of two concurrent compose
 * requests trying to attach the same upload). Distinct from the
 * idempotency_records race that `isIdempotencyUniqueViolation` already
 * recognises — that helper explicitly checks for the
 * `idempotency_records` table name in the error text. We do not want a
 * concurrent double-consume to be mis-routed through `replayAfterRace`,
 * which would return a 202 carrying a *different* messageId than the
 * caller's. The right surface is the same stable
 * ATTACHMENT_UPLOAD_NOT_FOUND envelope as the preflight, so the caller
 * can retry with a fresh upload (or omit the attachment).
 */
function isMessageAttachmentsUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes('UNIQUE constraint failed') &&
    error.message.includes('message_attachments')
  );
}

/**
 * CAP-050 — the `message_attachments_upload_consumable` BEFORE INSERT
 * trigger raises `ATTACHMENT_UPLOAD_NOT_CONSUMABLE` when an INSERT
 * observes an upload row whose `status` is no longer `uploaded` (a
 * sibling request won the consume race first). The trigger is the
 * schema-layer guarantee behind R-ATTACHMENT-006 for the same-key
 * concurrent case where the message_attachments UNIQUE is also about
 * to fire; depending on statement ordering within the batch, D1 may
 * surface one constraint or the other. Both map to the same race
 * handling in the route's catch — replay the winner if the keys
 * match, otherwise ATTACHMENT_UPLOAD_NOT_FOUND.
 *
 * The check is scoped to the specific error code raised by the
 * migration 0022 trigger on purpose — a generic `SQLITE_CONSTRAINT_TRIGGER`
 * could come from a sabotage / sibling trigger and must keep propagating
 * as its own failure (not be mis-routed through the consume-race replay).
 */
function isAttachmentUploadNotConsumableTrigger(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes('ATTACHMENT_UPLOAD_NOT_CONSUMABLE');
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
      const connection = await c.env.DB.prepare(
        "SELECT id FROM provider_connections WHERE status = 'active' ORDER BY created_at ASC LIMIT 1",
      ).first<{ id: string }>();
      if (!connection) {
        throw new DomainError({
          code: 'PROVIDER_CONNECTION_NOT_FOUND',
          message: 'No active provider connection',
          httpStatus: 409,
        });
      }

      // CAP-050: preflight every requested upload against D1 metadata
      // (ownership + mailbox + live `uploaded` state) and against the
      // matching CACHE bytes (length must equal the D1 metadata). A
      // failure on either check collapses to ATTACHMENT_UPLOAD_NOT_FOUND
      // with no D1 writes and no queue enqueue — we keep the upload in
      // its original `uploaded` state for the caller to retry / re-upload.
      const attachmentUploadIds = body.attachmentUploadIds ?? [];
      let attachmentRows: ReadonlyArray<AttachmentUploadForConsumeRow> = [];
      if (attachmentUploadIds.length > 0) {
        const preflight = await listAttachmentUploadsForConsume(c.env.DB, {
          uploadIds: attachmentUploadIds,
          expectedOwnerUserId: userId,
          expectedMailboxId: mailboxId,
          now: sqliteTimestamp(systemClock.now()),
        });
        if (preflight.kind === 'missing') {
          throwAttachmentUnavailable();
        }
        attachmentRows = preflight.rows;
        // KV byte-length verification — R-ATTACHMENT-003 / R-ATTACHMENT-005.
        // Bytes that are absent, garbage-collected, TTL-expired, or whose
        // length does not match the D1 size_bytes all collapse to the same
        // stable envelope. CAP-049 CAP-051 owns KV cleanup, so we never
        // delete here.
        const attachmentByteStore = getAttachmentByteStore(c.env);
        for (const row of attachmentRows) {
          const bytes = await attachmentByteStore.get(row.kvKey);
          if (!bytes || bytes.byteLength !== row.sizeBytes) {
            throwAttachmentUnavailable();
          }
        }
      }

      const now = sqliteTimestamp(systemClock.now());
      const messageId = systemIds.uuid();
      const jobId = systemIds.uuid();
      const idempotencyRecordId = systemIds.uuid();
      const idempotencyNow = sqliteTimestamp(systemClock.now());
      const auditEventId = systemIds.uuid();
      const attachmentAuditEventIds = attachmentRows.map(() => systemIds.uuid());
      const messageAttachmentIds = attachmentRows.map(() => systemIds.uuid());
      // CAP-046 / D-CAP-046-A: pull the request correlation UUID the
      // request-id middleware stamped on this request so the audit row
      // carries it through.
      const requestId = c.get('requestId') ?? null;

      // Build the success body up front so we can store the exact same JSON
      // the client will receive on a replay.
      const successBody = JSON.stringify({
        data: { messageId, status: 'queued' },
      });

      // R-OUTBOUND-006: every row that must exist for the queue consumer to
      // send the message is written in one D1 batch. If any statement fails,
      // D1 rolls the whole batch back — no orphaned 'queued' message. The
      // idempotency record is appended to the same batch (R-API-004).
      // CAP-046 / D-CAP-046-B: the audit row is folded into the same D1
      // batch so a crash between the message INSERT and the audit row
      // cannot leave the message without its audit entry (R-AUDIT-001).
      const statements: D1PreparedStatement[] = [
        // 1. Message row, status 'queued', from the mailbox address.
        // CAP-030 D-CAP-030-D: this INSERT path intentionally bypasses the
        // CAP-030 direction guard (`updateMessageStatus`'s
        // `status IN (SELECT value FROM json_each(?))` clause). The row
        // has no prior state on insert — there is no `from` to gate — so
        // the guard is vacuously satisfied. The `messages.status` CHECK
        // constraint (migration 0006_messages.sql) is the safety net:
        // 'queued' is the only value this writer produces, and the CHECK
        // rejects any other literal at the schema layer. Do NOT route
        // this INSERT through `updateMessageStatus` to "fix" the gap —
        // the gate is correct as-is and routing it would change the
        // atomicity semantics (R-OUTBOUND-006 batch).
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
        // 5. CAP-050 message_attachments INSERTs — must come BEFORE the
        // consume UPDATE so the BEFORE INSERT trigger observes the
        // pre-transition `status='uploaded'` row. Any missing / expired
        // / already-consumed / wrong-owner upload is rejected here at
        // the schema layer (migration 0022) before any UPDATE fires.
        ...attachmentRows.map((row, index) => {
          const attachId = messageAttachmentIds[index];
          if (!attachId) {
            throw new Error('messageAttachmentIds index out of range');
          }
          return prepareCreateMessageAttachment(c.env.DB, {
            id: attachId,
            messageId,
            uploadId: row.uploadId,
            objectKey: row.kvKey,
            filename: row.filename,
            contentType: row.contentType,
            sizeBytes: row.sizeBytes,
            disposition: row.disposition,
            contentId: null,
            sha256: null,
            createdAt: now,
          });
        }),
        // 6. CAP-050 consume UPDATEs — upload `uploaded` → `consumed`.
        // The BEFORE UPDATE OF status trigger
        // (`attachment_uploads_consume_once`) refuses any non-`uploaded`
        // transition, so a stale row cannot re-stamp `consumed_at`.
        ...attachmentRows.map((row) =>
          prepareConsumeAttachmentUpload(c.env.DB, {
            uploadId: row.uploadId,
            consumedAt: now,
          }),
        ),
        // 7. Outbound job — the bridge to the queue consumer.
        prepareCreateOutboundJob(c.env.DB, {
          id: jobId,
          messageId,
          providerConnectionId: connection.id,
          createdAt: now,
          updatedAt: now,
        }),
        // 8. message.send audit row (R-AUDIT-001) — folded into the same
        // batch so the message INSERT and the audit entry land atomically.
        prepareCreateAuditEvent(c.env.DB, {
          id: auditEventId,
          actorUserId: userId,
          action: 'message.send',
          resourceType: 'message',
          resourceId: messageId,
          requestId,
          createdAt: now,
        }),
        // 9. CAP-050 attachment.consumed audit rows — one per consumed
        // upload (R-AUDIT-001). Metadata is intentionally empty so we
        // never leak filenames, bytes, or KV keys into the audit log
        // (R-LOG-001 / R-SECRET-003). The resourceId is the upload ID
        // so an investigator can pivot from the audit row back to the
        // still-`consumed` attachment_uploads row.
        ...attachmentRows.map((row, index) => {
          const auditId = attachmentAuditEventIds[index];
          if (!auditId) {
            throw new Error('attachmentAuditEventIds index out of range');
          }
          return prepareCreateAuditEvent(c.env.DB, {
            id: auditId,
            actorUserId: userId,
            action: 'attachment.consumed',
            resourceType: 'attachment_upload',
            resourceId: row.uploadId,
            requestId,
            createdAt: now,
          });
        }),
        // 10. Idempotency record (R-API-004, R-OUTBOUND-006).
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
        // CAP-050 race routing: three constraints can fire here for the
        // same logical race — two concurrent compose requests with the
        // same Idempotency-Key, or two concurrent requests that raced on
        // the same attachment upload:
        //   - idempotency_records UNIQUE → idem-race
        //   - message_attachments.upload_id UNIQUE → consume-race
        //   - message_attachments_upload_consumable trigger → consume-race
        //     (the trigger fires when the INSERT observes a `consumed`
        //     upload row because a sibling request won the race first)
        //
        // In all three cases the right answer is to replay the winner's
        // response if one exists under the same key (same-key concurrent).
        // If no winner exists — i.e. the upload was consumed by a request
        // carrying a *different* Idempotency-Key — the caller never saw
        // the bytes, and we surface ATTACHMENT_UPLOAD_NOT_FOUND instead
        // of the generic 409 IDEMPOTENCY_CONFLICT, so the caller cannot
        // distinguish a true upload race from a wrong-key retry.
        const isConsumeRace =
          isMessageAttachmentsUniqueViolation(error) ||
          isAttachmentUploadNotConsumableTrigger(error);
        const isIdempotencyRace = isIdempotencyUniqueViolation(error);
        if (isConsumeRace || isIdempotencyRace) {
          try {
            return replayAfterRace(c.env.DB, userId, SEND_OPERATION, idempotencyKey, requestHash);
          } catch (raceReplayError) {
            // No matching idempotency record — the upload was consumed by
            // a request with a *different* Idempotency-Key (or the trigger
            // fired for some other reason). For a consume-race that is the
            // canonical "already consumed" outcome; collapse to the same
            // stable envelope as the preflight.
            if (isConsumeRace) {
              throwAttachmentUnavailable();
            }
            throw raceReplayError;
          }
        }
        throw error;
      }

      // Hand the job to the queue. The consumer (entrypoints/queue.ts) reads
      // the job, decrypts the credential, calls the adapter, and updates
      // message + job status.
      await c.env.OUTBOUND.send(JSON.stringify({ jobId }));

      return new Response(successBody, {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  return routes;
}
