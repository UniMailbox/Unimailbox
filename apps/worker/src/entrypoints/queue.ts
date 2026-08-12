// Queue entry — outbound job consumer. CAP-001 stub.
// Real provider dispatch lands with the outbound-mail module (CAP-023).
import type { MessageBatch } from '@cloudflare/workers-types';

export default {
  async queue(batch: MessageBatch): Promise<void> {
    // CAP-001 stub — drain the batch with no side effects. Messages are
    // acknowledged by returning; this stub exists so the consumer entrypoint
    // is reachable from the deployed Worker bundle.
    for (const _msg of batch.messages) {
      // acknowledged by returning
      void _msg;
    }
  },
};