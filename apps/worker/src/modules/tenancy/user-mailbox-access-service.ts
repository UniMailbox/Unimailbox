import type {
  AdminUserMailboxAccessRequest,
  AdminUserMailboxItem,
  AuditEventWriter,
} from '@unimailbox/contracts';
import { findActiveUserById } from '../identity';
import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import { systemIds } from '../../platform/ids';
import { systemClock } from '../../platform/clock';
import {
  assertSameRequestHash,
  findIdempotencyRecord,
  prepareCreateIdempotencyRecord,
  sqliteTimestamp,
} from '../../platform/idempotency';
import { findManagedDomainById } from './domain-repository';
import {
  findMailboxById,
  prepareCreateMailboxMember,
  prepareDeleteMailboxMember,
  prepareSetMailboxMemberRole,
  listAdministrativeMailboxes,
} from './mailbox-repository';

function requireShare(hasGlobalShare: boolean): void {
  if (!hasGlobalShare) {
    throw new DomainError({
      code: 'PERMISSION_DENIED',
      message: 'Permission denied: mailbox.share',
      httpStatus: 403,
    });
  }
}

export async function listUserMailboxAccess(
  db: Database,
  userId: string | null,
  hasGlobalShare: boolean,
): Promise<AdminUserMailboxItem[]> {
  requireShare(hasGlobalShare);
  if (userId !== null && !(await findActiveUserById(db, userId))) {
    throw new DomainError({
      code: 'MAILBOX_MEMBER_USER_NOT_FOUND',
      message: 'Active user not found',
      httpStatus: 404,
    });
  }
  return listAdministrativeMailboxes(db, userId);
}

/** Prepared grants join the account's creation transaction, never a follow-up request. */
export async function prepareInitialMailboxAccess(
  db: Database,
  input: {
    userId: string;
    mailboxIds: readonly string[];
    hasGlobalShare: boolean;
    createdAt: string;
  },
): Promise<D1PreparedStatement[]> {
  if (input.mailboxIds.length === 0) return [];
  requireShare(input.hasGlobalShare);
  const statements: D1PreparedStatement[] = [];
  for (const mailboxId of input.mailboxIds) {
    const mailbox = await findMailboxById(db, mailboxId);
    if (
      !mailbox ||
      mailbox.status !== 'active' ||
      (await findManagedDomainById(db, mailbox.domainId))?.status !== 'active'
    ) {
      throw new DomainError({
        code: 'MAILBOX_NOT_FOUND',
        message: 'Active mailbox not found',
        httpStatus: 404,
      });
    }
    statements.push(
      prepareCreateMailboxMember(db, {
        mailboxId,
        userId: input.userId,
        role: 'admin',
        createdAt: input.createdAt,
      }),
    );
  }
  return statements;
}

/** Replace or revoke one grant. Audit and idempotency commit with the membership. */
export async function setUserMailboxAccess(
  dependencies: { db: Database; auditEventWriter: AuditEventWriter },
  input: {
    actorUserId: string;
    userId: string;
    mailboxId: string;
    hasGlobalShare: boolean;
    request: AdminUserMailboxAccessRequest;
    requestId: string | null;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<{ status: 200; responseJson: string }> {
  requireShare(input.hasGlobalShare);
  const { db, auditEventWriter } = dependencies;
  if (!(await findActiveUserById(db, input.userId))) {
    throw new DomainError({
      code: 'MAILBOX_MEMBER_USER_NOT_FOUND',
      message: 'Active user not found',
      httpStatus: 404,
    });
  }
  const mailbox = await findMailboxById(db, input.mailboxId);
  if (
    !mailbox ||
    mailbox.status !== 'active' ||
    (await findManagedDomainById(db, mailbox.domainId))?.status !== 'active'
  ) {
    throw new DomainError({
      code: 'MAILBOX_NOT_FOUND',
      message: 'Active mailbox not found',
      httpStatus: 404,
    });
  }
  if (mailbox.ownerUserId === input.userId) {
    throw new DomainError({
      code: 'MAILBOX_OWNER_CANNOT_BE_MEMBER',
      message: 'Mailbox owners have implicit full access',
      httpStatus: 409,
    });
  }
  const operation = `PUT /api/v1/admin/users/${input.userId}/mailboxes/${input.mailboxId}`;
  const existing = await findIdempotencyRecord(
    db,
    input.actorUserId,
    operation,
    input.idempotencyKey,
  );
  if (existing) {
    assertSameRequestHash(existing, input.requestHash);
    return { status: 200, responseJson: existing.responseJson };
  }
  const now = sqliteTimestamp(systemClock.now());
  const responseJson = JSON.stringify({
    data: { userId: input.userId, mailboxId: input.mailboxId, role: input.request.role },
  });
  await db.batch([
    prepareCreateIdempotencyRecord(db, {
      id: systemIds.uuid(),
      actorId: input.actorUserId,
      operation,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      responseStatus: 200,
      responseJson,
      createdAt: now,
    }),
    input.request.role === null
      ? prepareDeleteMailboxMember(db, input.mailboxId, input.userId)
      : prepareSetMailboxMemberRole(db, {
          mailboxId: input.mailboxId,
          userId: input.userId,
          role: input.request.role,
          createdAt: now,
        }),
    auditEventWriter.prepare({
      id: systemIds.uuid(),
      actorUserId: input.actorUserId,
      action: 'mailbox.member_access_changed',
      resourceType: 'mailbox',
      resourceId: input.mailboxId,
      requestId: input.requestId,
      metadata: JSON.stringify({ memberUserId: input.userId, role: input.request.role }),
      createdAt: now,
    }).statement as unknown as D1PreparedStatement,
  ]);
  return { status: 200, responseJson };
}
