import type { Database } from '../../platform/database';

export const INBOUND_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INBOUND_LEASE_MS = 2 * 60 * 1000;

export interface InboundReceipt {
  id: string;
  dedup_key: string;
  mailbox_id: string;
  envelope_from: string;
  envelope_to: string;
  raw_object_key: string;
  raw_sha256: string;
  raw_size: number;
  request_id: string;
  status: 'pending' | 'processing' | 'completed';
  attempts: number;
  locked_by: string | null;
  lease_until: string | null;
  next_attempt_at: string;
  last_error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export function findInboundReceipt(db: Database, id: string): Promise<InboundReceipt | null> {
  return db.prepare('SELECT * FROM inbound_receipts WHERE id=?').bind(id).first<InboundReceipt>();
}

export async function findInboundReceiptByKey(
  db: Database,
  key: string,
  now: Date,
): Promise<InboundReceipt | null> {
  return db
    .prepare(
      `SELECT * FROM inbound_receipts WHERE dedup_key=?
    AND (status!='completed' OR completed_at>?)`,
    )
    .bind(key, new Date(now.getTime() - INBOUND_DEDUP_WINDOW_MS).toISOString())
    .first<InboundReceipt>();
}

/** R2 bytes must already exist. A race retains the first accepted receipt. */
export async function reserveInboundReceipt(
  db: Database,
  input: {
    id: string;
    key: string;
    mailboxId: string;
    from: string;
    to: string;
    rawKey: string;
    rawHash: string;
    rawSize: number;
    requestId: string;
    now: Date;
  },
): Promise<InboundReceipt> {
  const now = input.now.toISOString();
  const inserted = await db
    .prepare(
      `INSERT INTO inbound_receipts
    (id,dedup_key,mailbox_id,envelope_from,envelope_to,raw_object_key,raw_sha256,raw_size,
     request_id,next_attempt_at,dispatch_after,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(dedup_key) DO UPDATE SET id=excluded.id, mailbox_id=excluded.mailbox_id,
      envelope_from=excluded.envelope_from, envelope_to=excluded.envelope_to,
      raw_object_key=excluded.raw_object_key, raw_sha256=excluded.raw_sha256,
      raw_size=excluded.raw_size, request_id=excluded.request_id, status='pending',
      attempts=0, locked_by=NULL, lease_until=NULL, last_error_code=NULL,
      next_attempt_at=excluded.next_attempt_at, dispatch_after=excluded.dispatch_after,
      created_at=excluded.created_at, completed_at=NULL
    WHERE inbound_receipts.status='completed' AND inbound_receipts.completed_at<=?
    RETURNING *`,
    )
    .bind(
      input.id,
      input.key,
      input.mailboxId,
      input.from,
      input.to,
      input.rawKey,
      input.rawHash,
      input.rawSize,
      input.requestId,
      now,
      now,
      now,
      new Date(input.now.getTime() - INBOUND_DEDUP_WINDOW_MS).toISOString(),
    )
    .first<InboundReceipt>();
  const receipt = inserted ?? (await findInboundReceiptByKey(db, input.key, input.now));
  if (!receipt) throw new Error('Inbound receipt reservation failed');
  return receipt;
}

export function claimInboundReceipt(db: Database, id: string, token: string, now: Date) {
  return db
    .prepare(
      `UPDATE inbound_receipts SET status='processing', locked_by=?, lease_until=?,
    attempts=attempts+1 WHERE id=? AND
    ((status='pending' AND next_attempt_at<=?) OR (status='processing' AND lease_until<=?))
    RETURNING *`,
    )
    .bind(
      token,
      new Date(now.getTime() + INBOUND_LEASE_MS).toISOString(),
      id,
      now.toISOString(),
      now.toISOString(),
    )
    .first<InboundReceipt>();
}

/** Put first in the message batch. The assertion fences expired/stolen leases atomically. */
export function prepareCompleteInboundReceipt(db: Database, id: string, token: string, now: Date) {
  return [
    db
      .prepare(
        `UPDATE inbound_receipts SET status='completed', completed_at=?, locked_by=NULL,
      lease_until=NULL, last_error_code=NULL WHERE id=? AND status='processing' AND locked_by=?`,
      )
      .bind(now.toISOString(), id, token),
    db.prepare('INSERT INTO inbound_receipts(id) SELECT NULL WHERE changes()=0'),
  ];
}

export async function retryInboundReceipt(
  db: Database,
  receipt: InboundReceipt,
  token: string,
  now: Date,
) {
  const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(receipt.attempts - 1, 7));
  await db
    .prepare(
      `UPDATE inbound_receipts SET status='pending', locked_by=NULL, lease_until=NULL,
    next_attempt_at=?, last_error_code='INBOUND_PROCESSING_FAILED'
    WHERE id=? AND status='processing' AND locked_by=?`,
    )
    .bind(new Date(now.getTime() + delaySeconds * 1000).toISOString(), receipt.id, token)
    .run();
  return delaySeconds;
}

/** Checkpoint dispatch before enqueue; enqueue loss becomes eligible on the next five-minute tick. */
export async function claimRecoverableInboundReceipts(db: Database, now: Date) {
  const rows = await db
    .prepare(
      `UPDATE inbound_receipts SET status='pending', locked_by=NULL,
    lease_until=NULL, dispatch_after=? WHERE id IN (
      SELECT id FROM inbound_receipts WHERE dispatch_after<=? AND
        ((status='pending' AND next_attempt_at<=?) OR (status='processing' AND lease_until<=?))
      ORDER BY next_attempt_at, id LIMIT 20) RETURNING id`,
    )
    .bind(
      new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    )
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export async function expireCompletedInboundReceipts(db: Database, now: Date): Promise<void> {
  await db
    .prepare(
      `DELETE FROM inbound_receipts WHERE id IN (SELECT id FROM inbound_receipts
    WHERE status='completed' AND completed_at<=? ORDER BY completed_at LIMIT 1000)`,
    )
    .bind(new Date(now.getTime() - INBOUND_DEDUP_WINDOW_MS).toISOString())
    .run();
}
