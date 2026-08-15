// Scheduled entry — cron handler. CAP-001 stub + CAP-028 outbound reclaim.
//
// Owner: entrypoints/scheduled.ts is a thin shell. The actual work lives in
// modules/outbound-mail/reclaim-stale-jobs.ts; this file only wires the env
// (D1 binding) and calls it.
//
// Future cron targets (idempotency-records TTL purge, encrypted_credentials
// re-encryption) will land as additional calls in the same handler. Each
// capability owns its target; we do not introduce a "cron bus".
import type { ScheduledController } from '@cloudflare/workers-types';
import type { Env } from '../platform/env';
import { reclaimStaleJobs } from '../modules/outbound-mail';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
  ): Promise<void> {
    // CAP-028: reclaim any outbound jobs whose lease has expired and
    // re-enqueue them onto the OUTBOUND queue. CRON cadence is
    // `*/2 * * * *` (see apps/worker/wrangler.jsonc).
    await reclaimStaleJobs(env.DB, new Date(), env.OUTBOUND);
  },
};