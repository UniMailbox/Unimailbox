import { migrationsDb } from './migrationsDb';
import { seedOutboundSubmission } from './outbound';

/** Metadata fixture, used only after seedResourceUsageActor has created its owner/mailbox. */
export async function seedMailProcessingMetrics() {
  const db = await migrationsDb();
  const owner = await db.prepare('SELECT id FROM users LIMIT 1').first<{ id: string }>();
  const mailbox = await db.prepare('SELECT id FROM mailboxes LIMIT 1').first<{ id: string }>();
  if (!owner || !mailbox) throw new Error('Seed analytics actor first');
  const f = await seedOutboundSubmission({
    ciphertext: new Uint8Array(16),
    iv: new Uint8Array(12),
    authTag: new Uint8Array(16),
  });
  const inboundId = 'd1000000-0000-4000-8000-000000000001';
  await db.batch([
    db
      .prepare(
        "UPDATE messages SET created_at='2026-10-15 08:00:00',created_by_user_id=?,subject='private-subject-marker',text_body='private-body-marker' WHERE id=?",
      )
      .bind(owner.id, f.messageId),
    db
      .prepare(
        "UPDATE outbound_jobs SET status='sent',created_at='2026-10-15 08:00:00',updated_at='2026-10-15 08:00:01' WHERE id=?",
      )
      .bind(f.jobId),
    db
      .prepare(
        "INSERT INTO messages(id,from_address,raw_object_key,created_at) VALUES (?,'private-sender@example.test','private-raw-key','2026-10-16T00:00:00.000Z')",
      )
      .bind(inboundId),
  ]);
  for (const [index, status, created, updated, attempts, error] of [
    [2, 'sent', '2026-10-15 09:00:00', '2026-10-15 09:00:03', 0, null],
    [3, 'sent', '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:09.000Z', 0, null],
    [4, 'failed', '2026-10-16 01:00:00', '2026-10-16 01:01:00', 2, 'SEND_FAILED'],
    [5, 'sending', '2026-10-16 02:00:00', '2026-10-16 02:01:00', 0, 'SEND_OUTCOME_UNKNOWN'],
    [6, 'queued', '2026-10-16 03:00:00', '2026-10-16 03:01:00', 1, 'SEND_FAILED'],
  ] as const)
    await db
      .prepare(
        'INSERT INTO outbound_jobs(id,message_id,provider_connection_id,status,created_at,updated_at,attempts,error_code) VALUES (?,?,?,?,?,?,?,?)',
      )
      .bind(
        `fixture-job-${index}`,
        f.messageId,
        f.connectionId,
        status,
        created,
        updated,
        attempts,
        error,
      )
      .run();
  for (const [index, bytes] of [
    [1, 10],
    [2, 20],
  ] as const)
    await db
      .prepare(
        "INSERT INTO inbound_message_attachments(id,message_id,object_key,filename,content_type,size_bytes,disposition,created_at) VALUES (?, ?, ?, 'private-file-marker.bin','application/octet-stream',?,'attachment','2026-10-16 00:00:00')",
      )
      .bind(
        `d2000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        inboundId,
        `inbound-attachment/private-${index}`,
        bytes,
      )
      .run();
  const uploadId = 'd3000000-0000-4000-8000-000000000001';
  await db.batch([
    db
      .prepare(
        "INSERT INTO attachment_uploads(id,owner_user_id,mailbox_id,kv_key,filename,content_type,size_bytes,status,expires_at) VALUES (?,?,?,?,'private-file-marker.bin','application/octet-stream',45,'uploaded','2099-01-01')",
      )
      .bind(uploadId, owner.id, mailbox.id, `attachment:${uploadId}`),
    db
      .prepare(
        "INSERT INTO message_attachments(id,message_id,upload_id,object_key,filename,content_type,size_bytes) VALUES ('d4000000-0000-4000-8000-000000000001',?,?,?,'private-file-marker.bin','application/octet-stream',45)",
      )
      .bind(f.messageId, uploadId, `attachment:${uploadId}`),
  ]);
  for (const [index, bytes] of [
    [1, 16],
    [2, 48],
  ] as const) {
    const id = `fixture-asset-${index}`;
    await db.batch([
      db
        .prepare(
          "INSERT INTO editor_assets(id,owner_user_id,mailbox_id,secret_hash,object_key,filename,content_type,size_bytes,kind,created_at,expires_at) VALUES (?,?,?,'private-secret-hash',?,'private-hosted-marker.bin','application/octet-stream',?,'file','2026-10-15 08:00:00','2099-01-01')",
        )
        .bind(id, owner.id, mailbox.id, `fixture-editor-${index}`, bytes),
      db
        .prepare(
          "INSERT INTO editor_asset_usages(asset_id,resource_type,resource_id) VALUES (?,'message',?)",
        )
        .bind(id, f.messageId),
    ]);
  }
  const receiptId = 'fixture-receipt';
  await db
    .prepare(
      `INSERT INTO inbound_receipts(id,dedup_key,mailbox_id,envelope_from,envelope_to,raw_object_key,raw_sha256,raw_size,request_id,status,attempts,next_attempt_at,dispatch_after,created_at,completed_at)
    VALUES (?,?,?,'private-sender@example.test','private-destination@example.test','private-receipt-key',?,26214400,'fixture-request','completed',3,?,?,?,?)`,
    )
    .bind(
      receiptId,
      'a'.repeat(64),
      mailbox.id,
      'b'.repeat(64),
      '2026-10-16T00:00:00.000Z',
      '2026-10-16T00:00:00.000Z',
      '2026-10-16T00:00:00.000Z',
      '2026-10-16T00:00:04.000Z',
    )
    .run();
  return { ...f, inboundId, receiptId };
}
