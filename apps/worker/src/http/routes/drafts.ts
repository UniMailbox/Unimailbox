// http/routes/drafts — CAP-047 server-side draft vertical slice.
//
// POST  /api/v1/mailboxes/:mailboxId/drafts — create a draft message.
// GET   /api/v1/drafts/:draftId             — read a draft. An optional
//                                             `mailboxId` query binds the
//                                             response to the mailbox-scoped
//                                             Web route.
// PATCH /api/v1/drafts/:draftId             — update a draft (optimistic
//                                             concurrency via `If-Match`).
//
// R-AUTHZ-003: Two layers — requirePermission on the route, then
// mailbox-scoped assertCan inside the handler. The CREATE / PATCH routes
// require `message.send`; the GET route requires `message.read`.
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
// mutation, no queue call, no other write. PATCH writes one `draft.updated`
// audit row folded into the same D1 batch as the message + recipient +
// idempotency writes (R-OUTBOUND-006 adapted for drafts — a crash between
// the message UPDATE and the audit / idempotency records must not leave an
// unaudited or unrecorded patch).
// R-CONCURRENCY-001 (CAP-047 / D-CAP-047-PATCH): PATCH uses optimistic
// concurrency. The `If-Match` header carries the canonical RFC-3339
// `updated_at` returned by GET. The route rejects missing / malformed /
// weak / quoted / non-canonical headers with 400 `IF_MATCH_REQUIRED` or
// `IF_MATCH_INVALID`, and a header that no longer matches the stored
// value with 412 `STALE_IF_MATCH`. The conditional UPDATE carries
// `WHERE id = ? AND status = 'draft' AND updated_at = ?` so a stale
// predicate cannot promote the message. The new SQLite timestamp is
// STRICTLY greater than the old one even when two requests land inside
// the same second (advance by one second when needed) so the next
// round-trip always has a fresh `If-Match` value to send back.
//
// The atomic-batch order (UPDATE → idempotency → recipients → audit)
// plus the per-request idempotency row used as a batch marker is the
// CAP-047 / D-CAP-047-PATCH race fix: a guard keyed solely on
// `messages.updated_at` is NOT request-scoped — two concurrent PATCHes
// at the same second-precision instant compute the SAME `newSqlite`,
// so the loser's `WHERE updated_at = newSqlite` guard would match the
// winner's row and let the loser mutate recipients / audit /
// idempotency. Gating statements 2-5 on the idempotency marker row
// (and gating statement 2 on the SQLite `changes() > 0` function so
// the marker only exists when this request's UPDATE actually landed)
// closes the parallel-batch race: a stale loser executes zero side
// effects and surfaces 412 / replay / 409 from the post-batch
// disambiguation, never from a partial write.
//
// The CREATE route does NOT enqueue a job. A draft persists with
// `status='draft'` and `mailbox_messages.folder='drafts'`; the send route
// promotes it to 'queued' and enqueues the provider job after commit.
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
//
// On PATCH returns 200 with the SAME envelope as GET — the route reads
// the existing row, merges the supplied fields, writes the conditional
// UPDATE + recipient replacements + audit row + idempotency record in ONE
// atomic D1 batch, and serves a GET-shaped response with the NEW
// `updated_at` (the next round-trip's `If-Match`). A stale `If-Match`
// returns 412 `STALE_IF_MATCH` with the existing GET envelope shape
// preserved by the conditional UPDATE not changing any rows. The set of
// write-side tables touched is the SAME as POST (messages +
// message_recipients + audit_events + idempotency_records); no
// `outbound_jobs` row is ever created by the PATCH slice.

import { Hono } from 'hono';
import {
  createDraftSchema,
  sendDraftSchema,
  updateDraftSchema,
  uuidSchema,
  type AuditAction,
} from '@unimailbox/contracts';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { assertCan, findMailboxById } from '../../modules/tenancy';
import { prepareCreateAuditEvent } from '../../modules/admin';
import { createMessageWithRelations, prepareQueueDraftForSend } from '../../modules/messages';
import {
  findActiveOutboundConnectionForMailbox,
  prepareCreateOutboundJobGuarded,
} from '../../modules/outbound-mail';
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
  IDEMPOTENCY_TTL_HOURS,
} from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';
import { parseJsonBody } from '../middleware/parse-json-body';

const CREATE_DRAFT_OPERATION = 'POST /api/v1/mailboxes/:mailboxId/drafts';
const PATCH_DRAFT_OPERATION = 'PATCH /api/v1/drafts/:draftId';
const SEND_DRAFT_OPERATION = 'POST /api/v1/drafts/:draftId/send';

function replayDraftSend(record: Parameters<typeof replayResponse>[0]): Response {
  const replay = replayResponse(record);
  return setDraftSendLocation(replay, record.responseJson);
}

function setDraftSendLocation(replay: Response, responseJson: string): Response {
  try {
    const parsed: unknown = JSON.parse(responseJson);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'data' in parsed &&
      typeof parsed.data === 'object' &&
      parsed.data !== null &&
      'messageId' in parsed.data &&
      typeof parsed.data.messageId === 'string'
    ) {
      replay.headers.set('Location', `/api/v1/messages/${parsed.data.messageId}`);
    }
  } catch {
    // The stored response was produced by this route and is JSON by contract.
    // Keep the byte-identical replay even if a corrupt legacy row lacks a
    // parseable body; no caller-supplied path is used for its Location.
  }
  return replay;
}

async function replayDraftSendResponse(replay: Response): Promise<Response> {
  return setDraftSendLocation(replay, await replay.clone().text());
}

/**
 * Strict RFC-3339 second-precision canonical form:
 * `YYYY-MM-DDTHH:MM:SS.000Z` — the EXACT shape GET returns for `updated_at`
 * (second-precision column, `.000Z` literal suffix). Clients round-trip
 * the value verbatim from the GET response into the `If-Match` header.
 *
 * Any other shape — sub-second fractional digits, missing `.000Z` suffix,
 * timezone offsets other than `Z`, an empty body, an extra suffix, a
 * weak / quoted validator tag — is rejected with 400 `IF_MATCH_INVALID`.
 */
const IF_MATCH_CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;

/**
 * Parse and validate an `If-Match` header value. The wire form is the
 * canonical RFC-3339 string GET returns for `updated_at`; weak / quoted
 * validators are rejected so the equality check inside the conditional
 * UPDATE matches one exact byte sequence.
 *
 * Returns the canonical string on success and throws a typed `DomainError`
 * with the closed machine-readable error code the task requires.
 */
function parseIfMatch(header: string | undefined): string {
  if (header === undefined) {
    throw new DomainError({
      code: 'IF_MATCH_REQUIRED',
      message: 'If-Match header required',
      httpStatus: 400,
    });
  }
  const trimmed = header.trim();
  // Reject weak validator prefix (RFC 7232 §2.3 — `W/"..."`). The route
  // uses a STRONG validator (the exact `updated_at` value) and a weak
  // validator would defeat the optimistic-concurrency predicate.
  if (trimmed.startsWith('W/')) {
    throw new DomainError({
      code: 'IF_MATCH_INVALID',
      message: 'If-Match header must be the canonical RFC-3339 updated_at without W/ prefix',
      httpStatus: 400,
    });
  }
  // Reject quoted validator tags (RFC 7232 §2.3 — `"..."`). The stored
  // `updated_at` is the raw canonical string; a quoted tag would not
  // match the equality check inside the conditional UPDATE.
  if (trimmed.startsWith('"') || trimmed.endsWith('"')) {
    throw new DomainError({
      code: 'IF_MATCH_INVALID',
      message: 'If-Match header must be the canonical RFC-3339 updated_at without quotes',
      httpStatus: 400,
    });
  }
  if (!IF_MATCH_CANONICAL_RE.test(trimmed)) {
    throw new DomainError({
      code: 'IF_MATCH_INVALID',
      message: 'If-Match header must match YYYY-MM-DDTHH:MM:SS.000Z exactly',
      httpStatus: 400,
    });
  }
  return trimmed;
}

/**
 * Convert the strict canonical If-Match value into the SQLite datetime
 * storage form (`YYYY-MM-DD HH:MM:SS`). The column stores second-precision
 * UTC text; this helper strips the canonical wire suffix and rewrites the
 * `T` separator into the storage separator so the equality check against
 * `messages.updated_at` is a byte-level match.
 */
function ifMatchToSqlite(ifMatch: string): string {
  return ifMatch.slice(0, 19).replace('T', ' ');
}

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

      // Global permission and mailbox membership are independent checks.
      await assertCan(c.env.DB, userId, mailboxId, 'send');

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
   * POST /api/v1/drafts/:draftId/send
   *
   * Queue a server-authoritative draft for provider delivery. The message
   * transition is draft -> queued; the existing queue consumer owns the
   * provider call and the later queued -> sent transition. Every write that
   * makes the send visible (message status, folder, outbound job, audit, and
   * idempotency response) lands in one D1 batch.
   *
   * Idempotency lookup intentionally precedes the draft-status association
   * query. A successful first send changes status from draft to queued, so a
   * replay must still find and return its stored 202 after that transition.
   */
  routes.post(
    '/drafts/:draftId/send',
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

      const draftId = c.req.param('draftId');
      const idempotencyKey = c.get('idempotencyKey');
      if (!idempotencyKey) {
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }

      // Hash the exact bytes before parsing. The body digest is then
      // domain-separated with this route's draftId so a replay must match
      // both the raw body and the addressed resource.
      const rawBody = await c.req.text();
      const rawBodyHash = await sha256Hex(rawBody);
      // Keep the body hash byte-based while domain-separating the resource
      // identity. A key/body pair must never replay a different draft.
      const requestHash = await sha256Hex(`draft-send:${draftId}:${rawBodyHash}`);
      const existing = await findIdempotencyRecord(
        c.env.DB,
        userId,
        SEND_DRAFT_OPERATION,
        idempotencyKey,
      );
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return replayDraftSend(existing);
      }

      // An actually empty body is the canonical send request. Any present
      // bytes — including whitespace — must parse through the strict empty
      // object schema; the original bytes remain part of the idempotency hash.
      if (rawBody !== '') {
        parseJsonBody(rawBody, sendDraftSchema, {
          event: 'drafts.send.invalid_json',
          actorUserId: userId,
        });
      }

      // Resolve every association while the message is still a draft. The
      // first mailbox the actor may send from is the authority for this
      // request; no mailbox ID is accepted from the client.
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
      if (associationRows.length === 0) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      let authorizedMailboxId: string | null = null;
      for (const association of associationRows) {
        try {
          await assertCan(c.env.DB, userId, association.mailbox_id, 'send');
          authorizedMailboxId = association.mailbox_id;
          break;
        } catch (error) {
          if (error instanceof DomainError) {
            if (error.code === 'MAILBOX_ACCESS_DENIED' || error.code === 'MAILBOX_NOT_FOUND') {
              continue;
            }
          }
          throw error;
        }
      }
      if (authorizedMailboxId === null) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      // Use the connection assigned to the authorized mailbox's managed
      // domain. A global first-active fallback would cross domain boundaries.
      const connection = await findActiveOutboundConnectionForMailbox(
        c.env.DB,
        authorizedMailboxId,
      );
      if (!connection) {
        throw new DomainError({
          code: 'PROVIDER_CONNECTION_NOT_FOUND',
          message: 'No active provider connection',
          httpStatus: 409,
        });
      }

      const now = sqliteTimestamp(systemClock.now());
      const jobId = systemIds.uuid();
      const idempotencyRecordId = systemIds.uuid();
      const auditEventId = systemIds.uuid();
      const requestId = c.get('requestId') ?? null;
      const successBody = JSON.stringify({
        data: { messageId: draftId, status: 'queued' },
      });
      const auditAction: AuditAction = 'draft.sent';

      // Statement 1 is the only status writer. The marker INSERT in statement
      // 2 is request-specific and gated by changes() so a stale/concurrent
      // loser cannot make any later statement visible.
      const statements: D1PreparedStatement[] = [
        prepareQueueDraftForSend(c.env.DB, { messageId: draftId, now }),
        c.env.DB.prepare(
          `INSERT INTO idempotency_records
             (id, actor_id, operation, idempotency_key, request_hash,
              response_status, response_json, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, 202, ?, ?, datetime(?, '+${IDEMPOTENCY_TTL_HOURS} hours')
            WHERE changes() > 0
              AND EXISTS (
                SELECT 1 FROM messages
                 WHERE id = ? AND status = 'queued' AND updated_at = ?
              )`,
        ).bind(
          idempotencyRecordId,
          userId,
          SEND_DRAFT_OPERATION,
          idempotencyKey,
          requestHash,
          successBody,
          now,
          now,
          draftId,
          now,
        ),
        c.env.DB.prepare(
          `UPDATE mailbox_messages
              SET folder = 'sent'
            WHERE message_id = ?
              AND folder = 'drafts'
              AND EXISTS (
                SELECT 1 FROM idempotency_records WHERE id = ?
              )`,
        ).bind(draftId, idempotencyRecordId),
        prepareCreateOutboundJobGuarded(c.env.DB, {
          id: jobId,
          messageId: draftId,
          providerConnectionId: connection.id,
          createdAt: now,
          updatedAt: now,
          idempotencyMarkerId: idempotencyRecordId,
        }),
        c.env.DB.prepare(
          `INSERT INTO audit_events
             (id, actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at)
           SELECT ?, ?, ?, 'message', ?, ?, NULL, ?
            WHERE EXISTS (
              SELECT 1 FROM idempotency_records WHERE id = ?
            )`,
        ).bind(auditEventId, userId, auditAction, draftId, requestId, now, idempotencyRecordId),
      ];

      let results: D1Result[];
      try {
        results = await c.env.DB.batch(statements);
      } catch (error) {
        if (isIdempotencyUniqueViolation(error)) {
          const replay = await replayAfterRace(
            c.env.DB,
            userId,
            SEND_DRAFT_OPERATION,
            idempotencyKey,
            requestHash,
          );
          return replayDraftSendResponse(replay);
        }
        throw error;
      }

      if ((results[0]?.meta?.changes ?? 0) === 0) {
        // Another request already moved this draft out of draft status. Only
        // a record for this exact key can turn that race into a replay; absent
        // a winner, keep the same no-leak 404 used by the read/send lookup.
        const winner = await findIdempotencyRecord(
          c.env.DB,
          userId,
          SEND_DRAFT_OPERATION,
          idempotencyKey,
        );
        if (winner) {
          assertSameRequestHash(winner, requestHash);
          return replayDraftSend(winner);
        }
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      // Queue only after the D1 transaction commits. A retry of the same
      // idempotency key returns the stored 202 and never sends a second job.
      await c.env.OUTBOUND.send(JSON.stringify({ jobId }));
      return new Response(successBody, {
        status: 202,
        headers: {
          'Content-Type': 'application/json',
          Location: `/api/v1/messages/${draftId}`,
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
   *   2. `assertCan(actorUserId, resolvedMailboxId, 'read')`
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
    // CAP-062: the Web route is mailbox-scoped. Keep the legacy no-query
    // behavior for existing API callers, but when a mailbox is supplied,
    // validate and bind it before resolving the association. Invalid or
    // absent associations collapse to the same 404 envelope.
    const requestedMailboxId = c.req.query('mailboxId');
    if (requestedMailboxId !== undefined && !uuidSchema.safeParse(requestedMailboxId).success) {
      throw new DomainError({
        code: 'MESSAGE_NOT_FOUND',
        message: 'Message not found',
        httpStatus: 404,
      });
    }

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
            AND (? IS NULL OR mm.mailbox_id = ?)
       ORDER BY mm.created_at ASC, mm.id ASC`,
    )
      .bind(draftId, requestedMailboxId ?? null, requestedMailboxId ?? null)
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
    // owner without membership) would normally get 403
    // MAILBOX_ACCESS_DENIED — but for THIS route a 403 would leak the
    // draft's existence in the target mailbox. Every negative
    // outcome (MAILBOX_ACCESS_DENIED, MAILBOX_NOT_FOUND) collapses to
    // a 404 MESSAGE_NOT_FOUND on the way out — the foreign envelope is
    // observationally identical to the missing-ID envelope regardless
    // of how many associations exist on disk.
    let authorizedMailboxId: string | null = null;
    for (const assoc of associationRows) {
      try {
        await assertCan(c.env.DB, userId, assoc.mailbox_id, 'read');
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

  /**
   * PATCH /api/v1/drafts/:draftId
   *
   * Update a draft. Authorised against the RESOLVED mailboxId (R-AUTHZ-004)
   * using the same existence-leak posture as GET: a missing ID, an ID
   * whose `messages.status` is not 'draft', or an ID with no mailbox the
   * actor may `send` from all collapse to the same 404 MESSAGE_NOT_FOUND
   * envelope. Optimistic concurrency: `If-Match: <updated_at>` is required
   * (strict canonical RFC-3339 second-precision form `...SS.000Z`).
   *
   * Authorization layering:
   *   1. `requirePermission('message.send')` middleware — global gate.
   *   2. `assertCan(actorUserId, resolvedMailboxId, 'send')`
   *      inside the handler, iterated over every association. The first
   *      association the actor may send from wins.
   *
   * Wire envelope: `{ data: { id, mailboxId, subject, body_text, body_html,
   * to, cc, bcc, status: 'draft', created_at, updated_at } }` — the same
   * GET-shaped body, with the NEW `updated_at` (the next round-trip's
   * `If-Match`). `created_at` is the original creation instant; the
   * response carries no audit metadata, no message-id / reply / references
   * headers, and no envelope header except `Content-Type`.
   *
   * Atomicity posture (R-OUTBOUND-006 adapted for PATCH):
   *   1. The conditional `UPDATE messages ... WHERE id = ? AND status =
   *      'draft' AND updated_at = ?` runs first. Its `meta.changes` is the
   *      authoritative gate for the whole batch.
   *   2. The idempotency INSERT is the per-request batch MARKER. It is
   *      guarded by `WHERE changes() > 0` (the SQLite function reflecting
   *      the previous statement's row count) AND `EXISTS (SELECT 1 FROM
   *      messages WHERE id = ? AND updated_at = <new>)`. A stale / no-op
   *      UPDATE cannot insert the marker.
   *   3. Every side-effect statement AFTER the marker (recipient DELETE /
   *      INSERT, audit INSERT) is guarded by `WHERE EXISTS (SELECT 1 FROM
   *      idempotency_records WHERE id = ?)` — i.e. THIS request's marker
   *      PRIMARY KEY, not just `updated_at`. This is the parallel-batch
   *      race fix: a second writer's `newSqlite` is byte-identical to this
   *      request's, so a guard keyed solely on `updated_at` would let the
   *      loser mutate recipients / audit / idempotency before returning
   *      412. Guarding on the tuple `(actor_id, operation, idempotency_key,
   *      request_hash)` is also insufficient because two concurrent
   *      same-key PATCHes share every column of that tuple; each request
   *      however has its own freshly-generated `idempotencyRecordId`, so
   *      the `id = ?` check matches ONLY the row this request itself
   *      inserted. The loser's marker row never landed (statement 2's
   *      `changes() > 0` gate), so its `id = ?` lookup matches nothing and
   *      every post-marker statement is a zero-row no-op.
   *   4. After the batch, the route inspects the conditional UPDATE's
   *      `meta.changes`. Zero changes → look up the idempotency record for
   *      (actor, op, key): present + same hash → replay the winner's
   *      200 (same-key concurrent replay); present + different hash → 409
   *      IDEMPOTENCY_KEY_REUSED; absent → 412 STALE_IF_MATCH. Anything
   *      else → 200 with the merged envelope.
   *
   * The batch is wrapped in a `try / catch` for
   * `isIdempotencyUniqueViolation` as defense in depth (MEDIUM-bug fix):
   * a same-key concurrent replay whose pre-validation lookup beat the
   * winner's batch commit could still hit the idempotency UNIQUE
   * constraint; the catch returns the same replay / 409 disambiguation
   * the post-batch lookup performs.
   *
   * `If-Match` pre-validation runs BEFORE the batch: a stale header is
   * the common case and short-circuits with 412 without touching any
   * table (faster than rolling the batch back). The conditional UPDATE
   * inside the batch is the second-line guard for the race where another
   * writer lands between the pre-validation read and the batch.
   *
   * No queue call. No `outbound_jobs` row. A draft that survives PATCH is
   * still `status='draft'`; the send route is the only draft-side path that
   * promotes the row to `queued` and creates an outbound job.
   */
  routes.patch(
    '/drafts/:draftId',
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

      const draftId = c.req.param('draftId');

      // R-AUTHZ-004: resolve the draft's mailbox associations, never a
      // client-supplied mailbox. Filtering on `m.status='draft'` makes
      // every non-draft existing message indistinguishable from a missing
      // ID — the same envelope a truly absent ID would surface (no
      // existence leak). The route iterates every resolved mailbox and
      // picks the first one the actor is authorised to `send` from. If
      // none is authorised, the same 404 MESSAGE_NOT_FOUND envelope is
      // returned. Ordering by `mm.created_at ASC, mm.id ASC` matches the
      // GET route's tiebreaker.
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

      if (associationRows.length === 0) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      // R-AUTHZ-004: assert against each resolved mailbox, never a
      // client-supplied value. Foreign actors (no membership, not the
      // owner without membership) would normally get 403
      // MAILBOX_ACCESS_DENIED — but for THIS route a 403 would leak the
      // draft's existence in the target mailbox. Every negative
      // outcome (MAILBOX_ACCESS_DENIED, MAILBOX_NOT_FOUND) collapses to
      // a 404 MESSAGE_NOT_FOUND on the way out.
      let authorizedMailboxId: string | null = null;
      for (const assoc of associationRows) {
        try {
          await assertCan(c.env.DB, userId, assoc.mailbox_id, 'send');
          authorizedMailboxId = assoc.mailbox_id;
          break;
        } catch (error) {
          if (error instanceof DomainError) {
            if (error.code === 'MAILBOX_ACCESS_DENIED' || error.code === 'MAILBOX_NOT_FOUND') {
              continue;
            }
          }
          throw error;
        }
      }

      if (authorizedMailboxId === null) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      // If-Match header — strict canonical form. The header is the same
      // `updated_at` GET returns; the route rejects missing / malformed /
      // weak / quoted / non-canonical values with the closed codes the
      // task requires.
      const ifMatchHeader = c.req.header('If-Match');
      const ifMatch = parseIfMatch(ifMatchHeader);
      const ifMatchSqlite = ifMatchToSqlite(ifMatch);

      // Idempotency replay lookup runs BEFORE the conditional UPDATE so
      // a replay with the same key + same bytes short-circuits without
      // touching any table. Different bytes with the same key throws 409
      // IDEMPOTENCY_KEY_REUSED (R-API-004).
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

      const rawBody = await c.req.text();
      const requestHash = await sha256Hex(rawBody);

      const existing = await findIdempotencyRecord(
        c.env.DB,
        userId,
        PATCH_DRAFT_OPERATION,
        idempotencyKey,
      );
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return replayResponse(existing);
      }

      // R-INPUT-002: malformed JSON returns 400 INVALID_JSON before the D1
      // batch lands (no idempotency record, so a corrected retry with the
      // same Idempotency-Key succeeds).
      const body = parseJsonBody(rawBody, updateDraftSchema, {
        event: 'drafts.patch.invalid_json',
        actorUserId: userId,
      });

      // Read the existing draft row to (a) build the wire envelope
      // (current subject / bodies / created_at) and (b) pre-validate
      // `If-Match` against the stored `updated_at`. The EXISTS subquery
      // guards against a TOCTOU race where the association is removed
      // between the iteration above and this read; if so, treat the same
      // as a missing ID.
      const currentRow = await c.env.DB.prepare(
        `SELECT m.id         AS id,
                m.subject    AS subject,
                m.html_body  AS html_body,
                m.text_body  AS text_body,
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
          created_at: string;
          updated_at: string;
        }>();

      if (!currentRow) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      // If-Match pre-validation: the header is the exact
      // `updated_at` the client received on the last GET. Any drift
      // (stale value, a value from a different draft, etc.) returns
      // 412 STALE_IF_MATCH without writing anything. The conditional
      // UPDATE inside the batch is the second-line guard against the
      // race where another writer lands between this read and the
      // batch.
      //
      // D-CAP-047-PATCH (MEDIUM) stale-race fix: BEFORE returning
      // STALE_IF_MATCH, perform the same (actor, operation, key)
      // lookup the post-batch path runs. A same-key request whose
      // conditional UPDATE changed zero rows is genuinely a
      // STALE_IF_MATCH — but a same-key request whose PRE-validation
      // read observed a stale `updated_at` because a *concurrent*
      // PATCH under the same key beat us to the row is a SAME-KEY
      // CONCURRENT REPLAY and must return the winner's stored 200,
      // not 412. Without this lookup the loser's caller would
      // observe 412 and re-GET only to discover their key was already
      // spent — the replay contract (R-API-004) would be silently
      // broken.
      //
      // The lookup is the same `findIdempotencyRecord` call the
      // post-batch zero-changes branch performs, and it falls
      // through to the same `assertSameRequestHash` / `replayResponse`
      // pair: same hash → byte-identical replay, different hash →
      // 409 IDEMPOTENCY_KEY_REUSED. Only when the lookup misses
      // (genuine stale `If-Match`, the storage column was advanced by
      // a non-PATCH writer — e.g. a future migration or out-of-band
      // ops script) does the route surface 412 STALE_IF_MATCH.
      if (currentRow.updated_at !== ifMatchSqlite) {
        const preWinner = await findIdempotencyRecord(
          c.env.DB,
          userId,
          PATCH_DRAFT_OPERATION,
          idempotencyKey,
        );
        if (preWinner) {
          // Same-key sub-cases: assertSameRequestHash throws
          // IDEMPOTENCY_KEY_REUSED for the different-body path;
          // returns void for the matching-hash path.
          assertSameRequestHash(preWinner, requestHash);
          return replayResponse(preWinner);
        }
        // Genuine stale-If-Match path: no same-key record exists, so
        // the storage column drift is not a replay. Surface 412 so
        // the caller can re-GET and retry with a fresh header.
        throw new DomainError({
          code: 'STALE_IF_MATCH',
          message: 'If-Match header does not match the current updated_at',
          httpStatus: 412,
        });
      }

      // Read the existing recipient arrays so the wire envelope can
      // round-trip the categories the patch did NOT touch. The shape
      // is the GET route's projection — three arrays of normalized
      // address strings, sorted by (type, address) for a deterministic
      // wire order.
      const recipientRows = await c.env.DB.prepare(
        `SELECT type, address
           FROM message_recipients
          WHERE message_id = ?
       ORDER BY type, address`,
      )
        .bind(draftId)
        .all<{ type: 'to' | 'cc' | 'bcc'; address: string }>();

      const existingTo: string[] = [];
      const existingCc: string[] = [];
      const existingBcc: string[] = [];
      for (const row of recipientRows.results ?? []) {
        if (row.type === 'to') existingTo.push(row.address);
        else if (row.type === 'cc') existingCc.push(row.address);
        else if (row.type === 'bcc') existingBcc.push(row.address);
      }

      // Merge: supplied categories REPLACE the stored arrays; omitted
      // categories keep their stored values (including `[]` clearing a
      // category when the client sends `[]`).
      const mergedTo = body.to !== undefined ? body.to : existingTo;
      const mergedCc = body.cc !== undefined ? body.cc : existingCc;
      const mergedBcc = body.bcc !== undefined ? body.bcc : existingBcc;

      // Compute the new SQLite timestamp. It must be STRICTLY greater
      // than the stored `updated_at` so the conditional UPDATE
      // predicate `WHERE id = ? AND status = 'draft' AND updated_at = ?`
      // has nothing to match if a concurrent writer already advanced the
      // value (the second-line race guard) AND so the next round-trip's
      // `If-Match` always sees a fresh value.
      //
      // The storage column is `YYYY-MM-DD HH:MM:SS` (second precision,
      // UTC). The comparison MUST happen at the column's resolution:
      // `nowDate.getTime()` carries sub-second drift that would let a
      // PATCH within the same wall-clock second look "newer" than the
      // stored value at millisecond precision while `sqliteTimestamp`
      // rounds both down to the same second. The strict-greater guard
      // below would then surface the bug as 500 INTERNAL. Compare the
      // SECOND-PRECISION CANDIDATES (the same byte sequence that goes
      // into `messages.updated_at`) and advance by exactly one second
      // when the wall clock and the stored value share a second.
      const nowDate = systemClock.now();
      const candidateSqlite = sqliteTimestamp(nowDate);
      let newSqlite: string;
      if (candidateSqlite > ifMatchSqlite) {
        // Wall-clock second is past the stored value — use the wall
        // clock directly.
        newSqlite = candidateSqlite;
      } else {
        // Same second or earlier — advance the stored instant by
        // exactly one second at the column's resolution. Wall-clock
        // sub-second drift past the SQLite second is irrelevant; the
        // storage column cannot carry it.
        const advanced = new Date(`${ifMatchSqlite.replace(' ', 'T')}Z`);
        advanced.setUTCSeconds(advanced.getUTCSeconds() + 1);
        newSqlite = sqliteTimestamp(advanced);
      }
      // Wire timestamp — built from the second-precision SQLite form
      // so the response is exactly GET-compatible (`.000Z` literal
      // suffix). The `If-Match` header for the next round-trip is
      // round-tripped verbatim from this field, and `parseIfMatch`
      // requires the canonical `...:SS.000Z` form. `toISOString()` on
      // a sub-second `Date` would carry millisecond drift the regex
      // rejects, so build the wire shape by hand instead.
      const newWire = `${newSqlite.replace(' ', 'T')}.000Z`;

      // Sanity: the new timestamp must sort strictly above the
      // stored one as TEXT. SQLite compares `YYYY-MM-DD HH:MM:SS`
      // lexicographically — `>=` here means a stale predicate (the
      // same value) and would silently let the conditional UPDATE
      // "succeed" against an already-stale row.
      if (newSqlite <= ifMatchSqlite) {
        throw new DomainError({
          code: 'INTERNAL',
          message: 'Computed updated_at did not advance past the stored value',
          httpStatus: 500,
        });
      }

      // Build the wire body up front so the stored response on replay
      // is byte-identical (R-API-004). Field-by-field merge:
      // supplied categories override the stored values; omitted fields
      // keep theirs. `created_at` is the ORIGINAL creation instant —
      // PATCH does not advance it. `updated_at` is the NEW wire
      // instant so the client's next round-trip can echo it back in
      // `If-Match`.
      const responseBody = JSON.stringify({
        data: {
          id: currentRow.id,
          mailboxId: authorizedMailboxId,
          subject: body.subject ?? currentRow.subject,
          body_text: body.body_text ?? currentRow.text_body,
          body_html: body.body_html ?? currentRow.html_body,
          to: mergedTo,
          cc: mergedCc,
          bcc: mergedBcc,
          status: 'draft',
          created_at: sqliteTimestampToRFC3339(currentRow.created_at),
          updated_at: newWire,
        },
      });

      const auditEventId = systemIds.uuid();
      const idempotencyRecordId = systemIds.uuid();
      const requestId = c.get('requestId') ?? null;

      // CAP-047 / R-OUTBOUND-006 (adapted for drafts): every row that
      // must exist for the patch to be visible is written in one D1
      // batch. If any statement fails, D1 rolls the whole batch back
      // — no orphaned message, no orphan recipients, no orphan audit
      // row, no orphan idempotency record.
      //
      // The atomic-batch statement order is fixed and load-bearing:
      //   1. Conditional UPDATE messages (the optimistic concurrency
      //      predicate). `meta.changes` is the gate for the whole
      //      batch.
      //   2. INSERT idempotency_records — the per-request BATCH
      //      MARKER. Guarded by `WHERE changes() > 0` (the SQLite
      //      function reflecting the row count of the most recent
      //      INSERT/UPDATE/DELETE — i.e. statement 1 above) AND
      //      `EXISTS (SELECT 1 FROM messages WHERE id = ? AND
      //      updated_at = ?)`. If the conditional UPDATE changed
      //      zero rows, this INSERT inserts zero rows; the marker row
      //      therefore exists ONLY for the request whose UPDATE
      //      landed. This is the bug fix for the parallel-batch race:
      //      a second writer's `newSqlite` is BYTE-IDENTICAL to this
      //      request's (both requests compute the same second-
      //      precision instant), so a guard keyed on `updated_at`
      //      alone would match the OTHER writer's row and let the
      //      loser mutate recipients / audit / idempotency rows
      //      before returning 412. The `changes() > 0` gate makes the
      //      marker request-scoped.
      //   3 + 4. Recipient replacements — only the categories the
      //      patch supplied. `[]` clears the category (DELETE runs,
      //      zero INSERTs); `[address1, address2]` fully replaces it.
      //      Guarded by `WHERE EXISTS (SELECT 1 FROM
      //      idempotency_records WHERE id = ?)` — i.e. THIS
      //      request's marker PRIMARY KEY, not the (actor_id,
      //      operation, idempotency_key, request_hash) tuple. Two
      //      concurrent same-key PATCHes share that tuple but each
      //      carries its own freshly-generated `idempotencyRecordId`;
      //      only the batch that actually inserted its own marker
      //      row satisfies `id = ?`, so the loser's recipient writes
      //      are zero-row no-ops even when both batches compute a
      //      byte-identical `newSqlite`.
      //   5. INSERT audit_events (`draft.updated`, resource
      //      'message', no metadata). Guarded by the same `id = ?`
      //      marker-PK check so a stale UPDATE cannot leave a
      //      phantom audit row AND so a same-key concurrent loser's
      //      audit INSERT is a zero-row no-op (the loser's marker
      //      row never landed — see statement 2's `changes() > 0`
      //      gate — so its `id = ?` lookup matches nothing).
      //
      // After the batch, the route inspects the conditional UPDATE's
      // `meta.changes`:
      //   - changes > 0 → 200 with the merged envelope.
      //   - changes === 0 → look up the idempotency record for
      //     (actor, op, key):
      //       - present + same hash → replay the stored 200
      //         (same-key concurrent replay that beat this request's
      //         pre-validation lookup but lost the UPDATE race).
      //       - present + different hash → 409 IDEMPOTENCY_KEY_REUSED
      //         (the same-key, different-body misuse case).
      //       - absent → 412 STALE_IF_MATCH (the genuine race-loser
      //         path; the side-effect guards ensured no other table
      //         was touched).
      //
      // COALESCE in the UPDATE keeps omitted fields at their stored
      // value (matches the partial-patch contract: omitted fields are
      // preserved). The supplied categories are bound as plain
      // parameters — `null` signals "no change for this field", which
      // is the same shape the create route's wire body uses.
      const statements: D1PreparedStatement[] = [
        // 1. Conditional UPDATE — the optimistic-concurrency predicate.
        // `meta.changes` on this statement is the gate for the whole
        // batch. After this statement runs, SQLite's `changes()`
        // function reflects its row count for statement 2.
        c.env.DB.prepare(
          `UPDATE messages
              SET subject   = COALESCE(?, subject),
                  text_body = COALESCE(?, text_body),
                  html_body = COALESCE(?, html_body),
                  updated_at = ?
            WHERE id = ?
              AND status = 'draft'
              AND updated_at = ?`,
        ).bind(
          body.subject ?? null,
          body.body_text ?? null,
          body.body_html ?? null,
          newSqlite,
          draftId,
          ifMatchSqlite,
        ),

        // 2. Idempotency record — the per-request BATCH MARKER.
        // Guarded by `WHERE changes() > 0` (so a stale UPDATE — where
        // another writer already advanced `updated_at` to the same
        // second-precision `newSqlite` — cannot insert a marker row)
        // AND `EXISTS (SELECT 1 FROM messages WHERE id = ? AND
        // updated_at = ?)` (so a malformed or partial UPDATE — where
        // `newSqlite` is not actually on disk — also cannot insert).
        // The TTL is derived in SQL from the created_at so the stored
        // value shares its format with `messages.updated_at`.
        c.env.DB.prepare(
          `INSERT INTO idempotency_records
             (id, actor_id, operation, idempotency_key, request_hash,
              response_status, response_json, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, 200, ?, ?, datetime(?, '+${IDEMPOTENCY_TTL_HOURS} hours')
            WHERE changes() > 0
              AND EXISTS (
                SELECT 1 FROM messages
                 WHERE id = ? AND updated_at = ?
              )`,
        ).bind(
          idempotencyRecordId,
          userId,
          PATCH_DRAFT_OPERATION,
          idempotencyKey,
          requestHash,
          responseBody,
          newSqlite,
          newSqlite,
          draftId,
          newSqlite,
        ),
      ];

      // 3 + 4. Recipient replacements — only the categories the
      // patch supplied. `[]` clears the category (DELETE runs, zero
      // INSERTs); `[address1, address2]` fully replaces it. Guarded
      // by THIS request's idempotency marker PRIMARY KEY (`id = ?`),
      // not by the (actor_id, operation, idempotency_key,
      // request_hash) tuple or by `updated_at` alone — see statement
      // 2's comment for why the marker (not the timestamp) is the
      // request-scoped gate. Two concurrent same-key PATCHes share
      // the same (actor, op, key, hash) tuple but each carries its
      // OWN freshly-generated `idempotencyRecordId`; only the batch
      // that actually inserted ITS OWN marker row satisfies `id = ?`,
      // so the loser's recipient writes are zero-row no-ops even when
      // both batches compute a byte-identical `newSqlite`.
      if (body.to !== undefined) {
        statements.push(
          c.env.DB.prepare(
            `DELETE FROM message_recipients
              WHERE message_id = ?
                AND type = 'to'
                AND EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
          ).bind(draftId, idempotencyRecordId),
        );
        for (const address of body.to) {
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO message_recipients
                 (id, message_id, address, display_name, type, created_at)
               SELECT ?, ?, ?, '', 'to', ?
                WHERE EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
            ).bind(systemIds.uuid(), draftId, address, newSqlite, idempotencyRecordId),
          );
        }
      }
      if (body.cc !== undefined) {
        statements.push(
          c.env.DB.prepare(
            `DELETE FROM message_recipients
              WHERE message_id = ?
                AND type = 'cc'
                AND EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
          ).bind(draftId, idempotencyRecordId),
        );
        for (const address of body.cc) {
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO message_recipients
                 (id, message_id, address, display_name, type, created_at)
               SELECT ?, ?, ?, '', 'cc', ?
                WHERE EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
            ).bind(systemIds.uuid(), draftId, address, newSqlite, idempotencyRecordId),
          );
        }
      }
      if (body.bcc !== undefined) {
        statements.push(
          c.env.DB.prepare(
            `DELETE FROM message_recipients
              WHERE message_id = ?
                AND type = 'bcc'
                AND EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
          ).bind(draftId, idempotencyRecordId),
        );
        for (const address of body.bcc) {
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO message_recipients
                 (id, message_id, address, display_name, type, created_at)
               SELECT ?, ?, ?, '', 'bcc', ?
                WHERE EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
            ).bind(systemIds.uuid(), draftId, address, newSqlite, idempotencyRecordId),
          );
        }
      }

      // 5. Audit event — R-AUDIT-001. `draft.updated` is folded into
      // the same batch so the message UPDATE and the audit entry
      // land atomically. Guarded by the per-request idempotency
      // marker PRIMARY KEY (`id = ?`) so a stale UPDATE cannot leave
      // a phantom audit row, and so a same-key concurrent loser's
      // audit INSERT is a zero-row no-op (the loser's marker row
      // never landed — see statement 2's `changes() > 0` gate — so
      // its `id = ?` lookup matches nothing).
      //
      // The audit row's `action` is the closed-enum literal
      // `draft.updated` — typed directly as `AuditAction` because
      // `packages/contracts/src/admin/audit.ts` registers the
      // transition in `auditActionSchema` (CAP-047 / D-CAP-047-PATCH).
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO audit_events
             (id, actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at)
           SELECT ?, ?, ?, 'message', ?, ?, NULL, ?
            WHERE EXISTS (
              SELECT 1 FROM idempotency_records
               WHERE id = ?
            )`,
        ).bind(
          auditEventId,
          userId,
          'draft.updated' satisfies AuditAction,
          draftId,
          requestId,
          newSqlite,
          idempotencyRecordId,
        ),
      );

      // Execute the batch atomically. The UPDATE result is at index 0;
      // every other statement's effect is gated by the UPDATE having
      // landed (statement 2's `changes() > 0` guard) and by the
      // existence of the idempotency marker row (statements 3-5's
      // `EXISTS idempotency_records` guards). The whole batch is a
      // single D1 transaction; a failure mid-batch rolls everything
      // back.
      //
      // MEDIUM-bug defense in depth: a same-key concurrent replay
      // whose pre-validation lookup happened BEFORE the winner's
      // batch committed (so this request saw no idempotency record
      // and built its own batch) could still race the winner's
      // batch on the idempotency UNIQUE constraint. The
      // `changes() > 0` guard on statement 2 normally prevents this
      // (the loser's UPDATE matches zero rows, so statement 2 is a
      // no-op and never inserts), but we wrap the batch in a catch
      // for `isIdempotencyUniqueViolation` as a safety net — the
      // same posture the POST route already takes
      // (http/routes/drafts.ts: replayAfterRace). Same hash →
      // replayAfterRace; different hash → IDEMPOTENCY_KEY_REUSED.
      let results: D1Result[];
      try {
        results = await c.env.DB.batch(statements);
      } catch (error) {
        if (isIdempotencyUniqueViolation(error)) {
          return replayAfterRace(
            c.env.DB,
            userId,
            PATCH_DRAFT_OPERATION,
            idempotencyKey,
            requestHash,
          );
        }
        throw error;
      }

      const updateChanges = results[0]?.meta?.changes ?? 0;
      if (updateChanges === 0) {
        // Race-loser path. The marker-row guards in statements 3-5
        // kept every other table untouched (no recipient rows
        // deleted/inserted, no audit row written, no idempotency row
        // for this request). Now disambiguate the three sub-cases:
        //
        //   1. Same-key concurrent replay that beat THIS request's
        //      pre-validation lookup but lost the UPDATE race (D1
        //      serialised the batches; the winner's idempotency row
        //      exists for THIS key + actor + op).
        //      → replay the winner's stored response byte-identically.
        //   2. Same-key, different-body misuse (the stored row
        //      exists with a hash that differs from THIS request's
        //      body hash).
        //      → 409 IDEMPOTENCY_KEY_REUSED via assertSameRequestHash.
        //   3. Genuine race-loser (different idempotency key, the
        //      stored row is for someone else's request).
        //      → 412 STALE_IF_MATCH; no DB writes occurred.
        const winnerRecord = await findIdempotencyRecord(
          c.env.DB,
          userId,
          PATCH_DRAFT_OPERATION,
          idempotencyKey,
        );
        if (winnerRecord) {
          // Same-key sub-cases (1) and (2). assertSameRequestHash
          // throws IDEMPOTENCY_KEY_REUSED for the different-body
          // path; returns void for the matching-hash path.
          assertSameRequestHash(winnerRecord, requestHash);
          return replayResponse(winnerRecord);
        }
        // Genuine race-loser path: another writer advanced
        // `updated_at` between the pre-validation read above and the
        // batch. The marker-row guards ensured no other table was
        // touched, so the DB is consistent — surface 412 so the
        // caller can re-GET and retry.
        throw new DomainError({
          code: 'STALE_IF_MATCH',
          message: 'If-Match header does not match the current updated_at',
          httpStatus: 412,
        });
      }

      return new Response(responseBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  return routes;
}
