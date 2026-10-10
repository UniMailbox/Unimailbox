import { EDITOR_PENDING_TTL_SECONDS } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { systemIds } from '../../platform/ids';
import { sha256Hex, sqliteTimestamp } from '../../platform/idempotency';
import { assetPath } from './index';
import type { HostedMailFile } from './mail-attachment-list';

/** Publish authorized, preflighted R2 uploads in the send batch without duplicating bytes. */
export async function prepareHostedLegacyAttachments(
  db: Database,
  input: {
    actorUserId: string;
    mailboxId: string;
    messageId: string;
    origin: string;
    now: string;
    files: readonly { kvKey: string; filename: string; contentType: string; sizeBytes: number }[];
  },
): Promise<{ files: HostedMailFile[]; statements: D1PreparedStatement[] }> {
  const files: HostedMailFile[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const file of input.files) {
    const id = systemIds.uuid();
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    // The compose preflight already persisted exact bytes to R2. Keep the
    // canonical key required by the consume trigger; consumed uploads never expire.
    const objectKey = file.kvKey;
    files.push({
      id,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      url: new URL(assetPath(id, secret), input.origin).href,
    });
    statements.push(
      db
        .prepare(
          `INSERT INTO editor_assets (id,owner_user_id,mailbox_id,domain_id,secret_hash,object_key,filename,content_type,size_bytes,kind,created_at,expires_at) VALUES (?,?,?,NULL,?,?,?,?,?,'file',?,?)`,
        )
        .bind(
          id,
          input.actorUserId,
          input.mailboxId,
          await sha256Hex(secret),
          objectKey,
          file.filename,
          file.contentType,
          file.sizeBytes,
          input.now,
          sqliteTimestamp(
            new Date(
              Date.parse(input.now.replace(' ', 'T') + 'Z') + EDITOR_PENDING_TTL_SECONDS * 1000,
            ),
          ),
        ),
      db
        .prepare(
          `INSERT INTO editor_asset_usages (asset_id,resource_type,resource_id) VALUES (?,'message',?)`,
        )
        .bind(id, input.messageId),
    );
  }
  return { files, statements };
}
