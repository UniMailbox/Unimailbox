// messages-owned persistence for the CAP-050 attachment-consume flow.
//
// Owned by the `messages` module per .claude/rules/architecture.md
// §Persistence ownership. The compose route preflights each
// `attachmentUploadId` through `listAttachmentUploadsForConsume` (which
// reads D1 — never trusting client-supplied metadata, R-DATA-005 /
// R-AUTHZ-004) and folds the resulting prepareCreateMessageAttachment /
// prepareConsumeAttachmentUpload statements into the same D1 batch as
// the message INSERT and outbound job. Two D1-enforced guards
// (`message_attachments_upload_unique` UNIQUE index +
// `message_attachments_upload_consumable` BEFORE INSERT trigger,
// migration 0022) make "one consume per upload" true under concurrent
// compose requests even when this code path itself does not run any
// pessimistic check.

import type { Database } from '../../platform/database';

export interface AttachmentUploadForConsumeRow {
  readonly uploadId: string;
  readonly ownerUserId: string;
  readonly mailboxId: string;
  readonly kvKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly disposition: 'attachment' | 'inline';
}

export interface ListAttachmentUploadsForConsumeInput {
  readonly uploadIds: ReadonlyArray<string>;
  readonly expectedOwnerUserId: string;
  readonly expectedMailboxId: string;
  readonly now: string;
}

/**
 * Result of the preflight SELECT. The compose route only proceeds when
 * the result is `available` — any other outcome collapses to the same
 * stable `ATTACHMENT_UPLOAD_NOT_FOUND` 400 envelope so we never
 * disclose ownership or lifecycle details to the caller.
 */
export type ListAttachmentUploadsForConsumeResult =
  | { readonly kind: 'available'; readonly rows: ReadonlyArray<AttachmentUploadForConsumeRow> }
  | { readonly kind: 'missing' };

/**
 * Preflight for the consume flow. Returns:
 *
 *   - `{ kind: 'available', rows }` when EVERY requested uploadId is
 *     present in D1, owned by `expectedOwnerUserId`, attached to
 *     `expectedMailboxId`, in `uploaded` status, and not expired. The
 *     returned rows are the authoritative metadata the queue consumer
 *     will later rebuild into the provider-neutral attachment payload.
 *   - `{ kind: 'missing' }` for any of: a requested ID absent in D1,
 *     owned by a different user, attached to a different mailbox,
 *     already consumed, expired, or otherwise not in the live
 *     `uploaded` state.
 *
 * The route MUST treat the `missing` outcome as fatal for the whole
 * request — no D1 writes, no queue enqueue. The DB-enforced guards in
 * migration 0022 cover the (uncommon) race where two concurrent
 * compose requests both pass this preflight but only one wins the
 * actual INSERT.
 */
export async function listAttachmentUploadsForConsume(
  db: Database,
  input: ListAttachmentUploadsForConsumeInput,
): Promise<ListAttachmentUploadsForConsumeResult> {
  const placeholders = input.uploadIds.map(() => '?').join(',');
  if (placeholders.length === 0) {
    return { kind: 'available', rows: [] };
  }

  const rows = await db
    .prepare(
      `SELECT id AS upload_id,
              owner_user_id AS owner_user_id,
              mailbox_id AS mailbox_id,
              kv_key AS kv_key,
              filename AS filename,
              content_type AS content_type,
              size_bytes AS size_bytes,
              disposition AS disposition
         FROM attachment_uploads
        WHERE id IN (${placeholders})
          AND owner_user_id = ?
          AND mailbox_id = ?
          AND status = 'uploaded'
          AND expires_at > ?`,
    )
    .bind(...input.uploadIds, input.expectedOwnerUserId, input.expectedMailboxId, input.now)
    .all<{
      upload_id: string;
      owner_user_id: string;
      mailbox_id: string;
      kv_key: string;
      filename: string;
      content_type: string;
      size_bytes: number;
      disposition: 'attachment' | 'inline';
    }>();

  if (rows.results.length !== input.uploadIds.length) {
    return { kind: 'missing' };
  }

  return {
    kind: 'available',
    rows: rows.results.map((row) => ({
      uploadId: row.upload_id,
      ownerUserId: row.owner_user_id,
      mailboxId: row.mailbox_id,
      kvKey: row.kv_key,
      filename: row.filename,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      disposition: row.disposition,
    })),
  };
}

export interface CreateMessageAttachmentInput {
  readonly id: string;
  readonly messageId: string;
  readonly uploadId: string;
  readonly objectKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly disposition: 'attachment' | 'inline';
  readonly contentId: string | null;
  readonly sha256: string | null;
  readonly createdAt: string;
}

/**
 * One `message_attachments` row INSERT. The compose batch orders these
 * BEFORE the corresponding `prepareConsumeAttachmentUpload` UPDATE so
 * the `message_attachments_upload_consumable` trigger observes the
 * pre-transition `status='uploaded'` row (migration 0022).
 */
export function prepareCreateMessageAttachment(
  db: Database,
  input: CreateMessageAttachmentInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO message_attachments (
         id, message_id, upload_id, object_key, filename, content_type,
         size_bytes, disposition, content_id, sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.messageId,
      input.uploadId,
      input.objectKey,
      input.filename,
      input.contentType,
      input.sizeBytes,
      input.disposition,
      input.contentId,
      input.sha256,
      input.createdAt,
    );
}

export interface ConsumeAttachmentUploadInput {
  readonly uploadId: string;
  readonly consumedAt: string;
}

/**
 * Transition one upload from `uploaded` to `consumed`. The migration
 * 0022 `attachment_uploads_consume_once` trigger makes this a
 * hard error when the row is not currently `uploaded` — there is no
 * silent "no-op" path. Combined with `message_attachments_upload_unique`
 * on the earlier INSERT, a concurrent double-consume violates one of
 * those two constraints and the whole D1 batch aborts.
 */
export function prepareConsumeAttachmentUpload(
  db: Database,
  input: ConsumeAttachmentUploadInput,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE attachment_uploads
          SET status = 'consumed',
              consumed_at = ?
        WHERE id = ?
          AND status = 'uploaded'`,
    )
    .bind(input.consumedAt, input.uploadId);
}

// ---------------------------------------------------------------------------
// Read-only per-message projection for the outbound-mail queue consumer.
// ---------------------------------------------------------------------------

export interface MessageAttachmentForSend {
  readonly uploadId: string;
  readonly objectKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly disposition: 'attachment' | 'inline';
  readonly contentId: string | null;
}

/**
 * Per-message attachment projection read by `processOutboundJob` so the
 * queue consumer can assemble `SendProviderMessage.attachments` from D1
 * metadata + the exact bytes it reads from CACHE through the
 * `AttachmentByteStore` seam. Read-only — no repository writes through
 * this entry point.
 */
export async function listMessageAttachmentsForSend(
  db: Database,
  input: { readonly messageId: string },
): Promise<ReadonlyArray<MessageAttachmentForSend>> {
  const rows = await db
    .prepare(
      `SELECT upload_id AS upload_id,
              object_key AS object_key,
              filename AS filename,
              content_type AS content_type,
              size_bytes AS size_bytes,
              disposition AS disposition,
              content_id AS content_id
         FROM message_attachments
        WHERE message_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(input.messageId)
    .all<{
      upload_id: string;
      object_key: string;
      filename: string;
      content_type: string;
      size_bytes: number;
      disposition: 'attachment' | 'inline';
      content_id: string | null;
    }>();

  return rows.results.map((row) => ({
    uploadId: row.upload_id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    disposition: row.disposition,
    contentId: row.content_id,
  }));
}

// ---------------------------------------------------------------------------
// Mailbox-scoped attachment download projection.
// ---------------------------------------------------------------------------

/**
 * Canonical metadata needed to serve one consumed attachment. The
 * `message_attachments` row is authoritative for the wire metadata; the
 * upload row is joined only to require the consume-side lifecycle state and
 * to retain the canonical CACHE key.
 */
export interface MessageAttachmentForDownload {
  readonly uploadId: string;
  readonly objectKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly disposition: 'attachment' | 'inline';
}

export interface FindMessageAttachmentForDownloadInput {
  readonly mailboxId: string;
  readonly attachmentId: string;
  readonly userId: string;
}

/**
 * Reads the public download projection through the Messages seam.
 *
 * A row is returned only when the relation is persisted, its upload is
 * consumed, the relation belongs to the requested mailbox, and the
 * requesting user has not soft-deleted that mailbox message. Every other
 * state returns null so the use case can expose one stable not-found result.
 */
export async function findMessageAttachmentForDownload(
  db: Database,
  input: FindMessageAttachmentForDownloadInput,
): Promise<MessageAttachmentForDownload | null> {
  const row = await db
    .prepare(
      `SELECT ma.upload_id AS upload_id,
              ma.object_key AS object_key,
              ma.filename AS filename,
              ma.content_type AS content_type,
              ma.size_bytes AS size_bytes,
              ma.disposition AS disposition
         FROM message_attachments ma
         JOIN attachment_uploads au
           ON au.id = ma.upload_id
          AND au.status = 'consumed'
         JOIN messages m
           ON m.id = ma.message_id
         JOIN mailbox_messages mm
           ON mm.message_id = m.id
          AND mm.mailbox_id = ?
    LEFT JOIN message_user_state mus
           ON mus.mailbox_message_id = mm.id
          AND mus.user_id = ?
        WHERE ma.id = ?
          AND COALESCE(mus.is_deleted, 0) = 0
        LIMIT 1`,
    )
    .bind(input.mailboxId, input.userId, input.attachmentId)
    .first<{
      upload_id: string;
      object_key: string;
      filename: string;
      content_type: string;
      size_bytes: number;
      disposition: 'attachment' | 'inline';
    }>();

  if (!row) return null;

  return {
    uploadId: row.upload_id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    disposition: row.disposition,
  };
}

// ---------------------------------------------------------------------------
// Expired upload cleanup projection and guarded transition.
// ---------------------------------------------------------------------------

export interface ExpiredAttachmentUpload {
  readonly uploadId: string;
  readonly kvKey: string;
  readonly status: 'uploaded' | 'expired';
}

/** Lists expired uploads, including rows awaiting a CACHE-delete retry. */
export async function listExpiredAttachmentUploads(
  db: Database,
  input: { readonly now: string },
): Promise<ReadonlyArray<ExpiredAttachmentUpload>> {
  const rows = await db
    .prepare(
      `SELECT id AS upload_id, kv_key AS kv_key, status AS status
         FROM attachment_uploads
        WHERE (status = 'uploaded' AND expires_at <= ?)
           OR status = 'expired'
        ORDER BY expires_at ASC, id ASC`,
    )
    .bind(input.now)
    .all<{ upload_id: string; kv_key: string; status: 'uploaded' | 'expired' }>();

  return rows.results.map((row) => ({
    uploadId: row.upload_id,
    kvKey: row.kv_key,
    status: row.status,
  }));
}

/** Prepares the guarded uploaded -> expired lifecycle transition. */
export function prepareExpireAttachmentUpload(
  db: Database,
  input: { readonly uploadId: string; readonly now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE attachment_uploads
          SET status = 'expired'
        WHERE id = ?
          AND status = 'uploaded'
          AND expires_at <= ?`,
    )
    .bind(input.uploadId, input.now);
}

/**
 * Guards the audit statement in the same D1 batch as the lifecycle UPDATE.
 * SQLite's changes() is the row count from the immediately preceding UPDATE.
 * A stale cleanup sees zero changes and this deliberately conflicting INSERT
 * aborts the transaction before the audit INSERT executes. When the UPDATE
 * changed one row, the WHERE is false and this statement is a no-op.
 */
export function prepareRequireAttachmentExpiryTransition(
  db: Database,
  input: { readonly uploadId: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO attachment_uploads (
         id, owner_user_id, mailbox_id, kv_key, filename, content_type,
         disposition, size_bytes, status, expires_at, consumed_at, created_at
       )
       SELECT ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        WHERE changes() = 0`,
    )
    .bind(input.uploadId);
}

export async function findAttachmentUploadStatus(
  db: Database,
  input: { readonly uploadId: string },
): Promise<'uploaded' | 'consumed' | 'expired' | null> {
  const row = await db
    .prepare(`SELECT status FROM attachment_uploads WHERE id = ?`)
    .bind(input.uploadId)
    .first<{ status: 'uploaded' | 'consumed' | 'expired' }>();
  return row?.status ?? null;
}
