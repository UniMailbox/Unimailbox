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

import { Hono } from 'hono';
import {
  createMailboxRequestSchema,
} from '@unimailbox/contracts';
import {
  createMailbox,
  listMailboxesByOwner,
} from '../../modules/tenancy';
import { createAuditEvent } from '../../modules/admin';
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
} from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';

const CREATE_MAILBOX_OPERATION = 'POST /api/v1/mailboxes';

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
  routes.post('/mailboxes', requirePermission('mailbox.create'), requireIdempotencyKey, async (c) => {
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

    const body = createMailboxRequestSchema.parse(JSON.parse(rawBody));

    // Verify the domain exists
    const domain = await c.env.DB
      .prepare('SELECT id, name, status FROM managed_domains WHERE id = ?')
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

    const now = systemClock.now().toISOString();
    const mailboxId = systemIds.uuid();

    try {
      const result = await createMailbox(c.env.DB, {
        id: mailboxId,
        domainId: body.domainId,
        ownerUserId: userId,
        localPart: body.localPart,
        displayName: body.displayName ?? '',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      // R-AUDIT-001: record the state transition.
      await createAuditEvent(c.env.DB, {
        id: systemIds.uuid(),
        actorUserId: userId,
        action: 'mailbox.create',
        resourceType: 'mailbox',
        resourceId: mailboxId,
        createdAt: now.slice(0, 19).replace('T', ' '),
      });

      // Best-effort idempotency record (the createMailbox + createAuditEvent
      // pair is two separate D1 statements owned by the modules; folding the
      // idempotency row into a single batch with them would require touching
      // modules/tenancy + modules/admin, which the implementer does not own).
      // Retries between the use-case commit and this INSERT are safe: the
      // mailbox-create UNIQUE constraint on (domain_id, local_part) is the
      // natural dedup — re-running with the same key replays the 409 on the
      // second create and the client gets a DOMAIN_ADDRESS_TAKEN.
      const idempotencyNow = sqliteTimestamp(systemClock.now());
      const successBody = JSON.stringify({ data: result });
      await prepareCreateIdempotencyRecord(c.env.DB, {
        id: systemIds.uuid(),
        actorId: userId,
        operation: CREATE_MAILBOX_OPERATION,
        idempotencyKey,
        requestHash,
        responseStatus: 200,
        responseJson: successBody,
        createdAt: idempotencyNow,
      }).run();

      return new Response(successBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // D1 error for unique constraint violation
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed')
      ) {
        throw new DomainError({
          code: 'DOMAIN_ADDRESS_TAKEN',
          message: 'Email address already exists',
          httpStatus: 409,
        });
      }
      throw error;
    }
  });

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

  return routes;
}
