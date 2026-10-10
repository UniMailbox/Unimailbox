// CAP-051 consumed-attachment download use case.
//
// The route supplies the target mailbox and authenticated principal after
// global permission middleware. This use case repeats mailbox authorization
// at its boundary, reads the Messages-owned projection, and fetches bytes
// through the narrow R2/KV byte-store seams.

import { assertCan } from '../tenancy';
import { findMessageAttachmentForDownload, findInboundAttachmentForDownload } from '../messages';
import type { Database } from '../../platform/database';
import type { AttachmentByteStore, AttachmentObjectStore } from '../../platform/cache';
import { DomainError } from '../../platform/errors';

export interface DownloadAttachmentInput {
  readonly actorUserId: string;
  readonly mailboxId: string;
  readonly attachmentId: string;
}

export interface DownloadAttachmentDependencies {
  readonly db: Database;
  readonly cache: AttachmentByteStore;
  readonly objectStore?: AttachmentObjectStore;
}

export interface DownloadAttachmentResult {
  readonly bytes: ArrayBuffer;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly disposition: 'attachment' | 'inline';
}

/**
 * Stable safe failure for every inaccessible, missing, or incomplete
 * attachment state. The existing MESSAGE_NOT_FOUND code is used because the
 * public error catalog is closed and this endpoint must not introduce a
 * second resource-existence vocabulary just for the attachment store.
 */
function attachmentNotFound(): never {
  throw new DomainError({
    code: 'MESSAGE_NOT_FOUND',
    message: 'Attachment not found',
    httpStatus: 404,
  });
}

export async function downloadAttachment(
  dependencies: DownloadAttachmentDependencies,
  input: DownloadAttachmentInput,
): Promise<DownloadAttachmentResult> {
  await assertCan(dependencies.db, input.actorUserId, input.mailboxId, 'read');

  const lookup = {
    mailboxId: input.mailboxId,
    attachmentId: input.attachmentId,
    userId: input.actorUserId,
  };
  const metadata =
    (await findMessageAttachmentForDownload(dependencies.db, lookup)) ??
    (await findInboundAttachmentForDownload(dependencies.db, lookup));
  if (!metadata) attachmentNotFound();

  // R2 is the persistent byte source; KV covers older/staged objects. A
  // missing or size-mismatched object is
  // observationally identical to missing D1 metadata and must not leak the
  // canonical filename/content type or a partial body.
  const bytes =
    (await dependencies.objectStore?.get(metadata.objectKey)) ??
    (await dependencies.cache.get(metadata.objectKey));
  if (bytes === null || bytes.byteLength !== metadata.sizeBytes) attachmentNotFound();

  return {
    bytes,
    filename: metadata.filename,
    contentType: metadata.contentType,
    sizeBytes: metadata.sizeBytes,
    disposition: metadata.disposition,
  };
}
