import { normalizeAddress, parseInboundMime } from '@unimailbox/email-core';
import {
  attachmentContentTypeSchema,
  attachmentFilenameSchema,
  type AuditEventWriter,
  type InboundWorkPayload,
} from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import type { ObjectStore } from '../../platform/object-store';
import { systemClock, type Clock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { sqliteTimestamp } from '../../platform/idempotency';
import { logger } from '../../platform/logger';
import {
  claimInboundReceipt,
  findInboundReceipt,
  findInboundReceiptByKey,
  reserveInboundReceipt,
  prepareCompleteInboundReceipt,
  retryInboundReceipt,
  claimRecoverableInboundReceipts,
  expireCompletedInboundReceipts,
  prepareCreateMessage,
  prepareCreateRecipient,
  prepareCreateMailboxMessage,
  prepareCreateInboundAttachment,
} from '../messages';
import { inboundRawHash, readInboundBytes } from './read-inbound';

type InboundMime = Awaited<ReturnType<typeof parseInboundMime>>;
interface InboundDependencies {
  db: Database;
  objectStore: ObjectStore;
  auditEventWriter: AuditEventWriter;
  clock?: Clock;
}
export interface InboundEnqueuer {
  send(body: InboundWorkPayload, options?: { delaySeconds: number }): Promise<unknown>;
}

/** Call only after synchronous recipient/size/content policy acceptance. */
export async function acceptInboundReceipt(
  deps: Pick<InboundDependencies, 'db' | 'objectStore' | 'clock'>,
  input: { mailboxId: string; from: string; to: string; raw: ArrayBuffer; requestId: string },
): Promise<string> {
  const now = (deps.clock ?? systemClock).now();
  const from = normalizeAddress(input.from);
  const to = normalizeAddress(input.to);
  const rawHash = await inboundRawHash(input.raw);
  // Length-delimited JSON scope: MIME Message-ID alone is never a delivery identity.
  const key = await inboundRawHash(
    new TextEncoder().encode(JSON.stringify([1, input.mailboxId, from, to, rawHash])).buffer,
  );
  const existing = await findInboundReceiptByKey(deps.db, key, now);
  if (existing) return existing.id;
  const id = systemIds.uuid();
  const rawKey = `raw-mime/${id}`;
  await deps.objectStore.put(rawKey, input.raw);
  // Do not delete raw on a D1 error: the reservation may have committed before
  // its response failed. The reference-aware orphan sweep resolves ambiguity.
  const receipt = await reserveInboundReceipt(deps.db, {
    id,
    key,
    mailboxId: input.mailboxId,
    from,
    to,
    rawKey,
    rawHash,
    rawSize: input.raw.byteLength,
    requestId: input.requestId,
    now,
  });
  if (receipt.id !== id) await deps.objectStore.delete(rawKey).catch(() => {});
  return receipt.id;
}

/** Same use case serves immediate delivery and durable Queue/Cron recovery. */
export async function processInboundReceipt(
  id: string,
  deps: InboundDependencies,
  initialMime?: InboundMime,
): Promise<void | { delaySeconds: number }> {
  const clock = deps.clock ?? systemClock;
  const token = systemIds.uuid();
  const receipt = await claimInboundReceipt(deps.db, id, token, clock.now());
  if (!receipt) {
    const current = await findInboundReceipt(deps.db, id);
    if (!current || current.status === 'completed') return;
    const due = Date.parse(current.lease_until ?? current.next_attempt_at);
    return { delaySeconds: Math.max(1, Math.min(3600, Math.ceil((due - clock.unixMs()) / 1000))) };
  }
  try {
    let mime = initialMime;
    if (!mime) {
      const object = await deps.objectStore.get(receipt.raw_object_key);
      if (!object || object.size !== receipt.raw_size) throw new Error('Inbound raw unavailable');
      const raw = await readInboundBytes(object.body, object.size);
      if ((await inboundRawHash(raw)) !== receipt.raw_sha256)
        throw new Error('Inbound raw mismatch');
      mime = await parseInboundMime(new Uint8Array(raw));
    }
    const { parsed, attachments } = mime;
    const now = sqliteTimestamp(new Date(receipt.created_at));
    const statements = [
      ...prepareCompleteInboundReceipt(deps.db, id, token, clock.now()),
      prepareCreateMessage(deps.db, {
        id,
        parsed,
        receivedAt: now,
        createdAt: now,
        updatedAt: now,
        rawObjectKey: receipt.raw_object_key,
      }),
    ];
    const recipients = [
      ...parsed.to.map((entry) => ({ ...entry, type: 'to' as const })),
      ...parsed.cc.map((entry) => ({ ...entry, type: 'cc' as const })),
    ];
    const allRecipients: { address: string; name: string; type: 'to' | 'cc' | 'bcc' }[] = [
      ...recipients,
    ];
    if (!recipients.some((entry) => normalizeAddress(entry.address) === receipt.envelope_to))
      allRecipients.push({ address: receipt.envelope_to, name: '', type: 'bcc' });
    for (const recipient of allRecipients) {
      statements.push(
        prepareCreateRecipient(deps.db, {
          id: systemIds.uuid(),
          messageId: id,
          address: recipient.address,
          displayName: recipient.name,
          type: recipient.type,
          createdAt: now,
        }),
      );
    }
    statements.push(
      prepareCreateMailboxMessage(deps.db, {
        id: systemIds.uuid(),
        mailboxId: receipt.mailbox_id,
        messageId: id,
        createdAt: now,
      }),
    );
    for (const attachment of attachments) {
      const attachmentId = systemIds.uuid();
      const objectKey = `inbound-attachment/${id}/${attachmentId}`;
      const filename = attachmentFilenameSchema.safeParse(
        attachment.filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 255),
      );
      const contentType = attachmentContentTypeSchema.safeParse(attachment.contentType);
      // Attempt-specific keys cannot overwrite a winning worker's bytes. Failed
      // attempts leave only orphan objects, reclaimed after the normal grace.
      await deps.objectStore.put(objectKey, attachment.content);
      statements.push(
        prepareCreateInboundAttachment(deps.db, {
          id: attachmentId,
          messageId: id,
          objectKey,
          filename: filename.success ? filename.data : 'attachment',
          contentType: contentType.success ? contentType.data : 'application/octet-stream',
          sizeBytes: attachment.content.byteLength,
          disposition: attachment.disposition,
          contentId: attachment.contentId?.replace(/[\0\r\n]/g, '').slice(0, 255) || null,
          createdAt: now,
        }),
      );
    }
    statements.push(
      deps.auditEventWriter.prepare({
        id: systemIds.uuid(),
        actorUserId: null,
        action: 'message.receive',
        resourceType: 'message',
        resourceId: id,
        requestId: receipt.request_id,
        createdAt: now,
      }).statement as D1PreparedStatement,
    );
    // R-INBOUND-008 / R-AUDIT-001: receipt, message, relations and audit commit together.
    await deps.db.batch(statements);
  } catch {
    if ((await findInboundReceipt(deps.db, id))?.status === 'completed') return;
    const delaySeconds = await retryInboundReceipt(deps.db, receipt, token, clock.now());
    logger.warn(
      { event: 'inbound.processing_deferred', requestId: receipt.request_id },
      { code: 'INBOUND_PROCESSING_FAILED' },
    );
    return { delaySeconds };
  }
}

/** Bounded outbox-style dispatch also repairs a crash before the initial Queue send. */
export async function recoverInboundReceipts(deps: {
  db: Database;
  queue: InboundEnqueuer;
  clock?: Clock;
}): Promise<void> {
  const ids = await claimRecoverableInboundReceipts(deps.db, (deps.clock ?? systemClock).now());
  let failed = false;
  for (const receiptId of ids) {
    try {
      await deps.queue.send({ kind: 'inbound', version: 1, receiptId });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('Inbound recovery enqueue failed');
}

export { expireCompletedInboundReceipts };
