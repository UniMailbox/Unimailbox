// Scheduled entry — cron handler. CAP-001 stub + CAP-028 outbound reclaim.
//
// Owner: entrypoints/scheduled.ts is a thin shell. The actual work lives in
// modules/outbound-mail/reclaim-stale-jobs.ts; this file only wires the env
// (D1 binding) and calls it.
//
// Future cron targets (idempotency-records TTL purge, encrypted_credentials
// re-encryption) will land as additional calls in the same handler. Each
// capability owns its target; we do not introduce a "cron bus".
//
// CAP-040 / R-AUDIT-001: a per-tick correlation UUID is synthesised and
// passed through to every audit row that the cron path emits (currently
// none — the reclaim does not write audit rows; the field is wired in
// for symmetry with the queue entrypoint and for any future audit emit).
import type { ScheduledController } from '@cloudflare/workers-types';
import type { Env } from '../platform/env';
import { reclaimStaleJobs } from '../modules/outbound-mail';
import { systemIds } from '../platform/ids';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
  ): Promise<void> {
    // CAP-040 / R-AUDIT-001: one correlation UUID per cron tick. Held in a
    // local variable so a future audit-emitting cron target (idempotency
    // purge, credential rotation) can thread it through to its audit rows
    // without re-synthesising.
    const requestId = systemIds.uuid();
    // CAP-028: reclaim any existing worker jobs whose lease has expired and
    // re-enqueue them onto the OUTBOUND queue. CRON cadence is
    // `*/2 * * * *` (see apps/worker/wrangler.jsonc).
    // The requestId is currently unused by reclaimStaleJobs (no audit
    // emits); threaded through for forward compatibility.
    await reclaimStaleJobs(env.DB, new Date(), env.OUTBOUND, requestId);
  },
};