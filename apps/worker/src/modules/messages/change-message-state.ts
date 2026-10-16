import { assertCan } from '../tenancy';
import {
  markMessageAsRead,
  getMessageStarState,
  prepareSetMessageStar,
  prepareSoftDeleteMessageForUser,
} from './message-read-repository';
import { DomainError } from '../../platform/errors';
import {
  findIdempotencyRecord,
  prepareCreateIdempotencyRecord,
  assertSameRequestHash,
  writeIdempotencyRecord,
  sha256Hex,
  sqliteTimestamp,
  isIdempotencyUniqueViolation,
} from '../../platform/idempotency';
import {
  operationResult,
  replayOperation,
  replayOperationAfterRace,
  type OperationResult,
  type MutationDependencies,
  type MutationInput,
  prepareOperationAudit,
} from '../../platform/operation';

const MARK_READ_OPERATION = 'PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read';
const TOGGLE_STAR_OPERATION = 'PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/star';
const DELETE_MESSAGE_OPERATION = 'DELETE /api/v1/mailboxes/:mailboxId/messages/:messageId';
interface IdempotencyRequestContext {
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

async function beginIdempotentOperation(
  deps: MutationDependencies,
  input: MutationInput,
  userId: string,
  operation: string,
  resource?: { readonly mailboxId: string; readonly messageId: string },
): Promise<{ context: IdempotencyRequestContext; replay: OperationResult | null }> {
  const rawBody = input.rawBody;

  const requestHash = await sha256Hex(
    resource === undefined ? rawBody : JSON.stringify({ body: rawBody, resource }),
  );

  const idempotencyKey = input.idempotencyKey;
  if (!idempotencyKey) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header required',
      httpStatus: 400,
    });
  }

  const existing = await findIdempotencyRecord(deps.db, userId, operation, idempotencyKey);
  if (existing) {
    assertSameRequestHash(existing, requestHash);

    return { context: { idempotencyKey, requestHash }, replay: replayOperation(existing) };
  }

  return { context: { idempotencyKey, requestHash }, replay: null };
}

function prepareMessageAudit(
  deps: MutationDependencies,
  input: MutationInput,
  userId: string,
  action: 'message.star_toggled' | 'message.soft_deleted',
  messageId: string,
  metadata: Record<string, unknown>,
  createdAt: string,
) {
  return prepareOperationAudit(deps.auditEventWriter, {
    id: deps.ids.uuid(),
    actorUserId: userId,
    action,
    resourceType: 'message',
    resourceId: messageId,
    requestId: input.requestId ?? null,
    metadata: JSON.stringify(metadata),

    createdAt,
  });
}

export async function markRead(
  deps: MutationDependencies,
  input: MutationInput & { mailboxId: string; messageId: string },
): Promise<OperationResult> {
  const mailboxId = input.mailboxId;
  const messageId = input.messageId;
  const userId = input.actorUserId;
  if (!userId)
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  await assertCan(deps.db, userId, mailboxId, 'read');

  const { context, replay } = await beginIdempotentOperation(
    deps,
    input,
    userId,
    MARK_READ_OPERATION,
  );
  if (replay !== null) {
    return replay;
  }

  const marked = await markMessageAsRead(deps.db, mailboxId, messageId, userId);
  if (!marked) {
    throw new DomainError({
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      httpStatus: 404,
    });
  }

  const successBody = JSON.stringify({ data: { ok: true } });

  // D-CAP-043-I: read is rerunnable; preserve the existing best-effort record.
  await writeIdempotencyRecord(deps.db, {
    id: deps.ids.uuid(),
    actorId: userId,
    operation: MARK_READ_OPERATION,
    idempotencyKey: context.idempotencyKey,
    requestHash: context.requestHash,
    responseStatus: 200,
    responseJson: successBody,
    createdAt: sqliteTimestamp(deps.clock.now()),
  });

  return operationResult(successBody, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function toggleStar(
  deps: MutationDependencies,
  input: MutationInput & { mailboxId: string; messageId: string },
): Promise<OperationResult> {
  const mailboxId = input.mailboxId;
  const messageId = input.messageId;
  const userId = input.actorUserId;
  if (!userId)
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  await assertCan(deps.db, userId, mailboxId, 'read');

  const { context, replay } = await beginIdempotentOperation(
    deps,
    input,
    userId,
    TOGGLE_STAR_OPERATION,
    {
      mailboxId,
      messageId,
    },
  );
  if (replay !== null) {
    return replay;
  }

  const currentStarred = await getMessageStarState(deps.db, mailboxId, messageId, userId);
  if (currentStarred === null) {
    throw new DomainError({
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      httpStatus: 404,
    });
  }

  const target: 0 | 1 = currentStarred ? 0 : 1;
  const successBody = JSON.stringify({ data: { id: messageId, isStarred: target } });
  const now = sqliteTimestamp(deps.clock.now());

  try {
    // A duplicate key rolls back state, replay record and audit together.
    await deps.db.batch([
      prepareSetMessageStar(deps.db, mailboxId, messageId, userId, target, now),
      prepareCreateIdempotencyRecord(deps.db, {
        id: deps.ids.uuid(),
        actorId: userId,
        operation: TOGGLE_STAR_OPERATION,
        idempotencyKey: context.idempotencyKey,
        requestHash: context.requestHash,
        responseStatus: 200,
        responseJson: successBody,
        createdAt: now,
      }),
      prepareMessageAudit(
        deps,
        input,
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

    return replayOperationAfterRace(
      deps.db,
      userId,
      TOGGLE_STAR_OPERATION,
      context.idempotencyKey,
      context.requestHash,
    );
  }

  return operationResult(successBody, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

export async function softDeleteMessage(
  deps: MutationDependencies,
  input: MutationInput & { mailboxId: string; messageId: string },
): Promise<OperationResult> {
  const mailboxId = input.mailboxId;
  const messageId = input.messageId;
  const userId = input.actorUserId;
  if (!userId)
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  await assertCan(deps.db, userId, mailboxId, 'read');

  const { context, replay } = await beginIdempotentOperation(
    deps,
    input,
    userId,
    DELETE_MESSAGE_OPERATION,
  );
  if (replay !== null) {
    return replay;
  }

  const softDelete = await prepareSoftDeleteMessageForUser(deps.db, mailboxId, messageId, userId);
  if (softDelete === null) {
    throw new DomainError({
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      httpStatus: 404,
    });
  }

  const now = sqliteTimestamp(deps.clock.now());

  try {
    // A duplicate key rolls back state, replay record and audit together.
    await deps.db.batch([
      softDelete,
      prepareCreateIdempotencyRecord(deps.db, {
        id: deps.ids.uuid(),
        actorId: userId,
        operation: DELETE_MESSAGE_OPERATION,
        idempotencyKey: context.idempotencyKey,
        requestHash: context.requestHash,
        responseStatus: 204,
        responseJson: '',
        createdAt: now,
      }),
      prepareMessageAudit(
        deps,
        input,
        userId,
        'message.soft_deleted',
        messageId,
        { mailboxId },
        now,
      ),
    ]);
  } catch (error) {
    if (!isIdempotencyUniqueViolation(error)) {
      throw error;
    }

    return replayOperationAfterRace(
      deps.db,
      userId,
      DELETE_MESSAGE_OPERATION,
      context.idempotencyKey,
      context.requestHash,
    );
  }

  return operationResult(null, { status: 204 });
}
