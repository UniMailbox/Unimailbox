import { EDITOR_PENDING_TTL_SECONDS, type AttachmentUploadMetadata } from '@unimailbox/contracts';
import { systemIds } from '../../platform/ids';
import { systemClock } from '../../platform/clock';
import type { AuditEventWriter } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { storeEditorUpload } from '../../platform/editor-upload-store';
import {
  findIdempotencyRecord,
  assertSameRequestHash,
  prepareCreateIdempotencyRecord,
  sha256Hex,
  sqliteTimestamp,
  isIdempotencyUniqueViolation,
} from '../../platform/idempotency';
import { assetPath, invalidAsset } from './index';
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function isRaster(bytes: Uint8Array, type: string): boolean {
  const starts = (...values: number[]): boolean => values.every((value, i) => bytes[i] === value);
  if (type === 'image/png') return starts(137, 80, 78, 71, 13, 10, 26, 10);
  if (type === 'image/jpeg') return starts(255, 216, 255);
  if (type === 'image/gif')
    return new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
  if (type === 'image/webp')
    return (
      new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
    );
  return false;
}
export async function uploadEditorAsset(
  dependencies: { db: Database; bucket: R2Bucket; auditEventWriter: AuditEventWriter },
  input: {
    requestId: string | null;
    actorUserId: string;
    mailboxId: string | null;
    domainId: string | null;
    kind: 'image' | 'file';
    metadata: AttachmentUploadMetadata;
    sizeBytes: number;
    body: ReadableStream<Uint8Array> | null;
    operation: string;
    idempotencyKey: string;
    origin: string;
  },
): Promise<{ status: number; responseJson: string }> {
  const { db, bucket } = dependencies;
  const { actorUserId: userId, mailboxId, domainId, kind, metadata } = input;
  const operation = input.operation;
  const key = input.idempotencyKey;
  const existing = await findIdempotencyRecord(db, userId, operation, key);
  // Replay must remain possible at a full quota; only fresh uploads consume it.
  if (!existing) {
    const quota = await db
      .prepare(
        'SELECT COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS size FROM editor_assets WHERE owner_user_id=? AND NOT EXISTS(SELECT 1 FROM editor_asset_usages WHERE asset_id=editor_assets.id)',
      )
      .bind(userId)
      .first<{ count: number; size: number }>();
    if (quota && (quota.count >= 100 || quota.size + input.sizeBytes > 256 * 1024 * 1024)) {
      await input.body?.cancel().catch(() => {});
      throw invalidAsset('Pending upload limit reached; send or save existing uploads first');
    }
  }
  const id = systemIds.uuid();
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const objectKey = `editor-assets/${id}`;
  const stored = await storeEditorUpload(
    existing ? null : bucket,
    objectKey,
    input.body,
    input.sizeBytes,
  );
  if (
    kind === 'image' &&
    (!RASTER_TYPES.has(metadata.contentType) || !isRaster(stored.prefix, metadata.contentType))
  ) {
    if (!existing) await bucket.delete(objectKey);
    throw invalidAsset('Use a PNG, JPEG, GIF or WebP image');
  }
  const hash = await sha256Hex(
    JSON.stringify([metadata.filename, metadata.contentType, kind, stored.hash]),
  );
  if (existing) {
    assertSameRequestHash(existing, hash);
    return { status: existing.responseStatus, responseJson: existing.responseJson };
  }
  const now = sqliteTimestamp(systemClock.now());
  const expires = sqliteTimestamp(
    new Date(systemClock.unixMs() + EDITOR_PENDING_TTL_SECONDS * 1000),
  );
  const responseJson = JSON.stringify({
    data: {
      id,
      filename: metadata.filename,
      contentType: metadata.contentType,
      sizeBytes: input.sizeBytes,
      kind,
      url: new URL(assetPath(id, secret), input.origin).href,
    },
  });

  try {
    await db.batch([
      dependencies.auditEventWriter.prepare({
        id: systemIds.uuid(),
        actorUserId: userId,
        action: 'attachment.uploaded',
        resourceType: 'editor_asset',
        resourceId: id,
        requestId: input.requestId,
        createdAt: now,
      }).statement as unknown as D1PreparedStatement,
      db
        .prepare(
          `INSERT INTO editor_assets (id,owner_user_id,mailbox_id,domain_id,secret_hash,object_key,filename,content_type,size_bytes,kind,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          userId,
          mailboxId,
          domainId,
          await sha256Hex(secret),
          objectKey,
          metadata.filename,
          metadata.contentType,
          input.sizeBytes,
          kind,
          now,
          expires,
        ),
      prepareCreateIdempotencyRecord(db, {
        id: systemIds.uuid(),
        actorId: userId,
        operation,
        idempotencyKey: key,
        requestHash: hash,
        responseStatus: 201,
        responseJson,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('EDITOR_ASSET_PENDING_LIMIT')) {
      await bucket.delete(objectKey);
      throw invalidAsset('Pending upload limit reached; send or save existing uploads first');
    }
    // Ambiguous D1 acknowledgements preserve bytes; the orphan sweep handles absent rows.
    if (isIdempotencyUniqueViolation(error)) {
      const winner = await findIdempotencyRecord(db, userId, operation, key);
      if (winner) {
        await bucket.delete(objectKey);
        assertSameRequestHash(winner, hash);
        return { status: winner.responseStatus, responseJson: winner.responseJson };
      }
    }
    throw error;
  }
  return { status: 201, responseJson };
}
