// http/routes/drafts — CAP-047 server-side draft vertical slice.
//
// POST /api/v1/mailboxes/:mailboxId/drafts — create a draft message.
// GET  /api/v1/drafts/:draftId                       — read a draft.
//
// R-AUTHZ-003: Two layers — requirePermission on the route, then
// mailbox-scoped assertCan inside the handler. The CREATE route requires
// `message.send`; the GET route requires `message.read`.
// R-AUTHZ-004: assertCan authorises against the resolved mailboxId, never a
// client-supplied owner ID. The CREATE route resolves the mailbox from the
// path; the GET route resolves it from the messages⇄mailbox_messages join —
// the on-the-wire path carries no mailbox, so the row IS the authority. A
// foreign actor reading another mailbox's draft must receive the same
// 404 MESSAGE_NOT_FOUND envelope a non-existent ID would (no draft
// existence leak).
// R-API-004 / ADR-004: CREATE requires Idempotency-Key; replays return the
// stored 201 response. The same key + different bytes returns 409
// IDEMPOTENCY_KEY_REUSED via the platform replay helper.
// R-OUTBOUND-006 (adapted for drafts): CREATE folds message + recipients +
// mailbox_message + audit_event + idempotency row in ONE D1 batch so a
// crash between them cannot leave an unaudited or unrecorded draft. The
// audit row is folded via the existing `prepareCreateAuditEvent` helper
// (CAP-046 / D-CAP-046-B precedent from compose.ts).
// R-AUDIT-001: every state transition writes an audit_events row. The GET
// route is read-only — no idempotency record, no audit row, no recipient
// mutation, no queue call, no other write.
//
// The CREATE route does NOT enqueue a job. A draft persists with
// `status='draft'` and `mailbox_messages.folder='drafts'`; the queue
// consumer is only reached when the future PATCH/send slice promotes the
// row to 'queued'.
//
// On CREATION returns 201 { data: { messageId, status: 'draft', updatedAt } }
// with a `Location: /api/v1/drafts/<messageId>` header. `updatedAt` is the
// same clock instant the DB columns were written — one instant, two
// formats: SQLite (`YYYY-MM-DD HH:MM:SS`) for the row, RFC-3339
// (`YYYY-MM-DDTHH:MM:SS.sssZ`) for the wire.
//
// On READ returns 200 { data: { id, mailboxId, subject, body_text,
// body_html, to, cc, bcc, status, created_at, updated_at } } with the same
// RFC-3339 timestamp format and snake_case wire names (CAP-047 wire
// contract — D-CAP-047-contracts).

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

/**
 * Convert a SQLite datetime string (`YYYY-MM-DD HH:MM:SS`, UTC, the column
 * default for every datetime column this slice writes) into an RFC-3339
 * instant suitable for the wire (`YYYY-MM-DDTHH:MM:SS.sssZ`).
 *
 * SQLite stores the value as TEXT, and the `datetime('now')` default
 * returns UTC. The read route returns the stored `created_at` /
 * `updated_at` to the client, but keeps the wire format consistent with
 * the create response (which writes the same instant via
 * `Date#toISOString()` so the same RFC-3339 string is on both surfaces).
 *
 * `.000Z` is correct because the column is second-precision — a
 * representation of an already-rounded instant cannot carry
 * sub-millisecond truth, and `toISOString()` on the same Date would yield
 * the same suffix. A future migration to millisecond-precision columns
 * will need to read the fractional part here; this helper exists locally
 * so the read route never depends on the SQLite-storage-format leakage.
 *
 * The parser is strict: the input must be the documented `YYYY-MM-DD
 * HH:MM:SS` shape exactly. Any other shape — a malformed row, a stray
 * suffix, a stray prefix, the wrong separator — throws a 500 rather than
 * silently producing a double-suffixed or otherwise corrupted wire
 * string. The read path is read-only, so a malformed value surfaces as
 * an internal error rather than a 4xx (the contract is that the row
 * shape is well-known: we wrote it ourselves).
 */
const SQLITE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function sqliteTimestampToRFC3339(value: string): string {
  const match = SQLITE_DATETIME_RE.exec(value);
  if (!match) {
    throw new DomainError({
      code: 'INTERNAL',
      message: 'Malformed stored timestamp',
      httpStatus: 500,
    });
  }
  const [, year, month, day, hour, minute, second] = match;
  // The DB column is second-precision UTC; build the wire shape by hand
  // so we never append `.000Z` onto an already-suffixed or otherwise
  // pre-formatted string. `Z` is literal because the column default
  // `datetime('now')` returns UTC.
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
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

  /**
   * GET /api/v1/drafts/:draftId
   *
   * Read a single draft. Authorised against the RESOLVED mailboxId — the
   * path carries no mailbox, so the row's own mailbox_messages.mailbox_id
   * is the only authority (R-AUTHZ-004). A foreign actor reading another
   * mailbox's draft receives the same 404 MESSAGE_NOT_FOUND envelope as a
   * non-existent ID (no draft existence leak).
   *
   * Resolution: every `mailbox_messages` row that links the draft to a
   * mailbox, filtered by `messages.status='draft'`. A row whose status is
   * anything other than 'draft' (delivered, queued, sent, etc.) is NOT a
   * draft for this route and 404s the same way an unknown ID would. The
   * draft can have multiple mailbox associations (e.g. moved across
   * mailboxes); the route iterates every resolved mailbox and picks the
   * first one the actor is authorised to `read`. If none is authorised
   * the same 404 MESSAGE_NOT_FOUND envelope is returned — the existence
   * of any single association must not leak through the response.
   *
   * Authorization layering:
   *   1. `requirePermission('message.read')` middleware — global gate.
   *   2. `assertCan(actorUserId, resolvedMailboxId, 'read', isAdmin)`
   *      inside the handler, called once per resolved mailbox until one
   *      succeeds. R-AUTHZ-004: the mailboxId comes from the row, never
   *      the request.
   *
   * Read-only — no idempotency record, no audit row, no recipient mutation,
   * no queue call. A failed open transaction cannot happen because no
   * transaction is opened (read-only).
   *
   * Wire envelope: `{ data: { id, mailboxId, subject, body_text, body_html,
   * to, cc, bcc, status, created_at, updated_at } }`. Snake_case wire
   * names are preserved (`body_text`/`body_html`/`created_at`/`updated_at`)
   * per the CAP-047 wire contract (D-CAP-047-contracts — wire names must
   * not leak Drizzle column names across the contracts boundary). Bodies
   * come from `messages.text_body` / `messages.html_body`. Timestamps are
   * RFC-3339 (`YYYY-MM-DDTHH:MM:SS.sssZ`), produced from the stored
   * SQLite datetime via the local helper so the storage format is not
   * leaked to the wire. `to` / `cc` / `bcc` are arrays of normalized
   * address strings; empty arrays when a category has no rows. We do not
   * return audit metadata, message-id / reply / references headers, or
   * any other column that is not part of the wire contract.
   */
  routes.get('/drafts/:draftId', requirePermission('message.read'), async (c) => {
    const userId = c.get('userId');
    if (!userId) {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    const draftId = c.req.param('draftId');

    // R-AUTHZ-004: resolve the draft's mailbox associations, never a
    // client-supplied mailbox. Filtering on `m.status='draft'` makes
    // every non-draft existing message indistinguishable from a missing
    // ID — the same envelope a truly absent ID would surface (no
    // existence leak). All associations are fetched in one query so
    // the handler can iterate them and pick the first one the actor is
    // authorised to read; if none is authorised, the same 404 envelope
    // is returned (no association-existence leak). Ordering by
    // `mm.created_at ASC, mm.id ASC` is the same stable tiebreaker the
    // create route would have written with; LIMIT is intentionally NOT
    // applied here — the row's mailbox is authoritative only AFTER the
    // actor's read permission has been verified against it.
    // Parameterised SQL throughout — no string interpolation.
    const associations = await c.env.DB.prepare(
      `SELECT mm.mailbox_id AS mailbox_id,
              mm.id          AS mailbox_message_id,
              mm.created_at  AS mailbox_message_created_at
           FROM messages m
           JOIN mailbox_messages mm ON mm.message_id = m.id
          WHERE m.id = ?
            AND m.status = 'draft'
       ORDER BY mm.created_at ASC, mm.id ASC`,
    )
      .bind(draftId)
      .all<{
        mailbox_id: string;
        mailbox_message_id: string;
        mailbox_message_created_at: string;
      }>();

    const associationRows = associations.results ?? [];

    // A missing ID, an ID whose `messages.status` is not 'draft', or an
    // ID with no mailbox association all collapse to the same envelope
    // — that is the whole point of the existence-leak posture.
    if (associationRows.length === 0) {
      throw new DomainError({
        code: 'MESSAGE_NOT_FOUND',
        message: 'Message not found',
        httpStatus: 404,
      });
    }

    // R-AUTHZ-004: assert against each resolved mailbox, never a
    // client-supplied value. Foreign actors (no membership, not the
    // owner, not a global admin) would normally get 403
    // MAILBOX_ACCESS_DENIED — but for THIS route a 403 would leak the
    // draft's existence in the target mailbox. Every negative
    // outcome (MAILBOX_ACCESS_DENIED, MAILBOX_NOT_FOUND) collapses to
    // a 404 MESSAGE_NOT_FOUND on the way out — the foreign envelope is
    // observationally identical to the missing-ID envelope regardless
    // of how many associations exist on disk.
    const isAdmin = await checkPermission(c.env.DB, userId, 'role.manage');
    let authorizedMailboxId: string | null = null;
    for (const assoc of associationRows) {
      try {
        await assertCan(c.env.DB, userId, assoc.mailbox_id, 'read', isAdmin);
        authorizedMailboxId = assoc.mailbox_id;
        break;
      } catch (error) {
        if (error instanceof DomainError) {
          // 'read' is the lowest-privilege op in the matrix; a non-null
          // negative here means the actor is not a member / owner / admin
          // for THIS mailbox — keep iterating to the next association.
          // A non-Mailbox error is rethrown unchanged.
          if (error.code === 'MAILBOX_ACCESS_DENIED' || error.code === 'MAILBOX_NOT_FOUND') {
            continue;
          }
        }
        throw error;
      }
    }

    // No association was readable by this actor — same 404 envelope as a
    // missing ID. The actor learns nothing about whether associations
    // exist on disk for this draft.
    if (authorizedMailboxId === null) {
      throw new DomainError({
        code: 'MESSAGE_NOT_FOUND',
        message: 'Message not found',
        httpStatus: 404,
      });
    }

    // Load the draft body now that we know the authorised mailbox. The
    // wire `mailboxId` is the resolved (authorised) one — never a
    // client-supplied value (R-AUTHZ-004).
    const draftRow = await c.env.DB.prepare(
      `SELECT m.id         AS id,
              m.subject    AS subject,
              m.html_body  AS html_body,
              m.text_body  AS text_body,
              m.status     AS status,
              m.created_at AS created_at,
              m.updated_at AS updated_at
         FROM messages m
        WHERE m.id = ?
          AND m.status = 'draft'
          AND EXISTS (
            SELECT 1 FROM mailbox_messages mm
             WHERE mm.message_id = m.id
               AND mm.mailbox_id = ?
          )
        LIMIT 1`,
    )
      .bind(draftId, authorizedMailboxId)
      .first<{
        id: string;
        subject: string;
        html_body: string;
        text_body: string;
        status: string;
        created_at: string;
        updated_at: string;
      }>();

    // The EXISTS subquery guards against a TOCTOU race where the
    // association is removed between the iteration above and this read;
    // if so, treat the same as a missing ID.
    if (!draftRow) {
      throw new DomainError({
        code: 'MESSAGE_NOT_FOUND',
        message: 'Message not found',
        httpStatus: 404,
      });
    }

    // Recipients: grouped by `type`, written to the wire as plain
    // normalized-address arrays. `to` / `cc` / `bcc` are all required
    // by the wire contract; an absent category is an empty array, never
    // null. CAP-047 wire shape is `string[]` per category, not objects
    // (displayName is intentionally absent on draft read — see
    // D-CAP-047-contracts).
    const recipientRows = await c.env.DB.prepare(
      `SELECT type, address
           FROM message_recipients
          WHERE message_id = ?
       ORDER BY type, address`,
    )
      .bind(draftId)
      .all<{ type: 'to' | 'cc' | 'bcc'; address: string }>();

    const to: string[] = [];
    const cc: string[] = [];
    const bcc: string[] = [];
    for (const row of recipientRows.results ?? []) {
      if (row.type === 'to') to.push(row.address);
      else if (row.type === 'cc') cc.push(row.address);
      else if (row.type === 'bcc') bcc.push(row.address);
    }

    // Wire response. The body keys are kept in the wire order documented
    // in the CAP-047 read contract (id, mailboxId, subject, body_text,
    // body_html, to, cc, bcc, status, created_at, updated_at). Stored
    // `messages.status` is the canonical 'draft' value for this slice.
    // `mailboxId` is the AUTHORISED mailbox from the iteration above —
    // never a client-supplied value (R-AUTHZ-004) and never an
    // association the actor could not read (the existence-leak posture).
    const body = {
      data: {
        id: draftRow.id,
        mailboxId: authorizedMailboxId,
        subject: draftRow.subject,
        body_text: draftRow.text_body,
        body_html: draftRow.html_body,
        to,
        cc,
        bcc,
        status: draftRow.status,
        created_at: sqliteTimestampToRFC3339(draftRow.created_at),
        updated_at: sqliteTimestampToRFC3339(draftRow.updated_at),
      },
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return routes;
}
