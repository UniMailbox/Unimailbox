// messages-owned persistence for attachment_uploads (CAP-049).

import type { Database } from '../../platform/database';

export interface CreateAttachmentUploadInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly mailboxId: string;
  readonly kvKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly disposition: 'attachment' | 'inline';
  readonly sizeBytes: number;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface AttachmentUploadCommitStateInput {
  readonly uploadId: string;
}

export interface AttachmentUploadCommitState {
  readonly uploadExists: boolean;
}

export function prepareCreateAttachmentUpload(
  db: Database,
  input: CreateAttachmentUploadInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO attachment_uploads (
         id, owner_user_id, mailbox_id, kv_key, filename, content_type,
         disposition, size_bytes, status, expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, NULL, ?)`,
    )
    .bind(
      input.id,
      input.ownerUserId,
      input.mailboxId,
      input.kvKey,
      input.filename,
      input.contentType,
      input.disposition,
      input.sizeBytes,
      input.expiresAt,
      input.createdAt,
    );
}

/**
 * Post-error safety check for the Messages-owned attachment row. Identity's
 * idempotency state is deliberately not read here; callers compose this
 * result with the public platform/idempotency lookup seam.
 * Query failure is surfaced so the caller preserves KV for TTL cleanup.
 */
export async function findAttachmentUploadCommitState(
  db: Database,
  input: AttachmentUploadCommitStateInput,
): Promise<AttachmentUploadCommitState> {
  const row = await db
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM attachment_uploads WHERE id = ?) AS upload_exists`,
    )
    .bind(input.uploadId)
    .first<{ upload_exists: number }>();

  if (!row) {
    throw new Error('Attachment upload commit state query returned no row');
  }
  return {
    uploadExists: row.upload_exists === 1,
  };
}
