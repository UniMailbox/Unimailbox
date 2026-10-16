import type { Database } from '../../platform/database';

/** Returns only canonical D1 references for a bounded R2 page. */
export async function findReferencedInboundObjectKeys(
  db: Database,
  prefix: 'raw-mime/' | 'inbound-attachment/' | 'attachment:',
  keys: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> {
  if (keys.length === 0) return new Set();
  const placeholders = keys.map(() => '?').join(', ');
  const sql =
    prefix === 'raw-mime/'
      ? `WITH requested(object_key) AS (VALUES ${keys.map(() => '(?)').join(', ')})
         SELECT raw_object_key AS object_key FROM messages
          WHERE raw_object_key IN (SELECT object_key FROM requested)
         UNION SELECT raw_object_key AS object_key FROM inbound_receipts
          WHERE raw_object_key IN (SELECT object_key FROM requested)`
      : prefix === 'inbound-attachment/'
        ? `SELECT object_key FROM inbound_message_attachments WHERE object_key IN (${placeholders})`
        : `SELECT kv_key AS object_key FROM attachment_uploads
            WHERE kv_key IN (${placeholders}) AND status IN ('uploaded', 'consumed')`;
  const rows = await db
    .prepare(sql)
    .bind(...keys)
    .all<{ object_key: string }>();
  return new Set((rows.results ?? []).map((row) => row.object_key));
}
