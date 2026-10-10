// mailbox-member-service — CAP-057 mailbox sharing use cases.
// Tenancy owns membership rows and depends on Identity only through its
// credential-free public summary seam. Routes provide the audit writer from
// the composition root and remain responsible for HTTP parsing/envelopes.

import {
  type AddMailboxMemberRequest,
  type AuditEventWriter,
  type MailboxMemberItem,
  type MailboxMemberRole,
} from '@unimailbox/contracts';
import { findActiveUserByEmail, findActiveUsersByIds, type PublicUserSummary } from '../identity';
import type { Clock } from '../../platform/clock';
import { systemClock } from '../../platform/clock';
import type { Database } from '../../platform/database';
import type { IdGenerator } from '../../platform/ids';
import { systemIds } from '../../platform/ids';
import { DomainError } from '../../platform/errors';
import {
  assertSameRequestHash,
  findIdempotencyRecord,
  prepareCreateIdempotencyRecord,
  sqliteTimestamp,
} from '../../platform/idempotency';
import {
  findMailboxById,
  findMailboxMember,
  listMailboxMemberRows,
  prepareCreateMailboxMember,
  prepareDeleteMailboxMember,
  prepareRequireMailboxMemberDeleted,
} from './mailbox-repository';
import type { MailboxInfo } from './mailbox-repository';

export interface MailboxMemberServiceDependencies {
  readonly db: Database;
  readonly auditEventWriter: AuditEventWriter;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export interface AddMailboxMemberInput {
  readonly actorUserId: string;
  readonly mailboxId: string;
  readonly request: AddMailboxMemberRequest;
  readonly hasGlobalShare: boolean;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface ListMailboxMembersInput {
  readonly actorUserId: string;
  readonly mailboxId: string;
  readonly hasGlobalShare: boolean;
}

export interface RemoveMailboxMemberInput {
  readonly actorUserId: string;
  readonly mailboxId: string;
  readonly memberUserId: string;
  readonly hasGlobalShare: boolean;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface MailboxMemberServiceResult {
  readonly status: 200 | 201;
  readonly responseJson: string;
  readonly replayed: boolean;
}

export function mailboxMemberOperation(
  method: 'POST' | 'DELETE',
  mailboxId: string,
  memberUserId?: string,
): string {
  const suffix = memberUserId ? `/members/${memberUserId}` : '/members';
  return `${method} /api/v1/mailboxes/${mailboxId}${suffix}`;
}

async function replayIfPresent(
  db: Database,
  actorUserId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<MailboxMemberServiceResult | null> {
  const record = await findIdempotencyRecord(db, actorUserId, operation, idempotencyKey);
  if (!record) return null;
  assertSameRequestHash(record, requestHash);
  return {
    status: record.responseStatus === 201 ? 201 : 200,
    responseJson: record.responseJson,
    replayed: true,
  };
}

function mailboxNotFound(): never {
  throw new DomainError({
    code: 'MAILBOX_NOT_FOUND',
    message: 'Mailbox not found',
    httpStatus: 404,
  });
}

/** Owner or global mailbox.share; explicit mailbox-admin is deliberately insufficient. */
export async function assertCanManageMailboxMembers(
  db: Database,
  actorUserId: string,
  mailboxId: string,
  hasGlobalShare: boolean,
): Promise<MailboxInfo> {
  const mailbox = await findMailboxById(db, mailboxId);
  if (!mailbox) mailboxNotFound();
  // Missing and foreign mailboxes intentionally collapse to the same 404 so
  // member data cannot be probed through the sharing surface.
  if (mailbox.ownerUserId !== actorUserId && !hasGlobalShare) mailboxNotFound();
  return mailbox;
}

function memberItem(
  summary: PublicUserSummary,
  role: MailboxMemberRole,
  createdAt: string,
): MailboxMemberItem {
  return {
    userId: summary.userId,
    email: summary.email,
    displayName: summary.displayName,
    role,
    createdAt,
  };
}

/** Adds one member and folds membership, audit, and idempotency into one batch. */
export async function addMailboxMember(
  dependencies: MailboxMemberServiceDependencies,
  input: AddMailboxMemberInput,
): Promise<MailboxMemberServiceResult> {
  const { db, auditEventWriter } = dependencies;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;

  await assertCanManageMailboxMembers(db, input.actorUserId, input.mailboxId, input.hasGlobalShare);

  const target = await findActiveUserByEmail(db, input.request.email);
  if (!target) {
    throw new DomainError({
      code: 'MAILBOX_MEMBER_USER_NOT_FOUND',
      message: 'Active user not found',
      httpStatus: 404,
    });
  }

  const mailbox = await findMailboxById(db, input.mailboxId);
  if (!mailbox) mailboxNotFound();
  if (mailbox.ownerUserId === target.userId) {
    throw new DomainError({
      code: 'MAILBOX_OWNER_CANNOT_BE_MEMBER',
      message: 'Mailbox owner cannot be added as an explicit member',
      httpStatus: 409,
    });
  }

  const existing = await findMailboxMember(db, input.mailboxId, target.userId);
  if (existing) {
    const replay = await replayIfPresent(
      db,
      input.actorUserId,
      mailboxMemberOperation('POST', input.mailboxId),
      input.idempotencyKey,
      input.requestHash,
    );
    if (replay) return replay;
    throw new DomainError({
      code: 'MAILBOX_MEMBER_DUPLICATE',
      message: 'User is already a member of this mailbox',
      httpStatus: 409,
    });
  }

  const now = sqliteTimestamp(clock.now());
  const item = memberItem(target, input.request.role, now);
  const responseJson = JSON.stringify({ data: item });
  const auditStatement = auditEventWriter.prepare({
    id: ids.uuid(),
    actorUserId: input.actorUserId,
    action: 'mailbox.member_added',
    resourceType: 'mailbox',
    resourceId: input.mailboxId,
    requestId: input.requestId,
    metadata: JSON.stringify({ memberUserId: target.userId, role: input.request.role }),
    createdAt: now,
  }).statement as unknown as D1PreparedStatement;

  await db.batch([
    prepareCreateMailboxMember(db, {
      mailboxId: input.mailboxId,
      userId: target.userId,
      role: input.request.role,
      createdAt: now,
    }),
    auditStatement,
    prepareCreateIdempotencyRecord(db, {
      id: ids.uuid(),
      actorId: input.actorUserId,
      operation: mailboxMemberOperation('POST', input.mailboxId),
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      responseStatus: 201,
      responseJson,
      createdAt: now,
    }),
  ]);

  return { status: 201, responseJson, replayed: false };
}

/** Lists only active users through Identity's credential-free summary seam. */
export async function listMailboxMembers(
  dependencies: MailboxMemberServiceDependencies,
  input: ListMailboxMembersInput,
): Promise<MailboxMemberItem[]> {
  const { db } = dependencies;
  await assertCanManageMailboxMembers(db, input.actorUserId, input.mailboxId, input.hasGlobalShare);
  const rows = await listMailboxMemberRows(db, input.mailboxId);
  const summaries = await findActiveUsersByIds(
    db,
    rows.map((row) => row.userId),
  );
  const summariesById = new Map(summaries.map((summary) => [summary.userId, summary]));
  const items: MailboxMemberItem[] = [];
  for (const row of rows) {
    const summary = summariesById.get(row.userId);
    if (summary) items.push(memberItem(summary, row.role, row.createdAt));
  }
  return items;
}

/** Removes one explicit member and atomically records the successful transition. */
export async function removeMailboxMember(
  dependencies: MailboxMemberServiceDependencies,
  input: RemoveMailboxMemberInput,
): Promise<MailboxMemberServiceResult> {
  const { db, auditEventWriter } = dependencies;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;

  const mailbox = await assertCanManageMailboxMembers(
    db,
    input.actorUserId,
    input.mailboxId,
    input.hasGlobalShare,
  );
  if (mailbox.ownerUserId === input.memberUserId) {
    const replay = await replayIfPresent(
      db,
      input.actorUserId,
      mailboxMemberOperation('DELETE', input.mailboxId, input.memberUserId),
      input.idempotencyKey,
      input.requestHash,
    );
    if (replay) return replay;
    throw new DomainError({
      code: 'MAILBOX_MEMBER_NOT_FOUND',
      message: 'Mailbox member not found',
      httpStatus: 404,
    });
  }

  const member = await findMailboxMember(db, input.mailboxId, input.memberUserId);
  if (!member) {
    const replay = await replayIfPresent(
      db,
      input.actorUserId,
      mailboxMemberOperation('DELETE', input.mailboxId, input.memberUserId),
      input.idempotencyKey,
      input.requestHash,
    );
    if (replay) return replay;
    throw new DomainError({
      code: 'MAILBOX_MEMBER_NOT_FOUND',
      message: 'Mailbox member not found',
      httpStatus: 404,
    });
  }

  const now = sqliteTimestamp(clock.now());
  const responseJson = JSON.stringify({
    data: { removed: true, userId: input.memberUserId },
  });
  const auditStatement = auditEventWriter.prepare({
    id: ids.uuid(),
    actorUserId: input.actorUserId,
    action: 'mailbox.member_removed',
    resourceType: 'mailbox',
    resourceId: input.mailboxId,
    requestId: input.requestId,
    metadata: JSON.stringify({ memberUserId: input.memberUserId, role: member.role }),
    createdAt: now,
  }).statement as unknown as D1PreparedStatement;

  try {
    await db.batch([
      prepareDeleteMailboxMember(db, input.mailboxId, input.memberUserId),
      prepareRequireMailboxMemberDeleted(db, input.mailboxId, input.memberUserId),
      auditStatement,
      prepareCreateIdempotencyRecord(db, {
        id: ids.uuid(),
        actorId: input.actorUserId,
        operation: mailboxMemberOperation('DELETE', input.mailboxId, input.memberUserId),
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        responseStatus: 200,
        responseJson,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    // A concurrent same-key request can lose on the DELETE before reaching
    // its idempotency INSERT. Replay the committed winner when present.
    if (error instanceof Error && error.message.includes('mailbox_members.role')) {
      const winner = await findIdempotencyRecord(
        db,
        input.actorUserId,
        mailboxMemberOperation('DELETE', input.mailboxId, input.memberUserId),
        input.idempotencyKey,
      );
      if (winner) {
        assertSameRequestHash(winner, input.requestHash);
        return {
          status: 200,
          responseJson: winner.responseJson,
          replayed: true,
        };
      }

      const remaining = await findMailboxMember(db, input.mailboxId, input.memberUserId);
      if (!remaining) {
        throw new DomainError({
          code: 'MAILBOX_MEMBER_NOT_FOUND',
          message: 'Mailbox member not found',
          httpStatus: 404,
        });
      }
    }
    throw error;
  }

  return { status: 200, responseJson, replayed: false };
}
