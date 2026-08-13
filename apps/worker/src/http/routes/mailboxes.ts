// http/routes/mailboxes — CAP-020 mailbox routes.
// Hono sub-app for /api/v1/mailboxes/* endpoints: create, list.
//
// R-AUTHZ-003: Two layers — requirePermission('mailbox.create') + mailbox-scoped checks.
// R-MAILBOX-003: Owner (the authenticated user) is implicitly a member.
// R-DATA-001: localPart is case-insensitive (COLLATE NOCASE).

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
import type { AppEnv } from '../../platform/env';

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
  routes.post('/mailboxes', requirePermission('mailbox.create'), async (c) => {
    const userId = c.get('userId');
    if (!userId) {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    const body = createMailboxRequestSchema.parse(await c.req.json());

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

      return c.json({ data: result });
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
