import { sendDraftSchema } from '@unimailbox/contracts';
import {
  prepareQueueDraftForSend,
  prepareDraftSentFolder,
  resolveAuthorizedMessageMailbox,
} from '../messages';
import { findActiveOutboundConnectionForMailbox } from './connection-resolver';
import { prepareCreateOutboundJobGuarded } from './job-repository';
import { DomainError } from '../../platform/errors';
import {
  findIdempotencyRecord,
  assertSameRequestHash,
  sha256Hex,
  sqliteTimestamp,
  isIdempotencyUniqueViolation,
  IDEMPOTENCY_TTL_HOURS,
} from '../../platform/idempotency';
import { parseJsonBody } from '../../platform/parse-json-body';
import type { OutboundJobEnqueuer } from './reclaim-stale-jobs';
import {
  operationResult,
  prepareOperationAudit,
  replayOperation,
  replayOperationAfterRace,
  type OperationResult,
  type MutationDependencies,
  type MutationInput,
} from '../../platform/operation';

const SEND_DRAFT_OPERATION = 'POST /api/v1/drafts/:draftId/send';
function replayDraftSend(record: Parameters<typeof replayOperation>[0]): OperationResult {
  return setDraftSendLocation(replayOperation(record));
}
function setDraftSendLocation(result: OperationResult): OperationResult {
  try {
    const parsed = JSON.parse(result.responseJson) as { data?: { messageId?: unknown } };
    if (typeof parsed.data?.messageId === 'string')
      return {
        ...result,
        headers: { ...result.headers, Location: '/api/v1/messages/' + parsed.data.messageId },
      };
  } catch {
    /* Preserve a corrupt legacy response byte-for-byte. */
  }
  return result;
}

export async function sendDraft(
  deps: MutationDependencies & { outbound: OutboundJobEnqueuer },
  input: MutationInput & { draftId: string },
): Promise<OperationResult> {
  const userId = input.actorUserId;
  if (!userId) {
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  }

  const draftId = input.draftId;
  const idempotencyKey = input.idempotencyKey;
  if (!idempotencyKey) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header required',
      httpStatus: 400,
    });
  }

  // R-AUTHZ-004: a cached send response also requires current mailbox access.
  // Do not require draft status here: a successful first call has already queued it.
  const authorizedMailboxId = await resolveAuthorizedMessageMailbox(deps.db, {
    actorUserId: userId,
    messageId: draftId,
    operation: 'send',
    draftOnly: false,
  });
  const rawBody = input.rawBody;
  const rawBodyHash = await sha256Hex(rawBody);

  const requestHash = await sha256Hex(`draft-send:${draftId}:${rawBodyHash}`);
  const existing = await findIdempotencyRecord(
    deps.db,
    userId,
    SEND_DRAFT_OPERATION,
    idempotencyKey,
  );
  if (existing) {
    assertSameRequestHash(existing, requestHash);
    return replayDraftSend(existing);
  }

  if (rawBody !== '') {
    parseJsonBody(rawBody, sendDraftSchema, {
      event: 'drafts.send.invalid_json',
      actorUserId: userId,
    });
  }

  await resolveAuthorizedMessageMailbox(deps.db, {
    actorUserId: userId,
    messageId: draftId,
    operation: 'send',
    draftOnly: true,
  });

  const connection = await findActiveOutboundConnectionForMailbox(deps.db, authorizedMailboxId);
  if (!connection) {
    throw new DomainError({
      code: 'PROVIDER_CONNECTION_NOT_FOUND',
      message: 'No active provider connection',
      httpStatus: 409,
    });
  }

  const now = sqliteTimestamp(deps.clock.now());
  const jobId = deps.ids.uuid();
  const idempotencyRecordId = deps.ids.uuid();
  const auditEventId = deps.ids.uuid();
  const requestId = input.requestId ?? null;
  const successBody = JSON.stringify({
    data: { messageId: draftId, status: 'queued' },
  });

  // Only the batch whose draft transition succeeds may insert its marker.
  // Folder, job and audit statements check that marker in the same transaction.
  const statements: D1PreparedStatement[] = [
    prepareQueueDraftForSend(deps.db, { messageId: draftId, now }),
    deps.db
      .prepare(
        `INSERT INTO idempotency_records
             (id, actor_id, operation, idempotency_key, request_hash,
              response_status, response_json, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, 202, ?, ?, datetime(?, '+${IDEMPOTENCY_TTL_HOURS} hours')
            WHERE changes() > 0
              AND EXISTS (
                SELECT 1 FROM messages
                 WHERE id = ? AND status = 'queued' AND updated_at = ?
              )`,
      )
      .bind(
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
    prepareDraftSentFolder(deps.db, draftId, idempotencyRecordId),
    prepareCreateOutboundJobGuarded(deps.db, {
      id: jobId,
      messageId: draftId,
      providerConnectionId: connection.id,
      createdAt: now,
      updatedAt: now,
      idempotencyMarkerId: idempotencyRecordId,
    }),
    prepareOperationAudit(
      deps.auditEventWriter,
      {
        id: auditEventId,
        actorUserId: userId,
        action: 'draft.sent',
        resourceType: 'message',
        resourceId: draftId,
        requestId,
        createdAt: now,
      },
      { idempotencyMarkerId: idempotencyRecordId },
    ),
  ];

  let results: D1Result[];
  try {
    results = await deps.db.batch(statements);
  } catch (error) {
    if (isIdempotencyUniqueViolation(error)) {
      const replay = await replayOperationAfterRace(
        deps.db,
        userId,
        SEND_DRAFT_OPERATION,
        idempotencyKey,
        requestHash,
      );
      return setDraftSendLocation(replay);
    }
    throw error;
  }

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const winner = await findIdempotencyRecord(
      deps.db,
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

  await deps.outbound.send(JSON.stringify({ jobId }));
  return operationResult(successBody, {
    status: 202,
    headers: {
      'Content-Type': 'application/json',
      Location: `/api/v1/messages/${draftId}`,
    },
  });
}
