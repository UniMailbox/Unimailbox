// Queue entry — outbound job consumer. CAP-023.
//
// Drains the OUTBOUND queue. For each message body `{ jobId }`, looks up the
// active provider adapter (Phase 1: Brevo), reads + decrypts the stored
// credential, sends via the adapter, and updates the message + job status.
//
// The actual work lives in processOutboundJob so it can be tested without
// queue plumbing (.claude/rules/testing.md §Failure paths).
//
// Delivery semantics: Cloudflare Queues are at-least-once. processOutboundJob
// is idempotent for already-sent jobs, and on failure it marks the job
// 'failed' and rethrows — we then `retry()` so the queue applies its retry
// policy up to the consumer's max_attempts.

import type { MessageBatch } from '@cloudflare/workers-types';
import { parseProviderKey } from '@unimailbox/contracts';
import type { Env } from '../platform/env';
import { readSecret } from '../platform/secrets';
import { processOutboundJob } from '../modules/outbound-mail';
import { providerRegistry } from '../integrations/providers/provider-registry';

interface OutboundJobPayload {
  readonly jobId: string;
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Brevo is the only registered provider in Phase 1. CAP-024 will route by
    // the connection's provider_key when multiple adapters are registered.
    const adapter = providerRegistry.get(parseProviderKey('brevo'));
    if (!adapter) {
      // Without an adapter there is nothing useful we can do — fail the batch
      // so Cloudflare retries once an adapter is registered.
      throw new Error('Brevo adapter not registered');
    }

    // ADR-007: read the encryption key per batch, not per message. Decrypted
    // credential plaintext still lives only for one request inside
    // processOutboundJob.
    const encryptionKey = await readSecret(env.CREDENTIAL_ENCRYPTION_KEY);

    for (const msg of batch.messages) {
      try {
        // The body may arrive as a string (the producer serialised JSON) or
        // already-parsed by the runtime; handle both.
        const payload: OutboundJobPayload =
          typeof msg.body === 'string'
            ? (JSON.parse(msg.body) as OutboundJobPayload)
            : (msg.body as OutboundJobPayload);

        await processOutboundJob(payload.jobId, { db: env.DB, encryptionKey, adapter });
        msg.ack();
      } catch (error) {
        // processOutboundJob has already recorded the failure on the job row.
        // Retry lets Cloudflare apply backoff up to the queue's max retries.
        console.error('Queue processing failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        msg.retry();
      }
    }
  },
};
