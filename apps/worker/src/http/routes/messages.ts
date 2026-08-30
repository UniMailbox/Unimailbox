// http/routes/messages — CAP-022 inbox routes.
// Hono sub-app for /api/v1/mailboxes/:mailboxId/messages endpoints: list,
// detail, thread (CAP-043 Slice 2), mark-read, per-user star + soft delete
// (CAP-058 star state; CAP-043 Slice 3 soft delete).
//
// R-AUTHZ-003: Two layers — requirePermission('message.read') on every route,
// then mailbox-scoped assertCan(..., 'read', isAdmin) inside the handler.
// R-AUTHZ-004: assertCan authorises against the path's mailboxId, never a
// client body value.
// R-MESSAGE-005: isRead and isStarred resolve per requesting user (see
// message-read-repository).
// R-API-004: PATCH /messages/:id/read, PATCH /messages/:id/star and DELETE
// /messages/:id require Idempotency-Key; replays return the stored response.
// R-API-005: the list cursor is HMAC-SHA-256 signed
// (CAP-043 Slice 1 / D-CAP-043-D). A tampered or malformed cursor surfaces
// as 400 INVALID_CURSOR (R-API-002 stable code).
//
// CAP-043 Slice 3 / gate 3 (Slice 2 review, arch L4): the authz stanza and
// the idempotency replay stanza that markRead pioneered are extracted into
// file-private helpers (requireMailboxReadAccess / beginIdempotentOperation)
// and applied to every route in this file. No new module — the extraction is
// local, and the existing tests pass unchanged.
//
// CAP-043 Slice 3 fix pass (H1/H2/H4): star and soft delete are now
// BATCH-ATOMIC. Each folds the business write, the idempotency record, and
// the audit row (R-AUDIT-001) into ONE db.batch([...]) — a D1 batch is an
// implicit transaction, so a UNIQUE race on idempotency_records rolls the
// business write back too, and the loser replays the winner's stored
// response via platform replayAfterRace. markRead stays best-effort by
// recorded decision (D-CAP-043-I). No route handler runs raw SQL (H6) —
// the row lookups live in message-read-repository.

import { Hono, type Context } from 'hono';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { assertCan } from '../../modules/tenancy';
import { checkPermission } from '../../modules/admin';
import {
  listMessagesByMailbox,
  getMessageDetail,
  getMessageThread,
  markMessageAsRead,
  getMessageStarState,
  prepareSetMessageStar,
  prepareSoftDeleteMessageForUser,
  CursorInvalidError,
} from '../../modules/messages';
import { systemIds } from '../../platform/ids';
import { systemClock } from '../../platform/clock';
import { DomainError } from '../../platform/errors';
import {
  findIdempotencyRecord,
  prepareCreateIdempotencyRecord,
  assertSameRequestHash,
  replayResponse,
  replayAfterRace,
  writeIdempotencyRecord,
  sha256Hex,
  sqliteTimestamp,
  isIdempotencyUniqueViolation,
} from '../../platform/idempotency';
import { parseCursorSigningKey } from '../../platform/config';
import { buildAppContext } from '../../app-context';
import type { AppEnv } from '../../platform/env';

const MARK_READ_OPERATION = 'PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read';
const TOGGLE_STAR_OPERATION = 'PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/star';
const DELETE_MESSAGE_OPERATION = 'DELETE /api/v1/mailboxes/:mailboxId/messages/:messageId';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

// ---------------------------------------------------------------------------
// Shared authz stanza (gate 3). Every route in this file authorises the
// same way: authenticated user → admin flag → mailbox-scoped assertCan on
// the PATH's mailboxId.
// ---------------------------------------------------------------------------

/**
 * R-AUTHZ-003 / R-AUTHZ-004: resolve the authenticated user, then run the
 * mailbox-scoped check against the path's `mailboxId`. The global
 * `requirePermission('message.read')` middleware has already run by the
 * time a handler calls this.
 *
 * D-CAP-043-H: star and per-user soft delete ride the same 'read' surface
 * as every other route here — presentation-state changes, not destructive
 * operations.
 *
 * @returns the authenticated userId (401 DomainError when absent).
 */
async function requireMailboxReadAccess(c: Context<AppEnv>, mailboxId: string): Promise<string> {
  const userId = c.get('userId');
  if (!userId) {
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  }

  // R-AUTHZ-005: admin bypass flows through checkPermission('role.manage').
  const isAdmin = await checkPermission(c.env.DB, userId, 'role.manage');
  await assertCan(c.env.DB, userId, mailboxId, 'read', isAdmin);

  return userId;
}

// ---------------------------------------------------------------------------
// Shared idempotency stanza (gate 3). R-API-004 / ADR-004: look for a stored
// response before the business write. Slice 3 fix H3 collapsed the local
// replay/settle helpers into the platform ones — replayResponse (which
// handles the stored-204 empty-body case, D-CAP-043-E), replayAfterRace,
// and writeIdempotencyRecord.
// ---------------------------------------------------------------------------

interface IdempotencyRequestContext {
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

/**
 * R-API-004: replay the stored response for (actor, operation, key) when one
 * exists. Returns `{ context, replay: null }` when the handler must proceed
 * with the business write; `replay` carries the stored Response otherwise.
 * Throws 409 IDEMPOTENCY_KEY_REUSED when the key was spent on a different
 * request body.
 *
 * The hash covers the raw bytes received and, for resource-bound operations,
 * the path resource. These routes send no required body, so a missing body
 * hashes as "". Retries with the same key and resource replay; the same key
 * with different request material is a client bug.
 */
async function beginIdempotentOperation(
  c: Context<AppEnv>,
  userId: string,
  operation: string,
  resource?: { readonly mailboxId: string; readonly messageId: string },
): Promise<{ context: IdempotencyRequestContext; replay: Response | null }> {
  const rawBody = await c.req.text();
  // R-API-004: star operations are bound to their path resource as well as
  // their (currently empty) body. This prevents a static operation name from
  // replaying a response for another message; pre-CAP-058 records safely
  // conflict unless their stored response is independently compatible.
  const requestHash = await sha256Hex(
    resource === undefined ? rawBody : JSON.stringify({ body: rawBody, resource }),
  );

  const idempotencyKey = c.get('idempotencyKey');
  if (!idempotencyKey) {
    // Defensive: requireIdempotencyKey middleware has already rejected a
    // missing or malformed key. This keeps the helper total if a route is
    // ever mounted without it.
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header required',
      httpStatus: 400,
    });
  }

  const existing = await findIdempotencyRecord(c.env.DB, userId, operation, idempotencyKey);
  if (existing) {
    assertSameRequestHash(existing, requestHash);
    // H3: platform replayResponse — a stored 204's empty body reaches the
    // Response constructor as null (D-CAP-043-E).
    return { context: { idempotencyKey, requestHash }, replay: replayResponse(existing) };
  }

  return { context: { idempotencyKey, requestHash }, replay: null };
}

/**
 * Slice 3 fix H4 / R-AUDIT-001 / D-CAP-043-I: build the audit_events INSERT
 * for a message presentation-state transition, to be folded into the same
 * D1 batch as the business write and the idempotency record — the
 * webhooks.ts fold pattern (the messages route layer cannot import the
 * admin module; the writer is the cross-module seam wired through
 * AppContext, the composition root).
 *
 * The returned object is the audit writer's structural D1 statement — cast
 * to D1PreparedStatement for batch inclusion, exactly as webhooks.ts does.
 */
function prepareMessageAudit(
  c: Context<AppEnv>,
  userId: string,
  action: 'message.star_toggled' | 'message.soft_deleted',
  messageId: string,
  metadata: Record<string, unknown>,
  createdAt: string,
) {
  const ctx = buildAppContext(c.env);
  return ctx.auditEventWriter.prepare({
    id: systemIds.uuid(),
    actorUserId: userId,
    action,
    resourceType: 'message',
    resourceId: messageId,
    requestId: c.get('requestId') ?? null,
    metadata: JSON.stringify(metadata),
    // AuditEventInput.createdAt is a SQLite datetime string; the route
    // derives it once with sqliteTimestamp so the audit row and the
    // idempotency record share one timestamp.
    createdAt,
  }).statement as unknown as D1PreparedStatement;
}

export function messageRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * GET /api/v1/mailboxes/:mailboxId/messages
   *
   * Cursor-paginated inbox list, newest first.
   *
   * Query:
   *   cursor — opaque HMAC-signed cursor returned by a prior page (optional)
   *   limit  — page size, default 50, clamped to 50
   *
   * R-API-005: the cursor is signed with `env.CURSOR_SIGNING_KEY`
   * (D-CAP-043-D). A tampered cursor surfaces as `CursorInvalidError`
   * from the repository, which the route catches and maps to a
   * single 400 INVALID_CURSOR response.
   */
  routes.get('/mailboxes/:mailboxId/messages', requirePermission('message.read'), async (c) => {
    const mailboxId = c.req.param('mailboxId');
    // H6: requireMailboxReadAccess both authorises and yields the user —
    // no `c.get('userId') as string` cast after it.
    const userId = await requireMailboxReadAccess(c, mailboxId);

    const cursor = c.req.query('cursor') || undefined;
    const requestedLimit = parseInt(c.req.query('limit') ?? String(DEFAULT_LIMIT), 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    // R-API-005: resolve the HMAC key from the Secrets Store binding
    // (D-CAP-043-D). A missing key fails closed with INVALID_CURSOR_SIGNING_KEY
    // via the ConfigError path in platform/config.ts.
    const cursorSigningKey = await parseCursorSigningKey(c.env);

    let result;
    try {
      result = await listMessagesByMailbox(c.env.DB, mailboxId, userId, {
        ...(cursor !== undefined && { cursor }),
        limit,
        cursorSigningKey,
      });
    } catch (error) {
      // R-API-005: a tampered or malformed cursor surfaces as a single
      // stable 400 INVALID_CURSOR. We don't distinguish "bad shape"
      // from "bad signature" because the two are observationally
      // equivalent for an attacker; one error code keeps the API
      // surface stable (R-API-002).
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

  /**
   * GET /api/v1/mailboxes/:mailboxId/messages/:messageId
   *
   * Single message detail, including bodies and recipients.
   */
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

  /**
   * GET /api/v1/mailboxes/:mailboxId/messages/:messageId/thread
   *
   * CAP-043 AC 10. Same-thread messages for the mailbox, oldest-first.
   * The thread root is resolved at read time (D-CAP-043-C — see
   * message-read-repository THREAD_ROOT_SQL). Authz mirrors the detail
   * route exactly: requirePermission('message.read') + assertCan on the
   * path mailboxId (R-AUTHZ-003 / R-AUTHZ-004).
   *
   * 404 MESSAGE_NOT_FOUND (the detail route's code — no new code) when
   * the anchor is not in this mailbox, or is soft-deleted for the
   * calling user. A message that exists in ANOTHER mailbox returns the
   * same envelope as a non-existent one — no existence leak.
   */
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

  /**
   * PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read
   *
   * Marks the message as read for the requesting user (R-MESSAGE-005).
   * Idempotent: re-marking a read message returns 200 with no change.
   *
   * Idempotency (R-API-004), via the shared stanza: replay lookup before
   * the write, record after. markRead stays on the BEST-EFFORT settle by
   * recorded decision (D-CAP-043-I, Slice 3 fix H3): the use case's two
   * statements (mailbox_messages UPDATE + per-user UPSERT) ride an internal
   * batch that exposes no hook to append the record, and the write is a
   * genuinely re-runnable no-op on replay — re-marking a read message
   * changes nothing. The star and delete routes are NOT re-runnable and
   * therefore fold their records into the business batch (H1/H2).
   *
   * H6: the mailbox_message row lookup lives inside markMessageAsRead —
   * no raw SQL in the handler.
   */
  routes.patch(
    '/mailboxes/:mailboxId/messages/:messageId/read',
    requirePermission('message.read'),
    requireIdempotencyKey,
    async (c) => {
      const mailboxId = c.req.param('mailboxId');
      const messageId = c.req.param('messageId');
      const userId = await requireMailboxReadAccess(c, mailboxId);

      const { context, replay } = await beginIdempotentOperation(c, userId, MARK_READ_OPERATION);
      if (replay !== null) {
        return replay;
      }

      const marked = await markMessageAsRead(c.env.DB, mailboxId, messageId, userId);
      if (!marked) {
        // Same envelope as every other not-found path — a message that
        // exists in another mailbox is indistinguishable from a
        // non-existent one (no existence leak).
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      const successBody = JSON.stringify({ data: { ok: true } });

      // Best-effort settle (D-CAP-043-I): a lost INSERT race is swallowed
      // by writeIdempotencyRecord — the winner already stored the response
      // for this key, and re-marking read is a no-op either way.
      await writeIdempotencyRecord(c.env.DB, {
        id: systemIds.uuid(),
        actorId: userId,
        operation: MARK_READ_OPERATION,
        idempotencyKey: context.idempotencyKey,
        requestHash: context.requestHash,
        responseStatus: 200,
        responseJson: successBody,
        createdAt: sqliteTimestamp(systemClock.now()),
      });

      return new Response(successBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  /**
   * PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/star
   *
   * CAP-058: toggles the requesting user's per-message star state
   * (R-MESSAGE-005). The legacy mailbox compatibility column remains unchanged.
   *
   * D-CAP-043-H: rides the read surface — requirePermission('message.read')
   * + assertCan('read') — because it toggles a presentation flag, not a
   * destructive capability.
   *
   * Slice 3 fix H1 — batch-atomic star toggle. A toggle is NOT re-runnable
   * (re-running flips it back), so R-API-004 forbids the best-effort settle
   * here: the per-user state UPSERT, the idempotency record, and the audit row
   * (H4 / R-AUDIT-001 / D-CAP-043-I) run in ONE db.batch([...]) — an
   * implicit transaction. The shape is read-compute-write by design: a
   * batched UPDATE … RETURNING cannot feed the record's responseJson,
   * because D1 binds every statement's values at prepare time, before the
   * batch runs. So: read the current flag (getMessageStarState), compute
   * the target, build the response body from the KNOWN target, and fold
   * prepareSetMessageStar + record + audit into one batch. A UNIQUE race
   * on the record INSERT aborts the whole batch — the loser's business
   * write rolls back with it — and the catch replays the winner's stored
   * response via platform replayAfterRace. The read→batch window for
   * DIFFERENT-key concurrent toggles stays last-write-wins (D-CAP-043-A).
   *
   * Returns `{ data: { id, isStarred } }` with the post-toggle value.
   * A replayed key returns the stored response — including the ORIGINAL
   * direction's value; a fresh toggle needs a fresh key (the ApiClient
   * mints one per request, D-CAP-041-2).
   */
  routes.patch(
    '/mailboxes/:mailboxId/messages/:messageId/star',
    requirePermission('message.read'),
    requireIdempotencyKey,
    async (c) => {
      const mailboxId = c.req.param('mailboxId');
      const messageId = c.req.param('messageId');
      const userId = await requireMailboxReadAccess(c, mailboxId);

      const { context, replay } = await beginIdempotentOperation(c, userId, TOGGLE_STAR_OPERATION, {
        mailboxId,
        messageId,
      });
      if (replay !== null) {
        return replay;
      }

      // CAP-058 read step. Null means no visible mailbox_messages row for this
      // (mailbox, message) pair — same envelope as every other not-found
      // path; a message that exists in another mailbox is indistinguishable
      // from a non-existent one (no existence leak). Thrown BEFORE any
      // write, so there is nothing to roll back.
      const currentStarred = await getMessageStarState(c.env.DB, mailboxId, messageId, userId);
      if (currentStarred === null) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      const target: 0 | 1 = currentStarred ? 0 : 1;
      const successBody = JSON.stringify({ data: { id: messageId, isStarred: target } });
      const now = sqliteTimestamp(systemClock.now());

      try {
        // CAP-058 + H4: ONE batch — per-user state write + idempotency record + audit row
        // commit or roll back together.
        await c.env.DB.batch([
          prepareSetMessageStar(c.env.DB, mailboxId, messageId, userId, target, now),
          prepareCreateIdempotencyRecord(c.env.DB, {
            id: systemIds.uuid(),
            actorId: userId,
            operation: TOGGLE_STAR_OPERATION,
            idempotencyKey: context.idempotencyKey,
            requestHash: context.requestHash,
            responseStatus: 200,
            responseJson: successBody,
            createdAt: now,
          }),
          prepareMessageAudit(
            c,
            userId,
            'message.star_toggled',
            messageId,
            { mailboxId, isStarred: target },
            now,
          ),
        ]);
      } catch (error) {
        if (!isIdempotencyUniqueViolation(error)) {
          throw error;
        }
        // Lost the INSERT race. The batch was an implicit transaction, so
        // this request's per-user star UPSERT rolled back with the failed record
        // INSERT — only the winner's write is in the database. Replay it.
        return replayAfterRace(
          c.env.DB,
          userId,
          TOGGLE_STAR_OPERATION,
          context.idempotencyKey,
          context.requestHash,
        );
      }

      return new Response(successBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...(c.get('requestId') ? { 'X-Request-Id': c.get('requestId') } : {}),
        },
      });
    },
  );

  /**
   * DELETE /api/v1/mailboxes/:mailboxId/messages/:messageId
   *
   * CAP-043 Slice 3 / AC 15. Per-user soft delete (D-CAP-043-B,
   * R-MESSAGE-005): writes only the calling user's message_user_state row,
   * so user A's delete never hides the message from user B (AC 17).
   *
   * D-CAP-043-H: rides the read surface — the user tidying their own inbox
   * view, not exercising a destructive capability. The `message.delete`
   * permission and the owner-only `delete_message` mailbox op stay
   * reserved for hard delete (out of scope for CAP-043).
   *
   * Slice 3 fix H2 — batch-atomic soft delete. The UPSERT, the idempotency
   * record, and the audit row (H4 / R-AUDIT-001 / D-CAP-043-I) run in ONE
   * db.batch([...]) — an implicit transaction. A UNIQUE race on the record
   * INSERT rolls the soft delete back with it, and the catch replays the
   * winner's stored response via platform replayAfterRace. Unlike star
   * there is no read-compute-write: the response is the constant
   * `204 + ''`, so nothing has to be read from the write.
   *
   * D-CAP-043-E: returns 204 No Content with an empty body. The
   * idempotency record stores responseStatus 204 + responseJson '' and a
   * replay returns the same empty 204 (R-API-004; replayResponse passes
   * the empty body as null, H3).
   */
  routes.delete(
    '/mailboxes/:mailboxId/messages/:messageId',
    requirePermission('message.read'),
    requireIdempotencyKey,
    async (c) => {
      const mailboxId = c.req.param('mailboxId');
      const messageId = c.req.param('messageId');
      const userId = await requireMailboxReadAccess(c, mailboxId);

      const { context, replay } = await beginIdempotentOperation(
        c,
        userId,
        DELETE_MESSAGE_OPERATION,
      );
      if (replay !== null) {
        return replay;
      }

      // H2 build step. Gate 1: the UPSERT conflicts on the post-0017
      // composite PK and preserves is_read / read_at on conflict. Null
      // means no mailbox_messages row for this (mailbox, message) pair —
      // the same 404 envelope as every other not-found path (no
      // cross-mailbox existence leak), thrown BEFORE any write.
      const softDelete = await prepareSoftDeleteMessageForUser(
        c.env.DB,
        mailboxId,
        messageId,
        userId,
      );
      if (softDelete === null) {
        throw new DomainError({
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found',
          httpStatus: 404,
        });
      }

      const now = sqliteTimestamp(systemClock.now());

      try {
        // H2 + H4: ONE batch — soft delete + idempotency record + audit
        // row commit or roll back together. 204 + '' is deterministic.
        await c.env.DB.batch([
          softDelete,
          prepareCreateIdempotencyRecord(c.env.DB, {
            id: systemIds.uuid(),
            actorId: userId,
            operation: DELETE_MESSAGE_OPERATION,
            idempotencyKey: context.idempotencyKey,
            requestHash: context.requestHash,
            responseStatus: 204,
            responseJson: '',
            createdAt: now,
          }),
          prepareMessageAudit(c, userId, 'message.soft_deleted', messageId, { mailboxId }, now),
        ]);
      } catch (error) {
        if (!isIdempotencyUniqueViolation(error)) {
          throw error;
        }
        // Lost the INSERT race — the batch rolled the soft delete back
        // with the failed record INSERT. Replay the winner's response.
        return replayAfterRace(
          c.env.DB,
          userId,
          DELETE_MESSAGE_OPERATION,
          context.idempotencyKey,
          context.requestHash,
        );
      }

      return new Response(null, { status: 204 });
    },
  );

  return routes;
}
