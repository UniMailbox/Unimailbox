// http/routes/drafts — CAP-047 server-side create-draft vertical slice.
//
// POST /api/v1/mailboxes/:mailboxId/drafts — create a draft message.
//
// R-AUTHZ-003: Two layers — requirePermission('message.send') on the route,
// then mailbox-scoped assertCan(..., 'send', isAdmin) inside the handler.
// R-AUTHZ-004: assertCan authorises against the path's mailboxId, never a
// client-supplied owner ID. The sender is the authenticated user; the
// mailbox address is looked up from D1 and trusted as the canonical
// from_address (never a client-supplied sender).
// R-API-004 / ADR-004: create requires Idempotency-Key; replays return the
// stored 201 response. The same key + different bytes returns 409
// IDEMPOTENCY_KEY_REUSED via the platform replay helper.
// R-OUTBOUND-006 (adapted for drafts): message + recipients + mailbox_message
// + audit_event + idempotency row land in ONE D1 batch so a crash between
// them cannot leave an unaudited or unrecorded draft. The audit row is
// folded into the same batch via the existing `prepareCreateAuditEvent`
// helper (CAP-046 / D-CAP-046-B precedent from compose.ts).
// R-AUDIT-001: every state transition writes an audit_events row.
//
// The route does NOT enqueue a job. A draft persists with `status='draft'`
// and `mailbox_messages.folder='drafts'`; the queue consumer is only
// reached when the future PATCH/send slice promotes the row to 'queued'.
//
// On success returns 201 { data: { messageId, status: 'draft', updatedAt } }
// with a `Location: /api/v1/drafts/<messageId>` header. `updatedAt` is the
// same clock instant the DB columns were written — one instant, two
// formats: SQLite (`YYYY-MM-DD HH:MM:SS`) for the row, RFC-3339
// (`YYYY-MM-DDTHH:MM:SS.sssZ`) for the wire.

import { Hono } from 'hono';
import { createDraftSchema } from '@unimailbox/contracts';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { assertCan, findMailboxById } from '../../modules/tenancy';
import { checkPermission, prepareCreateAuditEvent } from '../../modules/admin';
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

const CREATE_DRAFT_OPERATION = 'POST /api/v1/mailboxes/:mailboxId/drafts';

/**
 * The generic idempotency helper restores the stored status and body. Draft
 * creation also promises a resource Location header, so restore that header
 * from the stored response on replay (including the race-loser path).
 */
async function replayDraftWithLocation(response: Response): Promise<Response> {
  const payload = (await response.clone().json()) as {
    data?: { messageId?: unknown };
  };
  if (typeof payload.data?.messageId === 'string') {
    response.headers.set('Location', `/api/v1/drafts/${payload.data.messageId}`);
  }
  return response;
}

export function draftRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * POST /api/v1/mailboxes/:mailboxId/drafts
   *
   * Create a draft message. Persists the message with status='draft',
   * creates one message_recipients row per `to` / `cc` / `bcc` address, a
   * mailbox_messages row with folder='drafts', an audit_events row
   * (`draft.created`, resource 'message', no body / recipient metadata),
   * and the idempotency record — all in one D1 batch.
   *
   * Returns 201 { data: { messageId, status: 'draft', updatedAt } } with a
   * `Location: /api/v1/drafts/<messageId>` header.
   *
   * Idempotency (R-API-004):
   *   - requireIdempotencyKey middleware enforces header presence + format.
   *   - Before the D1 batch, look up the record. If present with a matching
   *     hash, replay the stored response (status + JSON).
   *   - If present with a different hash, throw 409 IDEMPOTENCY_KEY_REUSED.
   *   - Otherwise, append the record INSERT to the route's D1 batch so the
   *     idempotency row lands atomically with the message + audit rows.
   *
   * Empty `to` is allowed: a draft may be authored before any recipient is
   * known. `cc` / `bcc` default to `[]` via the schema. Bodies over the
   * schema's wire ceilings are a stable 400 VALIDATION_ERROR (zod parses
   * through the error middleware, same posture as compose.ts).
   */
  routes.post(
    '/mailboxes/:mailboxId/drafts',
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
        CREATE_DRAFT_OPERATION,
        idempotencyKey,
      );
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return replayDraftWithLocation(replayResponse(existing));
      }

      // R-INPUT-002: malformed JSON returns 400 INVALID_JSON before the D1
      // batch lands (no idempotency record, so a corrected retry with the
      // same Idempotency-Key succeeds).
      const body = parseJsonBody(rawBody, createDraftSchema, {
        event: 'drafts.create.invalid_json',
        actorUserId: userId,
      });

      // Look up the mailbox so we can construct the from address and verify
      // it exists. findMailboxById returns the full localPart@domain.name;
      // we trust that, never a client-supplied sender (R-AUTHZ-004).
      const mailbox = await findMailboxById(c.env.DB, mailboxId);
      if (!mailbox) {
        throw new DomainError({
          code: 'MAILBOX_NOT_FOUND',
          message: 'Mailbox not found',
          httpStatus: 404,
        });
      }

      // One clock instant. The DB columns take the SQLite format
      // ('YYYY-MM-DD HH:MM:SS') — same shape as every other row in the table;
      // the wire response takes the RFC-3339 (ISO 8601) format.
      const nowDate = systemClock.now();
      const nowSqlite = sqliteTimestamp(nowDate);
      const nowWire = nowDate.toISOString();

      const messageId = systemIds.uuid();
      const auditEventId = systemIds.uuid();
      const idempotencyRecordId = systemIds.uuid();

      // CAP-046 / D-CAP-046-A: pull the request correlation UUID the
      // request-id middleware stamped on this request so the audit row
      // carries it through.
      const requestId = c.get('requestId') ?? null;

      // Build the success body up front so we can store the exact same JSON
      // the client will receive on a replay (R-API-004). The `Location`
      // header rides on the live response, not on the stored body — replays
      // must mirror the original 201 headers, so the location is added on
      // both paths below.
      const successBody = JSON.stringify({
        data: { messageId, status: 'draft', updatedAt: nowWire },
      });

      // CAP-047: every row that must exist for the draft to be visible is
      // written in one D1 batch. If any statement fails, D1 rolls the
      // whole batch back — no orphaned draft, no orphan audit row, no
      // orphan idempotency record.
      //
      // The schema default for `status` is 'delivered'; this writer
      // explicitly sets 'draft' (the `messages.status` CHECK constraint
      // covers both). `created_by_user_id` is the authenticated user, not
      // a client-supplied value. Bodies are stored verbatim on the wire
      // fields (snake_case `body_text` / `body_html` in the contracts
      // schema map to camelCase Drizzle columns — see insert statement).
      // Empty optional arrays are skipped so a draft with no recipients
      // doesn't write zero rows to message_recipients (which is allowed
      // by the schema: `type` is the required column, no NOT NULL on
      // the message-side).
      const statements: D1PreparedStatement[] = [
        // 1. Message row, status 'draft', from the mailbox address.
        c.env.DB.prepare(
          `INSERT INTO messages (
             id, from_address, from_name, subject, html_body, text_body,
             message_id_header, in_reply_to_header, references_header,
             status, created_by_user_id, created_at, updated_at
           ) VALUES (?, ?, '', ?, ?, ?, NULL, NULL, '', 'draft', ?, ?, ?)`,
        ).bind(
          messageId,
          mailbox.address,
          body.subject,
          body.body_html ?? '',
          body.body_text,
          userId,
          nowSqlite,
          nowSqlite,
        ),
        // 2. 'to' recipients.
        ...body.to.map((address) =>
          c.env.DB.prepare(
            `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
             VALUES (?, ?, ?, '', 'to', ?)`,
          ).bind(systemIds.uuid(), messageId, address, nowSqlite),
        ),
        // 3. 'cc' recipients.
        ...body.cc.map((address) =>
          c.env.DB.prepare(
            `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
             VALUES (?, ?, ?, '', 'cc', ?)`,
          ).bind(systemIds.uuid(), messageId, address, nowSqlite),
        ),
        // 4. 'bcc' recipients (compose.ts does not accept bcc; drafts do).
        ...body.bcc.map((address) =>
          c.env.DB.prepare(
            `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
             VALUES (?, ?, ?, '', 'bcc', ?)`,
          ).bind(systemIds.uuid(), messageId, address, nowSqlite),
        ),
        // 5. Mailbox association. A new draft lives in the 'drafts'
        // folder; is_read=1 because the author already saw it.
        c.env.DB.prepare(
          `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
           VALUES (?, ?, ?, 1, 0, 'drafts', ?)`,
        ).bind(systemIds.uuid(), mailboxId, messageId, nowSqlite),
        // 6. Audit row (R-AUDIT-001) — folded into the same batch so
        // the message INSERT and the audit entry land atomically. No
        // body / recipient metadata; the row records the action, the
        // resource, the actor, and the request id only.
        prepareCreateAuditEvent(c.env.DB, {
          id: auditEventId,
          actorUserId: userId,
          action: 'draft.created',
          resourceType: 'message',
          resourceId: messageId,
          requestId,
          createdAt: nowSqlite,
        }),
        // 7. Idempotency record (R-API-004).
        prepareCreateIdempotencyRecord(c.env.DB, {
          id: idempotencyRecordId,
          actorId: userId,
          operation: CREATE_DRAFT_OPERATION,
          idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseJson: successBody,
          createdAt: nowSqlite,
        }),
      ];

      try {
        await createMessageWithRelations(c.env.DB, statements);
      } catch (error) {
        // R-API-004: Handle UNIQUE-constraint race — two concurrent
        // requests with the same Idempotency-Key raced to INSERT. Re-read
        // the winner's row and replay it.
        if (isIdempotencyUniqueViolation(error)) {
          return replayDraftWithLocation(
            await replayAfterRace(
              c.env.DB,
              userId,
              CREATE_DRAFT_OPERATION,
              idempotencyKey,
              requestHash,
            ),
          );
        }
        throw error;
      }

      return new Response(successBody, {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          Location: `/api/v1/drafts/${messageId}`,
        },
      });
    },
  );

  return routes;
}
