// CAP-051 consumed-attachment download use case.
//
// The route supplies the target mailbox and authenticated principal after
// global permission middleware. This use case repeats mailbox authorization
// at its boundary, reads the Messages-owned projection, and fetches bytes
// only through the narrow CACHE byte-store seam.

import { assertCan } from '../tenancy';
import { findMessageAttachmentForDownload } from '../messages';
import type { Database } from '../../platform/database';
import type { AttachmentByteStore } from '../../platform/cache';
import { DomainError } from '../../platform/errors';

export interface DownloadAttachmentInput {
  readonly actorUserId: string;
  readonly mailboxId: string;
  readonly attachmentId: string;
  readonly isAdmin: boolean;
}

export interface DownloadAttachmentDependencies {
  readonly db: Database;
  readonly cache: AttachmentByteStore;
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
 * second resource-existence vocabulary just for the local CACHE slice.
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
  await assertCan(dependencies.db, input.actorUserId, input.mailboxId, 'read', input.isAdmin);

  const metadata = await findMessageAttachmentForDownload(dependencies.db, {
    mailboxId: input.mailboxId,
    attachmentId: input.attachmentId,
    userId: input.actorUserId,
  });
  if (!metadata) attachmentNotFound();

  // CACHE is byte storage only. A missing or size-mismatched object is
  // observationally identical to missing D1 metadata and must not leak the
  // canonical filename/content type or a partial body.
  const bytes = await dependencies.cache.get(metadata.objectKey);
  if (bytes === null || bytes.byteLength !== metadata.sizeBytes) attachmentNotFound();

  return {
    bytes,
    filename: metadata.filename,
    contentType: metadata.contentType,
    sizeBytes: metadata.sizeBytes,
    disposition: metadata.disposition,
  };
}
