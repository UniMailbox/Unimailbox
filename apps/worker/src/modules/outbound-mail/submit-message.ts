import {
  operationResult,
  replayOperation,
  replayOperationAfterRace,
  type OperationResult,
  type MutationDependencies,
  type MutationInput,
  prepareOperationAudit,
} from '../../platform/operation';
import type { AttachmentByteStore, AttachmentObjectStore } from '../../platform/cache';
import type { OutboundJobEnqueuer } from './reclaim-stale-jobs';
import {
  prepareEditorAssetUsages,
  resolveEditorAssets,
  prepareHostedLegacyAttachments,
  appendAttachmentList,
  assetPath,
} from '../editor-assets';
import { findEnabledSignature, sanitizeSignatureHtml } from '../signatures';
import {
  composeRequestSchema,
  EDITOR_BODY_MAX_BYTES,
  estimateEmailBytes,
  OUTBOUND_SAFE_MAX_BYTES,
  OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES,
} from '@unimailbox/contracts';
import { assertCan, findMailboxById } from '../tenancy';
import { findActiveOutboundConnectionForMailbox } from './connection-resolver';
import { prepareCreateOutboundJob } from './job-repository';
import { validateScheduledAt, scheduleRecoveryAt } from './schedule-time';
import { enqueueScheduledJob } from './enqueue-scheduled-job';
import {
  createMessageWithRelations,
  prepareAuthoredMessage,
  prepareCreateRecipient,
  prepareAuthoredMailboxMessage,
  listAttachmentUploadsForConsume,
  prepareConsumeAttachmentUpload,
  prepareCreateMessageAttachment,
  type AttachmentUploadForConsumeRow,
} from '../messages';
import { DomainError } from '../../platform/errors';
import {
  findIdempotencyRecord,
  prepareCreateIdempotencyRecord,
  assertSameRequestHash,
  sha256Hex,
  sqliteTimestamp,
  isIdempotencyUniqueViolation,
} from '../../platform/idempotency';
import { parseJsonBody } from '../../platform/parse-json-body';

const SEND_OPERATION = 'POST /api/v1/mailboxes/:mailboxId/messages/send';

function throwAttachmentUnavailable(): never {
  throw new DomainError({
    code: 'ATTACHMENT_UPLOAD_NOT_FOUND',
    message: 'One or more attachment uploads are unavailable',
    httpStatus: 400,
  });
}

function isMessageAttachmentsUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes('UNIQUE constraint failed') &&
    error.message.includes('message_attachments')
  );
}

function isAttachmentUploadNotConsumableTrigger(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes('ATTACHMENT_UPLOAD_NOT_CONSUMABLE');
}

export async function submitMessage(
  deps: MutationDependencies & {
    outbound: OutboundJobEnqueuer;
    attachmentByteStore: AttachmentByteStore;
    attachmentObjectStore: AttachmentObjectStore;
  },
  input: MutationInput & { mailboxId: string; origin: string },
): Promise<OperationResult> {
  const userId = input.actorUserId;
  if (!userId) {
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  }

  const mailboxId = input.mailboxId;

  await assertCan(deps.db, userId, mailboxId, 'send');

  const rawBody = input.rawBody;
  const requestHash = await sha256Hex(rawBody);

  const idempotencyKey = input.idempotencyKey;
  if (!idempotencyKey) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header required',
      httpStatus: 400,
    });
  }

  const existing = await findIdempotencyRecord(deps.db, userId, SEND_OPERATION, idempotencyKey);
  if (existing) {
    assertSameRequestHash(existing, requestHash);
    return replayOperation(existing);
  }

  const body = parseJsonBody(rawBody, composeRequestSchema, {
    event: 'messages.send.invalid_json',
    actorUserId: userId,
  });

  const scheduledAt = body.scheduledAt
    ? validateScheduledAt(body.scheduledAt, deps.clock.now())
    : null;

  const mailbox = await findMailboxById(deps.db, mailboxId);
  if (!mailbox) {
    throw new DomainError({
      code: 'MAILBOX_NOT_FOUND',
      message: 'Mailbox not found',
      httpStatus: 404,
    });
  }

  const connection = await findActiveOutboundConnectionForMailbox(deps.db, mailboxId);
  if (!connection) {
    throw new DomainError({
      code: 'PROVIDER_CONNECTION_NOT_FOUND',
      message: 'No active provider connection',
      httpStatus: 409,
    });
  }

  const attachmentUploadIds = body.attachmentUploadIds ?? [];
  let attachmentRows: ReadonlyArray<AttachmentUploadForConsumeRow> = [];
  if (attachmentUploadIds.length > 0) {
    const preflight = await listAttachmentUploadsForConsume(deps.db, {
      uploadIds: attachmentUploadIds,
      expectedOwnerUserId: userId,
      expectedMailboxId: mailboxId,
      now: sqliteTimestamp(deps.clock.now()),
    });
    if (preflight.kind === 'missing') {
      throwAttachmentUnavailable();
    }
    attachmentRows = preflight.rows;

    const attachmentByteStore = deps.attachmentByteStore;
    const attachmentObjectStore = deps.attachmentObjectStore;
    for (const row of attachmentRows) {
      const bytes = await attachmentByteStore.get(row.kvKey);
      if (!bytes || bytes.byteLength !== row.sizeBytes) {
        throwAttachmentUnavailable();
      }

      await attachmentObjectStore.put(row.kvKey, bytes);
    }
  }

  const signature = await findEnabledSignature(deps.db, mailbox.domainId);
  const authoredHtml = sanitizeSignatureHtml(body.htmlBody);
  const escapeText = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  let htmlBody = signature
    ? `${authoredHtml || (body.textBody ? `<p>${escapeText(body.textBody)}</p>` : '')}<div><br>${signature.htmlContent || escapeText(signature.textContent)}</div>`
    : authoredHtml;
  let textBody = signature ? `${body.textBody}\n\n${signature.textContent}` : body.textBody;
  const authoredAssets = await resolveEditorAssets(deps.db, {
    html: authoredHtml,
    text: body.textBody,
    actorUserId: userId,
    scope: { mailboxId },
  });
  const signatureAssets = signature
    ? await resolveEditorAssets(deps.db, {
        html: signature.htmlContent,
        text: signature.textContent,
        actorUserId: userId,
        scope: { domainId: mailbox.domainId },
      })
    : [];
  const fileAssets = [
    ...new Map(
      [...authoredAssets, ...signatureAssets]
        .filter((asset) => asset.kind === 'file')
        .map((asset) => [asset.id, asset]),
    ).values(),
  ];
  const fileDescriptors = fileAssets.map((asset) => ({
    id: asset.id,
    filename: asset.filename,
    sizeBytes: asset.size_bytes,
    url: new URL(assetPath(asset.id, asset.secret), input.origin).href,
  }));

  const regularBody = appendAttachmentList(htmlBody, textBody, fileDescriptors, false);
  const largeAttachments =
    estimateEmailBytes(regularBody.html, regularBody.text, body.subject, [
      ...attachmentRows.map((row) => row.sizeBytes),
      ...fileAssets.map((asset) => asset.size_bytes),
    ]) > OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES;
  const now = sqliteTimestamp(deps.clock.now());
  const messageId = deps.ids.uuid();
  const hosted =
    largeAttachments && attachmentRows.length
      ? await prepareHostedLegacyAttachments(deps.db, {
          actorUserId: userId,
          mailboxId,
          messageId,
          origin: input.origin,
          now,
          files: attachmentRows,
        })
      : { files: [], statements: [] };
  const listed = appendAttachmentList(
    htmlBody,
    textBody,
    [...fileDescriptors, ...hosted.files],
    largeAttachments,
  );
  htmlBody = listed.html;
  textBody = listed.text;
  if (
    new TextEncoder().encode(htmlBody).byteLength > EDITOR_BODY_MAX_BYTES ||
    estimateEmailBytes(
      htmlBody,
      textBody,
      body.subject,
      largeAttachments ? [] : attachmentRows.map((row) => row.sizeBytes),
    ) > OUTBOUND_SAFE_MAX_BYTES
  ) {
    throw new DomainError({
      code: 'BODY_TOO_LARGE',
      message: 'Email is too large. Upload files as download links instead.',
      httpStatus: 413,
    });
  }
  const jobId = deps.ids.uuid();
  const idempotencyRecordId = deps.ids.uuid();
  const idempotencyNow = sqliteTimestamp(deps.clock.now());
  const auditEventId = deps.ids.uuid();
  const attachmentAuditEventIds = attachmentRows.map(() => deps.ids.uuid());
  const messageAttachmentIds = attachmentRows.map(() => deps.ids.uuid());

  const requestId = input.requestId ?? null;

  const successBody = JSON.stringify({
    data: {
      messageId,
      status: 'queued',
      ...(scheduledAt ? { scheduledAt: scheduledAt.replace(' ', 'T') + '.000Z' } : {}),
    },
  });

  const assetUsages = await prepareEditorAssetUsages(deps.db, {
    html: authoredHtml,
    text: body.textBody,
    actorUserId: userId,
    scope: { mailboxId },
    resourceType: 'message',
    resourceId: messageId,
  });
  const statements: D1PreparedStatement[] = [
    ...assetUsages,
    ...hosted.statements,

    prepareAuthoredMessage(deps.db, {
      id: messageId,
      fromAddress: mailbox.address,
      subject: body.subject,
      htmlBody,
      textBody,
      inReplyTo: body.inReplyTo ?? null,
      references: body.references ?? '',
      status: 'queued',
      actorUserId: userId,
      now,
    }),
    ...body.to.map((r) =>
      prepareCreateRecipient(deps.db, {
        id: deps.ids.uuid(),
        messageId,
        address: r.address,
        displayName: r.displayName ?? '',
        type: 'to',
        createdAt: now,
      }),
    ),
    ...body.cc.map((r) =>
      prepareCreateRecipient(deps.db, {
        id: deps.ids.uuid(),
        messageId,
        address: r.address,
        displayName: r.displayName ?? '',
        type: 'cc',
        createdAt: now,
      }),
    ),
    ...body.bcc.map((r) =>
      prepareCreateRecipient(deps.db, {
        id: deps.ids.uuid(),
        messageId,
        address: r.address,
        displayName: r.displayName ?? '',
        type: 'bcc',
        createdAt: now,
      }),
    ),
    prepareAuthoredMailboxMessage(deps.db, {
      id: deps.ids.uuid(),
      mailboxId,
      messageId,
      folder: scheduledAt ? 'scheduled' : 'sent',
      now,
    }),
    ...attachmentRows.map((row, index) => {
      const attachId = messageAttachmentIds[index];
      if (!attachId) {
        throw new Error('messageAttachmentIds index out of range');
      }
      return prepareCreateMessageAttachment(deps.db, {
        id: attachId,
        messageId,
        uploadId: row.uploadId,
        objectKey: row.kvKey,
        filename: row.filename,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        disposition: row.disposition,
        contentId: null,
        sha256: null,
        createdAt: now,
      });
    }),

    ...attachmentRows.map((row) =>
      prepareConsumeAttachmentUpload(deps.db, {
        uploadId: row.uploadId,
        consumedAt: now,
      }),
    ),

    prepareCreateOutboundJob(deps.db, {
      id: jobId,
      messageId,
      providerConnectionId: connection.id,
      createdAt: now,
      updatedAt: scheduleRecoveryAt(scheduledAt, deps.clock.now()),
      ...(scheduledAt ? { scheduledAt, mailboxId } : {}),
    }),

    prepareOperationAudit(deps.auditEventWriter, {
      id: auditEventId,
      actorUserId: userId,
      action: scheduledAt ? 'message.scheduled' : 'message.send',
      resourceType: 'message',
      resourceId: messageId,
      requestId,
      createdAt: now,
    }),

    ...attachmentRows.map((row, index) => {
      const auditId = attachmentAuditEventIds[index];
      if (!auditId) {
        throw new Error('attachmentAuditEventIds index out of range');
      }
      return prepareOperationAudit(deps.auditEventWriter, {
        id: auditId,
        actorUserId: userId,
        action: 'attachment.consumed',
        resourceType: 'attachment_upload',
        resourceId: row.uploadId,
        requestId,
        createdAt: now,
      });
    }),

    prepareCreateIdempotencyRecord(deps.db, {
      id: idempotencyRecordId,
      actorId: userId,
      operation: SEND_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 202,
      responseJson: successBody,
      createdAt: idempotencyNow,
    }),
  ];

  try {
    await createMessageWithRelations(deps.db, statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes('EDITOR_ASSET_PENDING_LIMIT')) {
      throw new DomainError({
        code: 'VALIDATION_ERROR',
        message: 'Pending upload limit reached; send or save existing uploads first',
        httpStatus: 400,
      });
    }

    const isConsumeRace =
      isMessageAttachmentsUniqueViolation(error) || isAttachmentUploadNotConsumableTrigger(error);
    const isIdempotencyRace = isIdempotencyUniqueViolation(error);
    if (isConsumeRace || isIdempotencyRace) {
      try {
        return replayOperationAfterRace(
          deps.db,
          userId,
          SEND_OPERATION,
          idempotencyKey,
          requestHash,
        );
      } catch (raceReplayError) {
        if (isConsumeRace) {
          throwAttachmentUnavailable();
        }
        throw raceReplayError;
      }
    }
    throw error;
  }

  await enqueueScheduledJob(deps.db, deps.outbound, jobId, scheduledAt, deps.clock.now());

  return operationResult(successBody, {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
}
