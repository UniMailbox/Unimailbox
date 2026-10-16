// Queue entry — outbound job consumer. CAP-023 + CAP-040.
//
// Drains the mail-work queue (historical OUTBOUND binding). Versioned inbound
// envelopes recover accepted receipts; legacy `{ jobId }` bodies look up the
// provider adapter selected after claiming the job's assigned connection, reads +
// decrypts the stored credential, sends via the adapter, and updates the
// message + job status.
//
// The actual work lives in processOutboundJob so it can be tested without
// queue plumbing (.claude/rules/testing.md §Failure paths).
//
// Delivery semantics: Cloudflare Queues are at-least-once. processOutboundJob
// skips terminal jobs, records permanent provider/configuration failures and
// returns so they are acked. Retryable failures are recorded before rethrow;
// the catch below asks Cloudflare to retry the queue message.
//
// CAP-040 / R-AUDIT-001: a per-batch correlation UUID is synthesised at
// the top of the handler. Every audit row emitted during the batch
// (success or reconciliation back-fill) carries the same requestId so a
// reader of audit_events can group the operations of one queue batch.

import type { MessageBatch } from '@cloudflare/workers-types';
import type { Env } from '../platform/env';
import { readSecret } from '../platform/secrets';
import { processOutboundJob } from '../modules/outbound-mail';
import { providerRegistry } from '../integrations/providers/provider-registry';
import { buildAppContext } from '../app-context';
import { systemIds } from '../platform/ids';
import { getAttachmentByteStore, getAttachmentObjectStore } from '../platform/cache';
import { inboundWorkPayloadSchema, RetryableProviderError } from '@unimailbox/contracts';
import { processInboundReceipt } from '../modules/inbound-mail';
import { logger } from '../platform/logger';

interface OutboundJobPayload {
  readonly jobId: string;
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // ADR-007: read once on the first outbound job; inbound work does not
    // depend on outbound credentials. Provider plaintext stays request-scoped.
    let encryptionKey: string | undefined;

    // CAP-040 / R-AUDIT-001: synthesise one correlation UUID for the whole
    // batch. processOutboundJob receives it via ProcessJobDeps.requestId and
    // carries it through to every audit_events row it writes.
    const requestId = systemIds.uuid();
    const ctx = buildAppContext(env);
    // CAP-050: narrow CACHE seam for CAP-049-staged attachment bytes. The
    // byte store is shared across messages in this batch so the per-batch
    // wiring is the right granularity.
    const attachmentByteStore = getAttachmentByteStore(env);
    const attachmentObjectStore = getAttachmentObjectStore(env);

    for (const msg of batch.messages) {
      try {
        // The body may arrive as a string (the producer serialised JSON) or
        // already-parsed by the runtime; handle both.
        const body: unknown = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
        if (body && typeof body === 'object' && 'kind' in body) {
          const payload = inboundWorkPayloadSchema.parse(body);
          const deferred = await processInboundReceipt(payload.receiptId, ctx);
          if (deferred) msg.retry(deferred);
          else msg.ack();
          continue;
        }
        const payload = body as OutboundJobPayload;
        encryptionKey ??= await readSecret(env.CREDENTIAL_ENCRYPTION_KEY);

        const deferred = await processOutboundJob(payload.jobId, {
          db: env.DB,
          encryptionKey,
          resolveAdapter: (key) => providerRegistry.get(key),
          requestId,
          auditEventWriter: ctx.auditEventWriter,
          attachmentByteStore,
          attachmentObjectStore,
        });
        if (deferred) msg.retry({ delaySeconds: deferred.delaySeconds });
        else msg.ack();
      } catch (error) {
        // Retry transport/validation/persistence failures without leaking an
        // SDK error, malformed Queue body or its nested cause (R-LOG-001).
        logger.error(
          { event: 'queue.processing_failed', requestId },
          { code: 'QUEUE_PROCESSING_FAILED' },
        );
        if (error instanceof RetryableProviderError && error.retryAfterSeconds !== undefined)
          msg.retry({ delaySeconds: Math.min(86400, Math.max(1, error.retryAfterSeconds)) });
        else msg.retry();
      }
    }
  },
};
