// scheduled.worker.test.ts — CAP-028 cron entrypoint (AC7).
//
// Worker-pool test: invoking the scheduled handler drives the reclaim through
// the real D1 binding. The handler computes `new Date()` itself, so the seeds
// use real-clock-relative lease timestamps (past → expired, future → live).
//
// AC7: the entrypoint invokes the reclaim at the start of every cron tick and
// is safe under repeated ticks (no attempts++ on reclaim, no double reclaim).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
  resetAndMigrate,
  seedInstallationState,
  seedInboundMailbox,
  INBOUND_RAW_FIXTURE,
} from '@unimailbox/test-kit';
import scheduled from './scheduled';
import { maintenanceHealth } from '../platform/health';
import { OUTBOX_LEASE_TTL_MS } from '../platform/outbox-config';
import { buildAppContext } from '../app-context';
import { acceptInboundReceipt, processInboundReceipt } from '../modules/inbound-mail';

/** SQLite datetime literal offset from the real clock by `offsetMs`. */
function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

const EXPIRED_LEASE = at(-(OUTBOX_LEASE_TTL_MS + 120_000));
const LIVE_LEASE = at(OUTBOX_LEASE_TTL_MS * 2);

async function seedSendingJob(opts: {
  readonly attempts: number;
  readonly lockedAt: string;
  readonly lockedBy: string;
}): Promise<string> {
  const now = at(-3_600_000);
  const jobId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  await env.DB.batch([
    // Dummy ciphertext (blob lengths satisfy the 0001 CHECKs).
    env.DB.prepare(
      `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
       VALUES (?, ?, 1, x'00', x'000000000000000000000000', x'00000000000000000000000000000000', ?, ?)`,
    ).bind(credentialId, `seed-cred-${credentialId}`, now, now),
    env.DB.prepare(
      `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, created_at, updated_at)
       VALUES (?, 'brevo', 'Seed', ?, 'active', ?, ?)`,
    ).bind(connectionId, credentialId, now, now),
    env.DB.prepare(
      `INSERT INTO messages (id, from_address, subject, status, created_at, updated_at)
       VALUES (?, 'seed@example.com', 'seed', 'queued', ?, ?)`,
    ).bind(messageId, now, now),
    env.DB.prepare(
      `INSERT INTO outbound_jobs (id, message_id, provider_connection_id, status, attempts, max_attempts, locked_at, locked_by, created_at, updated_at)
       VALUES (?, ?, ?, 'sending', ?, 3, ?, ?, ?, ?)`,
    ).bind(jobId, messageId, connectionId, opts.attempts, opts.lockedAt, opts.lockedBy, now, now),
  ]);
  return jobId;
}

function fetchJob(jobId: string) {
  return env.DB.prepare(
    'SELECT status, attempts, locked_at, locked_by FROM outbound_jobs WHERE id = ?',
  )
    .bind(jobId)
    .first<{
      status: string;
      attempts: number;
      locked_at: string | null;
      locked_by: string | null;
    }>();
}

/** Minimal controller stub — the handler ignores it (void _controller). */
function controller(
  cron = '*/5 * * * *',
  scheduledTime = Date.UTC(2026, 9, 9, 12, 5),
): Parameters<typeof scheduled.scheduled>[0] {
  return {
    cron,
    scheduledTime,
    noRetry() {},
  } as unknown as Parameters<typeof scheduled.scheduled>[0];
}

function dailyController() {
  return controller('*/5 * * * *', Date.UTC(2026, 9, 9, 19, 0));
}

async function heartbeat(cadence: string) {
  const row = await env.DB.prepare(
    'SELECT completed_at FROM maintenance_heartbeats WHERE cadence=?',
  )
    .bind(cadence)
    .first<{ completed_at: string | null }>();
  if (!row?.completed_at) return null;
  const failures = await env.DB.prepare(
    'SELECT task_name FROM maintenance_heartbeat_failures WHERE cadence=?',
  )
    .bind(cadence)
    .all<{ task_name: string }>();
  return { failedTasks: failures.results.map((item) => item.task_name) };
}

describe('scheduled entrypoint (AC7 — reclaim wiring)', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('R-INBOUND-013 dispatches stalled accepted mail and keeps maintenance unhealthy until recovery completes', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const ctx = buildAppContext(env);
    const id = await acceptInboundReceipt(ctx, {
      mailboxId,
      from: 'sender@example.net',
      to: 'inbox@example.test',
      raw: new TextEncoder().encode(INBOUND_RAW_FIXTURE).buffer,
      requestId: crypto.randomUUID(),
    });
    await env.DB.prepare(
      "UPDATE inbound_receipts SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-16 minutes') WHERE id=?",
    )
      .bind(id)
      .run();
    const send = vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);
    await scheduled.scheduled(controller(), env);
    expect(send).toHaveBeenCalledWith({ kind: 'inbound', version: 1, receiptId: id });
    expect(await maintenanceHealth(env)).toBe(false);
    await processInboundReceipt(id, ctx);
    expect(await maintenanceHealth(env)).toBe(true);
  });

  it('reclaims an expired lease through the cron handler, with no attempts++, and re-enqueues it on the OUTBOUND queue (H2)', async () => {
    const jobId = await seedSendingJob({
      attempts: 1,
      lockedAt: EXPIRED_LEASE,
      lockedBy: 'crashed-worker',
    });
    const sendSpy = vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);

    await scheduled.scheduled(controller(), env);

    // The entrypoint passes the real binding through to the use case, which
    // re-drives each reclaimed ID in the exact body format the consumer parses.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(JSON.stringify({ jobId }));
    sendSpy.mockRestore();

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1); // reclaim never increments (R-OUTBOUND-007)
    expect(job?.locked_at).toBeNull();
    expect(job?.locked_by).toBeNull();
  });

  it('marks an exhausted expired lease failed through the cron handler and re-enqueues nothing', async () => {
    const jobId = await seedSendingJob({
      attempts: 3,
      lockedAt: EXPIRED_LEASE,
      lockedBy: 'crashed-worker',
    });
    const sendSpy = vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);

    await scheduled.scheduled(controller(), env);

    expect(sendSpy).not.toHaveBeenCalled(); // terminal rows are never re-driven
    sendSpy.mockRestore();

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('failed');
  });

  it('leaves a live lease alone and is safe under repeated ticks', async () => {
    const liveJobId = await seedSendingJob({
      attempts: 0,
      lockedAt: LIVE_LEASE,
      lockedBy: 'healthy-worker',
    });
    const expiredJobId = await seedSendingJob({
      attempts: 0,
      lockedAt: EXPIRED_LEASE,
      lockedBy: 'crashed-worker',
    });

    await scheduled.scheduled(controller(), env);
    await scheduled.scheduled(controller(), env); // second tick: idempotent

    const live = await fetchJob(liveJobId);
    expect(live?.status).toBe('sending');
    expect(live?.locked_by).toBe('healthy-worker');

    const expired = await fetchJob(expiredJobId);
    expect(expired?.status).toBe('queued');
    expect(expired?.attempts).toBe(0); // two ticks, still no increment
  });

  it('keeps a stalled delivery unhealthy when recovery refreshes its retry timestamp', async () => {
    await seedSendingJob({ attempts: 0, lockedAt: EXPIRED_LEASE, lockedBy: 'crashed' });
    vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);
    await scheduled.scheduled(controller(), env);
    expect(await maintenanceHealth(env)).toBe(false);
  });

  it('ignores waiting schedules in stalled-delivery monitoring but catches overdue schedules', async () => {
    const id = await seedSendingJob({ attempts: 0, lockedAt: EXPIRED_LEASE, lockedBy: 'crashed' });
    await env.DB.prepare(
      "UPDATE outbound_jobs SET status='queued',scheduled_at=datetime('now','+1 day') WHERE id=?",
    )
      .bind(id)
      .run();
    vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);
    await scheduled.scheduled(controller(), env);
    expect(await maintenanceHealth(env)).toBe(true);
    await env.DB.prepare(
      "UPDATE outbound_jobs SET scheduled_at=datetime('now','-20 minutes') WHERE id=?",
    )
      .bind(id)
      .run();
    expect(await maintenanceHealth(env)).toBe(false);
  });

  it('is a clean no-op on an empty outbox', async () => {
    await expect(scheduled.scheduled(controller(), env)).resolves.toBeUndefined();
  });

  it('keeps upload expiry hourly and preserves its failed heartbeat after frequent success', async () => {
    await env.DB.prepare('DROP TABLE editor_asset_usages').run();
    await expect(scheduled.scheduled(controller(), env)).resolves.toBeUndefined();
    expect(await heartbeat('hourly')).toBeNull();
    await expect(
      scheduled.scheduled(controller('*/5 * * * *', Date.UTC(2026, 9, 9, 12, 0)), env),
    ).rejects.toThrow('Maintenance failed');
    expect(await heartbeat('hourly')).toMatchObject({
      failedTasks: ['editor-assets.expire'],
    });
    await scheduled.scheduled(controller(), env);
    expect(await heartbeat('hourly')).toMatchObject({
      failedTasks: ['editor-assets.expire'],
    });
  });

  it('keeps frequent expiry/reclaim and health free of all KV operations after handover', async () => {
    // Spies observe real binding calls; no return values or storage are replaced.
    const get = vi.spyOn(env.CACHE, 'get');
    const remove = vi.spyOn(env.CACHE, 'delete');
    const list = vi.spyOn(env.ATTACHMENTS, 'list');
    const put = vi.spyOn(env.CACHE, 'put');
    await env.DB.prepare('UPDATE maintenance_heartbeats SET legacy_imported=1').run();
    await scheduled.scheduled(controller(), env);
    expect(await maintenanceHealth(env)).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(await heartbeat('frequent')).toMatchObject({ failedTasks: [] });
  });

  it('keeps empty hourly cleanup and health free of KV after handover', async () => {
    await env.DB.prepare('UPDATE maintenance_heartbeats SET legacy_imported=1').run();
    const get = vi.spyOn(env.CACHE, 'get');
    const put = vi.spyOn(env.CACHE, 'put');
    const remove = vi.spyOn(env.CACHE, 'delete');
    const list = vi.spyOn(env.CACHE, 'list');
    await scheduled.scheduled(controller('*/5 * * * *', Date.UTC(2026, 9, 9, 12, 0)), env);
    expect(await maintenanceHealth(env)).toBe(true);
    for (const operation of [get, put, remove, list]) expect(operation).not.toHaveBeenCalled();
  });

  it('runs five daily cursor reads with no empty deletes and an independent heartbeat', async () => {
    const get = vi.spyOn(env.CACHE, 'get');
    const remove = vi.spyOn(env.CACHE, 'delete');
    await scheduled.scheduled(dailyController(), env);
    expect(get).toHaveBeenCalledTimes(5);
    expect(remove).not.toHaveBeenCalled();
    expect(await heartbeat('daily')).toMatchObject({
      failedTasks: [],
    });
    expect(await heartbeat('frequent')).toMatchObject({ failedTasks: [] });
  });

  it('persists daily pagination across invocations and removes only existing finished cursors', async () => {
    for (const prefix of ['user-avatars/', 'editor-assets/']) {
      for (let index = 0; index < 101; index++) {
        await env.ATTACHMENTS.put(`${prefix}${String(index).padStart(3, '0')}`, 'recent');
      }
    }
    await scheduled.scheduled(dailyController(), env);
    expect(await env.CACHE.get('avatar-sweep-cursor')).not.toBeNull();
    expect(await env.CACHE.get('editor-assets:orphan-cursor')).not.toBeNull();
    const remove = vi.spyOn(env.CACHE, 'delete');
    await scheduled.scheduled(dailyController(), env);
    expect(remove.mock.calls).toEqual([['editor-assets:orphan-cursor'], ['avatar-sweep-cursor']]);
    expect(await env.CACHE.get('avatar-sweep-cursor')).toBeNull();
    expect(await env.CACHE.get('editor-assets:orphan-cursor')).toBeNull();
    // Grace periods protect uploads created during an in-flight publication.
    expect((await env.ATTACHMENTS.list({ prefix: 'user-avatars/' })).objects).toHaveLength(101);
    expect((await env.ATTACHMENTS.list({ prefix: 'editor-assets/' })).objects).toHaveLength(101);
  });

  it('rejects an unconfigured schedule without running maintenance', async () => {
    await expect(scheduled.scheduled(controller('* * * * *'), env)).rejects.toThrow('Unknown');
    expect(await heartbeat('frequent')).toBeNull();
  });

  it('skips daily scans on the ticks immediately before and after 19:00 UTC', async () => {
    const get = vi.spyOn(env.CACHE, 'get');
    for (const time of [Date.UTC(2026, 9, 9, 18, 55), Date.UTC(2026, 9, 9, 19, 5)]) {
      await scheduled.scheduled(controller('*/5 * * * *', time), env);
    }
    expect(get).not.toHaveBeenCalled();
    expect(await heartbeat('daily')).toBeNull();
  });

  it('still runs daily scans when frequent outbox recovery fails', async () => {
    await env.DB.prepare('DROP TABLE outbound_jobs').run();
    await expect(scheduled.scheduled(dailyController(), env)).rejects.toThrow('Maintenance failed');
    expect(await heartbeat('frequent')).toMatchObject({
      failedTasks: ['outbound.reclaim'],
    });
    expect(await heartbeat('daily')).toMatchObject({
      failedTasks: [],
    });
  });
});
