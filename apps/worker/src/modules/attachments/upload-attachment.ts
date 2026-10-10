// CAP-049 attachment staging use case.

import {
  ATTACHMENT_UPLOAD_MAX_BYTES,
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  attachmentUploadDescriptorSchema,
  type AttachmentUploadDescriptor,
  type AttachmentUploadMetadata,
} from '@unimailbox/contracts';
import type { AuditEventWriter } from '@unimailbox/contracts';
import { assertCan } from '../tenancy';
import { findAttachmentUploadCommitState, prepareCreateAttachmentUpload } from '../messages';
import type { Database } from '../../platform/database';
import type { Clock } from '../../platform/clock';
import { systemClock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import { systemIds } from '../../platform/ids';
import { DomainError } from '../../platform/errors';
import type { AttachmentByteStore } from '../../platform/cache';
import {
  assertSameRequestHash,
  findIdempotencyRecord,
  isIdempotencyUniqueViolation,
  prepareCreateIdempotencyRecord,
  sqliteTimestamp,
} from '../../platform/idempotency';

export interface UploadAttachmentInput {
  readonly actorUserId: string;
  readonly mailboxId: string;
  readonly idempotencyKey: string;
  readonly requestId: string | null;
  readonly metadata: AttachmentUploadMetadata;
  readonly bytes: ArrayBuffer;
}

export interface UploadAttachmentDependencies {
  readonly db: Database;
  readonly cache: AttachmentByteStore;
  readonly auditEventWriter: AuditEventWriter;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export interface UploadAttachmentResult {
  readonly status: 201;
  readonly responseJson: string;
  readonly descriptor: AttachmentUploadDescriptor;
  readonly replayed: boolean;
}

export function attachmentUploadOperation(mailboxId: string): string {
  return `POST /api/v1/mailboxes/${mailboxId}/attachments/uploads`;
}

async function hashUploadRequest(
  metadata: AttachmentUploadMetadata,
  bytes: ArrayBuffer,
): Promise<string> {
  const metadataBytes = new TextEncoder().encode(
    `${metadata.filename}\0${metadata.contentType}\0${metadata.disposition}\0`,
  );
  const framed = new Uint8Array(metadataBytes.byteLength + bytes.byteLength);
  framed.set(metadataBytes, 0);
  framed.set(new Uint8Array(bytes), metadataBytes.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', framed);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseStoredDescriptor(responseJson: string): AttachmentUploadDescriptor {
  const parsed: unknown = JSON.parse(responseJson);
  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
    throw new Error('Stored attachment idempotency response is invalid');
  }
  return attachmentUploadDescriptorSchema.parse((parsed as { data: unknown }).data);
}

async function deleteKvBestEffort(cache: AttachmentByteStore, kvKey: string): Promise<void> {
  try {
    await cache.delete(kvKey);
  } catch {
    // The D1 row did not land, so a later cleanup sweep may remove an orphan.
    // Do not log the request metadata or attachment bytes.
  }
}

export async function uploadAttachment(
  dependencies: UploadAttachmentDependencies,
  input: UploadAttachmentInput,
): Promise<UploadAttachmentResult> {
  const { db, cache } = dependencies;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;

  await assertCan(db, input.actorUserId, input.mailboxId, 'send');

  if (input.bytes.byteLength === 0) {
    throw new DomainError({
      code: 'VALIDATION_ERROR',
      message: 'Attachment body must not be empty',
      httpStatus: 400,
    });
  }
  if (input.bytes.byteLength > ATTACHMENT_UPLOAD_MAX_BYTES) {
    throw new DomainError({
      code: 'BODY_TOO_LARGE',
      message: `Request body exceeds ${ATTACHMENT_UPLOAD_MAX_BYTES} bytes`,
      httpStatus: 413,
    });
  }

  const operation = attachmentUploadOperation(input.mailboxId);
  const requestHash = await hashUploadRequest(input.metadata, input.bytes);
  const existing = await findIdempotencyRecord(
    db,
    input.actorUserId,
    operation,
    input.idempotencyKey,
  );
  if (existing) {
    assertSameRequestHash(existing, requestHash);
    return {
      status: 201,
      responseJson: existing.responseJson,
      descriptor: parseStoredDescriptor(existing.responseJson),
      replayed: true,
    };
  }

  const uploadId = ids.uuid();
  const kvKey = `attachment:${uploadId}`;
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000);
  const descriptor = attachmentUploadDescriptorSchema.parse({
    uploadId,
    mailboxId: input.mailboxId,
    filename: input.metadata.filename,
    contentType: input.metadata.contentType,
    disposition: input.metadata.disposition,
    sizeBytes: input.bytes.byteLength,
    status: 'uploaded',
    expiresAt: expiresAt.toISOString(),
  });
  const responseJson = JSON.stringify({ data: descriptor });
  const createdAt = sqliteTimestamp(now);
  const idempotencyRecordId = ids.uuid();
  const auditEventId = ids.uuid();

  const auditStatement = dependencies.auditEventWriter.prepare({
    id: auditEventId,
    actorUserId: input.actorUserId,
    action: 'attachment.uploaded',
    resourceType: 'attachment_upload',
    resourceId: uploadId,
    requestId: input.requestId,
    createdAt,
  }).statement as unknown as Parameters<Database['batch']>[0][number];

  await cache.put(kvKey, input.bytes, { expirationTtl: ATTACHMENT_UPLOAD_TTL_SECONDS });

  try {
    await db.batch([
      prepareCreateAttachmentUpload(db, {
        id: uploadId,
        ownerUserId: input.actorUserId,
        mailboxId: input.mailboxId,
        kvKey,
        filename: descriptor.filename,
        contentType: descriptor.contentType,
        disposition: descriptor.disposition,
        sizeBytes: descriptor.sizeBytes,
        expiresAt: sqliteTimestamp(expiresAt),
        createdAt,
      }),
      prepareCreateIdempotencyRecord(db, {
        id: idempotencyRecordId,
        actorId: input.actorUserId,
        operation,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        responseStatus: 201,
        responseJson,
        createdAt,
      }),
      auditStatement,
    ]);
  } catch (error) {
    // D1 may have committed while its acknowledgement failed. Confirm both
    // rows are absent before deleting bytes; if the query itself fails, keep
    // the KV value and let its TTL provide safe orphan cleanup.
    let commitState;
    try {
      commitState = await findAttachmentUploadCommitState(db, {
        uploadId,
      });
    } catch {
      throw error;
    }

    // Idempotency records belong to the identity/platform seam. A winner from
    // another concurrent request must not be mistaken for this request's
    // generated record; compare the stored descriptor's upload ID before
    // deciding whether this request's KV value may be deleted.
    let generatedIdempotencyRecordExists = false;
    const winner = await findIdempotencyRecord(
      db,
      input.actorUserId,
      operation,
      input.idempotencyKey,
    );
    if (winner) {
      try {
        generatedIdempotencyRecordExists =
          parseStoredDescriptor(winner.responseJson).uploadId === uploadId;
      } catch {
        // Preserve bytes if an observed idempotency row cannot be decoded;
        // cleanup must never delete potentially committed content.
        generatedIdempotencyRecordExists = true;
      }
    }

    if (!commitState.uploadExists && !generatedIdempotencyRecordExists) {
      await deleteKvBestEffort(cache, kvKey);
    }

    if (isIdempotencyUniqueViolation(error)) {
      if (winner) {
        assertSameRequestHash(winner, requestHash);
        return {
          status: 201,
          responseJson: winner.responseJson,
          descriptor: parseStoredDescriptor(winner.responseJson),
          replayed: true,
        };
      }
    }

    throw error;
  }

  return { status: 201, responseJson, descriptor, replayed: false };
}
