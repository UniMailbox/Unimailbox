// authorizer — mailbox-scoped authorization checks.
// Owner: tenancy module. Private file — export through modules/tenancy/index.ts.
//
// R-AUTHZ-003: Two independent layers — global (requirePermission) + mailbox-scoped (assertCan).
// R-AUTHZ-004: Authorize against the target mailbox/message ID, never client-supplied IDs.
// R-MAILBOX-003: Owner is implicitly authorized for all ops.
//
// Permission matrix from .claude/rules/security.md:
// | op      | owner | viewer | sender | admin |
// |---------|-------|--------|--------|-------|
// | read    | ✓     | ✓      | ✓      | ✓     |
// | send    | ✓     | ✗      | ✓      | ✓     |
// | rename  | ✓     | ✗      | ✗      | ✓     |
// | manage_members | ✓ | ✗      | ✗      | ✓     |
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
 * 1. Owner can do everything (implicit membership per R-MAILBOX-003)
 * 2. Global administrator (has role.manage) can do everything except delete operations
 * 3. Members are authorized per the permission matrix
 * 4. Non-owners with no membership are denied
 *
 * @param db — D1 database binding
 * @param userId — UUID of the user performing the operation
 * @param mailboxId — UUID of the target mailbox (authorizes against this, not client input)
 * @param op — The operation to perform
 * @param isAdmin — Optional pre-computed admin status (from admin.checkPermission('role.manage'))
 *                   If not provided, skips the admin check path.
 * @throws DomainError with MAILBOX_NOT_FOUND (404) or MAILBOX_ACCESS_DENIED (403)
 */
export async function assertCan(
  db: Database,
  userId: string,
  mailboxId: string,
  op: MailboxOp,
  isAdmin?: boolean,
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

  // 2. Owner can do everything (implicit membership per R-MAILBOX-003)
  if (mailbox.ownerUserId === userId) {
    return;
  }

  // 3. Check if user has administrator role (global admin bypass)
  // Admins can do everything except delete_message and delete_mailbox
  if (isAdmin === true) {
    if (op === 'delete_message' || op === 'delete_mailbox') {
      throw new DomainError({
        code: 'MAILBOX_ACCESS_DENIED',
        message: `Operation '${op}' not allowed for global administrators`,
        httpStatus: 403,
      });
    }
    return;
  }

  // 4. Check member role (explicit membership via mailbox_members table)
  const member = await findMailboxMember(db, mailboxId, userId);
  if (!member) {
    throw new DomainError({
      code: 'MAILBOX_ACCESS_DENIED',
      message: `User is not a member of this mailbox`,
      httpStatus: 403,
    });
  }

  // 5. Check permission matrix
  const allowedOps: Record<string, string[]> = {
    viewer: ['read'],
    sender: ['read', 'send'],
    admin: ['read', 'send', 'rename', 'manage_members'],
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
