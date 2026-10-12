// authorizer — mailbox-scoped authorization checks.
// Owner: tenancy module. Private file — export through modules/tenancy/index.ts.
//
// R-AUTHZ-003: Two independent layers — global (requirePermission) + mailbox-scoped (assertCan).
// R-AUTHZ-004: Authorize against the target mailbox/message ID, never client-supplied IDs.
// R-MAILBOX-003: Owner has implicit mailbox operations; grant management is admin-only.
//
// Permission matrix from .claude/rules/security.md:
// | op      | owner | viewer | sender | admin |
// |---------|-------|--------|--------|-------|
// | read    | ✓     | ✓      | ✓      | ✓     |
// | send    | ✓     | ✗      | ✓      | ✓     |
// | rename  | ✓     | ✗      | ✗      | ✓     |
// | manage_members | ✗ | ✗      | ✗      | ✗     |
// | delete_message | ✓ | ✗      | ✗      | ✗     |
// | delete_mailbox | ✓ | ✗      | ✗      | ✗     |

import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import { findMailboxById, findMailboxMember } from './mailbox-repository';

export type MailboxOp =
  | 'read'
  | 'send'
  | 'rename'
  | 'manage_members'
  | 'delete_message'
  | 'delete_mailbox';

/**
 * Asserts that a user can perform an operation on a mailbox.
 *
 * Throws DomainError with MAILBOX_NOT_FOUND (404) or MAILBOX_ACCESS_DENIED (403)
 * if the operation is not allowed.
 *
 * Authorization logic:
 * 1. Member management requires the separate administrative sharing service.
 * 2. Owner can perform mailbox operations (implicit membership per R-MAILBOX-003)
 * 3. Members are authorized per the permission matrix
 * 4. Non-owners with no membership are denied, including global administrators
 *
 * @param db — D1 database binding
 * @param userId — UUID of the user performing the operation
 * @param mailboxId — UUID of the target mailbox (authorizes against this, not client input)
 * @param op — The operation to perform
 * @throws DomainError with MAILBOX_NOT_FOUND (404) or MAILBOX_ACCESS_DENIED (403)
 */
export async function assertCan(
  db: Database,
  userId: string,
  mailboxId: string,
  op: MailboxOp,
): Promise<void> {
  // 1. Check if mailbox exists and get owner info
  const mailbox = await findMailboxById(db, mailboxId);
  if (!mailbox) {
    throw new DomainError({
      code: 'MAILBOX_NOT_FOUND',
      message: 'Mailbox not found',
      httpStatus: 404,
    });
  }

  // Mailbox ownership/membership never conveys permission to assign grants.
  if (op === 'manage_members') {
    throw new DomainError({
      code: 'MAILBOX_ACCESS_DENIED',
      message: 'Mailbox access must be assigned by an administrator',
      httpStatus: 403,
    });
  }

  // 2. Owner has implicit mailbox operation permissions (R-MAILBOX-003)
  if (mailbox.ownerUserId === userId) {
    return;
  }

  // 3. Check member role (explicit membership via mailbox_members table)
  const member = await findMailboxMember(db, mailboxId, userId);
  if (!member) {
    throw new DomainError({
      code: 'MAILBOX_ACCESS_DENIED',
      message: `User is not a member of this mailbox`,
      httpStatus: 403,
    });
  }

  // 4. Check permission matrix
  const allowedOps: Record<string, string[]> = {
    viewer: ['read'],
    sender: ['read', 'send'],
    admin: ['read', 'send', 'rename'],
  };

  const allowedForRole = allowedOps[member.role];
  if (!allowedForRole || !allowedForRole.includes(op)) {
    throw new DomainError({
      code: 'MAILBOX_ACCESS_DENIED',
      message: `Operation '${op}' not allowed for role '${member.role}'`,
      httpStatus: 403,
    });
  }
}
