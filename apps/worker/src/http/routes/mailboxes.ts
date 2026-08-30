// http/routes/mailboxes — CAP-020 mailbox routes.
// Hono sub-app for /api/v1/mailboxes/* endpoints: create, list.
//
// R-AUTHZ-003: Two layers — global `requirePermission` middleware + per-request
// scope checks. The two mailbox routes do not have a pre-existing mailbox to
// scope against: `POST` creates a new mailbox (no target yet) and `GET` returns
// mailboxes owned by the authenticated user (the SQL `WHERE owner_user_id = ?`
// is the scope check). The mailbox-scoped `assertCan` authorizer is therefore
// not applicable on these routes — it is exercised on routes that operate on
// a specific mailbox by ID (see http/routes/messages.ts and compose.ts).
// R-MAILBOX-003: Owner (the authenticated user) is implicitly a member.
// R-DATA-001: localPart is case-insensitive (COLLATE NOCASE).
// R-API-004: POST /mailboxes requires Idempotency-Key; replays return the
// stored response.

import { Hono, type Context } from 'hono';
import {
  createMailboxRequestSchema,
  addMailboxMemberRequestSchema,
  uuidSchema,
} from '@unimailbox/contracts';
import {
  listMailboxesByOwner,
  assertCanManageMailboxMembers,
  addMailboxMember,
  listMailboxMembers,
  removeMailboxMember,
  mailboxMemberOperation,
} from '../../modules/tenancy';
import { checkPermission, prepareCreateAuditEvent } from '../../modules/admin';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { DomainError } from '../../platform/errors';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
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
import { buildAppContext } from '../../app-context';

const CREATE_MAILBOX_OPERATION = 'POST /api/v1/mailboxes';

function parseMailboxId(value: string): string {
  return uuidSchema.parse(value);
}

function withRequestId(c: Context<AppEnv>, response: Response): Response {
  const requestId = c.get('requestId');
  if (requestId) response.headers.set('X-Request-Id', requestId);
  return response;
}

function memberResponse(c: Context<AppEnv>, body: string, status: 200 | 201): Response {
  const response = new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  return withRequestId(c, response);
}

async function requireMailboxShareAccess(
  c: Context<AppEnv>,
  mailboxId: string,
): Promise<{ userId: string; hasGlobalShare: boolean }> {
  const userId = c.get('userId');
  if (!userId) {
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  }
  const hasGlobalShare = await checkPermission(c.env.DB, userId, 'mailbox.share');
  await assertCanManageMailboxMembers(c.env.DB, userId, mailboxId, hasGlobalShare);
  return { userId, hasGlobalShare };
}

export function mailboxRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * POST /api/v1/mailboxes
   *
   * Create a new mailbox on a managed domain.
   *
   * - Validates request body with createMailboxRequestSchema
   * - Checks user has mailbox.create permission
   * - Validates domain exists
   * - Creates mailbox with authenticated user as owner
   * - Returns mailbox info with full address
   *
   * Returns 403 PERMISSION_DENIED if user lacks mailbox.create permission.
   * Returns 409 DOMAIN_ADDRESS_TAKEN if address already exists (case-insensitive).
   */
  routes.post(
    '/mailboxes',
    requirePermission('mailbox.create'),
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

      // Read raw body for hashing so a replay is byte-identical (no JSON
      // re-serialise, which would change whitespace / key order).
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

      // Idempotency replay lookup (before parsing — replays skip validation
      // and the use case).
      const existing = await findIdempotencyRecord(
        c.env.DB,
        userId,
        CREATE_MAILBOX_OPERATION,
        idempotencyKey,
      );
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return replayResponse(existing);
      }

      // R-INPUT-002 / D-CAP-037-A: helper throws INVALID_JSON before the
      // D1 batch, so no idempotency_records row is written on malformed
      // bodies (a corrected retry with the same Idempotency-Key succeeds).
      const body = parseJsonBody(rawBody, createMailboxRequestSchema, {
        event: 'mailboxes.create.invalid_json',
        actorUserId: userId,
      });

      // Verify the domain exists
      const domain = await c.env.DB.prepare(
        'SELECT id, name, status FROM managed_domains WHERE id = ?',
      )
        .bind(body.domainId)
        .first<{ id: string; name: string; status: string }>();

      if (!domain) {
        throw new DomainError({
          code: 'DOMAIN_NOT_FOUND',
          message: 'Domain not found',
          httpStatus: 404,
        });
      }

      if (domain.status !== 'active') {
        throw new DomainError({
          code: 'DOMAIN_NOT_ACTIVE',
          message: 'Domain is not active',
          httpStatus: 409,
        });
      }

      const mailboxId = systemIds.uuid();
      const auditEventId = systemIds.uuid();
      const idempotencyRecordId = systemIds.uuid();

      const now = sqliteTimestamp(systemClock.now());
      const address = `${body.localPart}@${domain.name}`;

      // CAP-046 / D-CAP-046-A: pull the request correlation UUID the
      // request-id middleware stamped on this request so the audit row
      // carries it through.
      const requestId = c.get('requestId') ?? null;

      // Fix 4 (strict batch mode): Build the success body up front so we can
      // store the exact same JSON the client will receive on a replay.
      const successBody = JSON.stringify({
        data: {
          id: mailboxId,
          address,
          displayName: body.displayName ?? '',
          status: 'active',
          domainId: body.domainId,
          localPart: body.localPart,
          ownerUserId: userId,
        },
      });

      // Fix 4 (R-API-004, R-OUTBOUND-006): mailbox + audit_event + idempotency
      // record are written in one D1 batch so they land atomically.
      // CAP-046 fix slice (AC 19): the audit_events INSERT goes through
      // `prepareCreateAuditEvent` (single source of truth for the
      // audit_events schema at modules/admin/audit-event-repository.ts).
      const statements: D1PreparedStatement[] = [
        // 1. Mailbox row.
        c.env.DB.prepare(
          `INSERT INTO mailboxes (
           id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          mailboxId,
          body.domainId,
          userId,
          body.localPart,
          body.displayName ?? '',
          'active',
          now,
          now,
        ),
        // 2. Audit event (R-AUDIT-001 + CAP-046 / D-CAP-046-A: carries
        // the request-id the middleware stamped on this /mailboxes POST).
        prepareCreateAuditEvent(c.env.DB, {
          id: auditEventId,
          actorUserId: userId,
          action: 'mailbox.create',
          resourceType: 'mailbox',
          resourceId: mailboxId,
          requestId,
          createdAt: now,
        }),
        // 3. Idempotency record (R-API-004, R-OUTBOUND-006).
        prepareCreateIdempotencyRecord(c.env.DB, {
          id: idempotencyRecordId,
          actorId: userId,
          operation: CREATE_MAILBOX_OPERATION,
          idempotencyKey,
          requestHash,
          responseStatus: 200,
          responseJson: successBody,
          createdAt: now,
        }),
      ];

      try {
        await c.env.DB.batch(statements);
      } catch (error) {
        // Fix 3: Handle UNIQUE-constraint race — two concurrent requests with
        // the same Idempotency-Key raced to INSERT. Re-read the winner's row
        // and replay it.
        if (isIdempotencyUniqueViolation(error)) {
          return replayAfterRace(
            c.env.DB,
            userId,
            CREATE_MAILBOX_OPERATION,
            idempotencyKey,
            requestHash,
          );
        }

        // D1 error for mailbox unique constraint violation (domain_id, local_part)
        if (
          error instanceof Error &&
          error.message.includes('UNIQUE constraint failed') &&
          error.message.includes('mailboxes')
        ) {
          throw new DomainError({
            code: 'DOMAIN_ADDRESS_TAKEN',
            message: 'Email address already exists',
            httpStatus: 409,
          });
        }
        throw error;
      }

      return new Response(successBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  /**
   * GET /api/v1/mailboxes
   *
   * List all mailboxes owned by the authenticated user.
   *
   * - Checks user has message.read permission (as a proxy for access)
   * - Returns only mailboxes where user is the owner
   *
   * Returns 403 PERMISSION_DENIED if user lacks message.read permission.
   */
  routes.get('/mailboxes', requirePermission('message.read'), async (c) => {
    const userId = c.get('userId');
    if (!userId) {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    const mailboxes = await listMailboxesByOwner(c.env.DB, userId);

    return c.json({ data: { items: mailboxes } });
  });

  // CAP-057 mailbox sharing. These routes intentionally do not use
  // requirePermission('mailbox.manage'): ownership or the separate global
  // mailbox.share permission is the authority for the target mailbox.
  routes.post('/mailboxes/:mailboxId/members', requireIdempotencyKey, async (c) => {
    const mailboxId = parseMailboxId(c.req.param('mailboxId'));
    const access = await requireMailboxShareAccess(c, mailboxId);
    const rawBody = await c.req.text();
    // Validate before hashing so equivalent JSON encodings replay the same
    // operation, while malformed requests create no idempotency row.
    const request = parseJsonBody(rawBody, addMailboxMemberRequestSchema, {
      event: 'mailboxes.members.add.invalid_json',
      actorUserId: access.userId,
    });
    const requestHash = await sha256Hex(JSON.stringify(request));
    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const operation = mailboxMemberOperation('POST', mailboxId);
    const existing = await findIdempotencyRecord(
      c.env.DB,
      access.userId,
      operation,
      idempotencyKey,
    );
    if (existing) {
      assertSameRequestHash(existing, requestHash);
      return withRequestId(c, replayResponse(existing));
    }

    try {
      const result = await addMailboxMember(
        {
          db: c.env.DB,
          auditEventWriter: buildAppContext(c.env).auditEventWriter,
        },
        {
          actorUserId: access.userId,
          mailboxId,
          request,
          hasGlobalShare: access.hasGlobalShare,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash,
        },
      );
      return memberResponse(c, result.responseJson, result.status);
    } catch (error) {
      // The member primary key and idempotency unique index are the
      // concurrency guards. A same-key race replays the committed winner;
      // a different key racing for the same member maps to the stable
      // duplicate code.
      if (isIdempotencyUniqueViolation(error)) {
        return withRequestId(
          c,
          await replayAfterRace(c.env.DB, access.userId, operation, idempotencyKey, requestHash),
        );
      }
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        // The membership insert runs before the idempotency insert. A
        // same-key concurrent request can therefore report the member
        // primary-key collision even though the winner's idempotency row is
        // already committed. Replay that winner; a different key remains a
        // genuine duplicate.
        const winner = await findIdempotencyRecord(
          c.env.DB,
          access.userId,
          operation,
          idempotencyKey,
        );
        if (winner) {
          assertSameRequestHash(winner, requestHash);
          return withRequestId(c, replayResponse(winner));
        }
        if (error.message.includes('mailbox_members')) {
          throw new DomainError({
            code: 'MAILBOX_MEMBER_DUPLICATE',
            message: 'User is already a member of this mailbox',
            httpStatus: 409,
          });
        }
      }
      throw error;
    }
  });

  routes.get('/mailboxes/:mailboxId/members', async (c) => {
    const mailboxId = parseMailboxId(c.req.param('mailboxId'));
    const access = await requireMailboxShareAccess(c, mailboxId);
    const items = await listMailboxMembers(
      {
        db: c.env.DB,
        auditEventWriter: buildAppContext(c.env).auditEventWriter,
      },
      {
        actorUserId: access.userId,
        mailboxId,
        hasGlobalShare: access.hasGlobalShare,
      },
    );
    return c.json({ data: { items } });
  });

  routes.delete('/mailboxes/:mailboxId/members/:userId', requireIdempotencyKey, async (c) => {
    const mailboxId = parseMailboxId(c.req.param('mailboxId'));
    const memberUserId = uuidSchema.parse(c.req.param('userId'));
    const access = await requireMailboxShareAccess(c, mailboxId);
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

    const operation = mailboxMemberOperation('DELETE', mailboxId, memberUserId);
    const existing = await findIdempotencyRecord(
      c.env.DB,
      access.userId,
      operation,
      idempotencyKey,
    );
    if (existing) {
      assertSameRequestHash(existing, requestHash);
      return withRequestId(c, replayResponse(existing));
    }

    try {
      const result = await removeMailboxMember(
        {
          db: c.env.DB,
          auditEventWriter: buildAppContext(c.env).auditEventWriter,
        },
        {
          actorUserId: access.userId,
          mailboxId,
          memberUserId,
          hasGlobalShare: access.hasGlobalShare,
          requestId: c.get('requestId') ?? null,
          idempotencyKey,
          requestHash,
        },
      );
      return memberResponse(c, result.responseJson, result.status);
    } catch (error) {
      if (isIdempotencyUniqueViolation(error)) {
        return withRequestId(
          c,
          await replayAfterRace(c.env.DB, access.userId, operation, idempotencyKey, requestHash),
        );
      }
      throw error;
    }
  });

  return routes;
}
