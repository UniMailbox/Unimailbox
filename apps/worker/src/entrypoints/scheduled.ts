// Scheduled entry — cron handler. CAP-001 stub.
// Real cron targets (TTL purges, re-encryption jobs) land with later capabilities.
import type { ScheduledController } from '@cloudflare/workers-types';

export default {
  async scheduled(_controller: ScheduledController): Promise<void> {
    // CAP-001 stub — no work.
    void _controller;
  },
};