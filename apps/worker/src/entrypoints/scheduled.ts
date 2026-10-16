// Scheduled maintenance: isolate failures, persist heartbeat and emit an overall result.
import type { ScheduledController } from '@cloudflare/workers-types';
import type { Env } from '../platform/env';
import { reclaimStaleJobs } from '../modules/outbound-mail';
import { expireAttachments } from '../modules/attachments';
import { systemIds } from '../platform/ids';
import { buildAppContext } from '../app-context';
import { getAttachmentByteStore, getAttachmentObjectStore } from '../platform/cache';
import { sweepOrphanedInboundObjects } from '../modules/messages';
import { expireEditorAssets, sweepOrphanedEditorAssets } from '../modules/editor-assets';
import { expireIdentityRecords, sweepPersonalAvatars } from '../modules/identity';
import { logger } from '../platform/logger';
import { recoverInboundReceipts, expireCompletedInboundReceipts } from '../modules/inbound-mail';

import { runMaintenanceTasks } from '../platform/maintenance';

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const requestId = systemIds.uuid();
    // Accept the former expression while Cloudflare propagates the trigger change.
    if (controller.cron !== '*/5 * * * *' && controller.cron !== '*/2 * * * *')
      throw new Error('Unknown maintenance schedule');
    const runs = [
      runMaintenanceTasks(env, requestId, [
        {
          name: 'outbound.reclaim',
          run: () => reclaimStaleJobs(env.DB, new Date(), env.OUTBOUND, requestId),
        },
        {
          name: 'inbound.recover',
          run: () => recoverInboundReceipts({ db: env.DB, queue: env.OUTBOUND }),
        },
      ]),
    ];
    const due = new Date(controller.scheduledTime);
    if (due.getUTCMinutes() === 0) {
      runs.push(
        runMaintenanceTasks(
          env,
          requestId,
          [
            {
              name: 'inbound.receipts.expire',
              run: () => expireCompletedInboundReceipts(env.DB, new Date()),
            },
            {
              name: 'attachments.expire',
              run: async () => {
                const result = await expireAttachments(
                  {
                    db: env.DB,
                    cache: getAttachmentByteStore(env),
                    objectStore: getAttachmentObjectStore(env),
                    auditEventWriter: buildAppContext(env).auditEventWriter,
                  },
                  { requestId },
                );
                if (result.failed > 0) throw new Error('Attachment cleanup did not complete.');
              },
            },
            {
              name: 'editor-assets.expire',
              run: () => expireEditorAssets(env.DB, env.ATTACHMENTS),
            },
          ],
          'hourly',
        ),
      );
    }
    // Use the event's original time even when delivery is delayed.
    if (due.getUTCHours() === 19 && due.getUTCMinutes() === 0) {
      runs.push(
        runMaintenanceTasks(
          env,
          requestId,
          [
            {
              name: 'identity.expire',
              run: () => expireIdentityRecords(env.DB),
            },
            {
              name: 'editor-assets.sweep',
              run: () => sweepOrphanedEditorAssets(env.DB, env.ATTACHMENTS, env.CACHE),
            },
            {
              name: 'avatars.sweep',
              run: () => sweepPersonalAvatars(env.DB, env.ATTACHMENTS, env.CACHE),
            },
            {
              name: 'mail-objects.sweep',
              run: async () => {
                const result = await sweepOrphanedInboundObjects({
                  db: env.DB,
                  objectStore: env.ATTACHMENTS,
                  cursorStore: env.CACHE,
                });
                if (result.deleted > 0 || result.failed > 0)
                  logger.info({ event: 'inbound.r2_orphan_sweep', requestId }, { ...result });
                if (result.failed > 0) throw new Error('Inbound object sweep did not complete.');
              },
            },
          ],
          'daily',
        ),
      );
    }
    const results = await Promise.allSettled(runs);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Maintenance failed; inspect cadence heartbeats.');
  },
};
