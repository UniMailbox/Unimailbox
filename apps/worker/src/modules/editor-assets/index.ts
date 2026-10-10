import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import { sha256Hex, sqliteTimestamp } from '../../platform/idempotency';

export interface EditorAssetRow {
  id: string;
  owner_user_id: string;
  mailbox_id: string | null;
  domain_id: string | null;
  secret_hash: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  kind: 'image' | 'file';
  expires_at: string;
}
export type EditorAssetScope = { mailboxId: string } | { domainId: string };
export const assetPath = (id: string, secret: string): string =>
  `/api/v1/editor-assets/${id}/${secret}`;

export interface ResolvedEditorAsset extends EditorAssetRow {
  secret: string;
}
/** Validate capability, scope, owner and lifecycle before exposing upload metadata. */
export async function resolveEditorAssets(
  db: Database,
  input: {
    html: string;
    text: string;
    actorUserId: string;
    scope: EditorAssetScope;
  },
): Promise<ResolvedEditorAsset[]> {
  const found = new Map<string, string>();
  for (const match of `${input.html}\n${input.text}`.matchAll(
    /\/api\/v1\/editor-assets\/([0-9a-f-]{36})\/([0-9a-f]{64})/g,
  )) {
    if (match[1] && match[2]) found.set(match[1], match[2]);
  }
  if (found.size > 30)
    throw invalidAsset('A message or signature can reference at most 30 uploaded files');
  const assets: ResolvedEditorAsset[] = [];
  for (const [id, secret] of found) {
    const row = await db
      .prepare(
        `SELECT a.*, EXISTS(SELECT 1 FROM editor_asset_usages u WHERE u.asset_id=a.id) AS published FROM editor_assets a WHERE a.id=?`,
      )
      .bind(id)
      .first<EditorAssetRow & { published: number }>();
    const scopeMatches =
      row &&
      ('mailboxId' in input.scope
        ? row.mailbox_id === input.scope.mailboxId
        : row.domain_id === input.scope.domainId);
    if (
      !row ||
      !scopeMatches ||
      row.secret_hash !== (await sha256Hex(secret)) ||
      (!row.published &&
        (row.owner_user_id !== input.actorUserId || row.expires_at <= sqliteTimestamp(new Date())))
    ) {
      throw invalidAsset('An uploaded file is unavailable; upload it again');
    }
    assets.push({ ...row, secret });
  }
  return assets;
}

/** Only uploads in the authorized scope can become durable, in the resource's D1 batch. */
export async function prepareEditorAssetUsages(
  db: Database,
  input: {
    html: string;
    text: string;
    actorUserId: string;
    scope: EditorAssetScope;
    resourceType: 'message' | 'signature';
    resourceId: string;
  },
): Promise<D1PreparedStatement[]> {
  return (await resolveEditorAssets(db, input)).map((asset) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO editor_asset_usages (asset_id,resource_type,resource_id) VALUES (?,?,?)`,
      )
      .bind(asset.id, input.resourceType, input.resourceId),
  );
}

/** Published file links must never also become provider binary attachments. */
export async function listHostedMessageObjectKeys(
  db: Database,
  messageId: string,
): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT a.object_key FROM editor_assets a JOIN editor_asset_usages u ON u.asset_id=a.id
     WHERE u.resource_type='message' AND u.resource_id=? AND a.kind='file'`,
    )
    .bind(messageId)
    .all<{ object_key: string }>();
  return new Set(rows.results.map((row) => row.object_key));
}
export function invalidAsset(message: string): DomainError {
  return new DomainError({ code: 'VALIDATION_ERROR', message, httpStatus: 400 });
}

/** Delete D1 first; FK-protected published files can never be swept. Retry orphan R2 deletion on a later tick. */
export async function expireEditorAssets(db: Database, bucket: R2Bucket): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT a.id,a.object_key FROM editor_assets a WHERE expires_at <= ? AND NOT EXISTS(SELECT 1 FROM editor_asset_usages u WHERE u.asset_id=a.id) LIMIT 100`,
    )
    .bind(sqliteTimestamp(new Date()))
    .all<{ id: string; object_key: string }>();
  for (const row of rows.results) {
    // An atomic delete loses cleanly if a publication landed since the SELECT.
    const removed = await db
      .prepare(
        `DELETE FROM editor_assets WHERE id=? AND NOT EXISTS(SELECT 1 FROM editor_asset_usages WHERE asset_id=?) RETURNING object_key`,
      )
      .bind(row.id, row.id)
      .first<{ object_key: string }>();
    if (removed) await bucket.delete(removed.object_key);
  }
}

/** Daily, bounded scan. Failed D1 writes/deletes leave R2 orphans for a later pass. */
export async function sweepOrphanedEditorAssets(
  db: Database,
  bucket: R2Bucket,
  cursorStore: KVNamespace,
): Promise<void> {
  // R2 objects whose D1 write failed / whose deletion failed are bounded orphan uploads.
  const cursorKey = 'editor-assets:orphan-cursor';
  const cursor = await cursorStore.get(cursorKey);
  const page = await bucket.list({
    prefix: 'editor-assets/',
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  for (const object of page.objects) {
    if (object.uploaded.getTime() > Date.now() - 7 * 86400_000) continue;
    if (
      !(await db
        .prepare('SELECT id FROM editor_assets WHERE object_key=?')
        .bind(object.key)
        .first())
    )
      await bucket.delete(object.key);
  }
  if (page.truncated) await cursorStore.put(cursorKey, page.cursor);
  else if (cursor !== null) await cursorStore.delete(cursorKey);
}

export { uploadEditorAsset } from './upload-editor-asset';
export { prepareHostedLegacyAttachments } from './host-legacy-attachments';
export { appendAttachmentList, type HostedMailFile } from './mail-attachment-list';
