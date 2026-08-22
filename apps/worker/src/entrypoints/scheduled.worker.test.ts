// scheduled.worker.test.ts — CAP-028 cron entrypoint (AC7).
//
// Worker-pool test: invoking the scheduled handler drives the reclaim through
// the real D1 binding. The handler computes `new Date()` itself, so the seeds
// use real-clock-relative lease timestamps (past → expired, future → live).
//
// AC7: the entrypoint invokes the reclaim at the start of every cron tick and
// is safe under repeated ticks (no attempts++ on reclaim, no double reclaim).

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import scheduled from './scheduled';
import { OUTBOX_LEASE_TTL_MS } from '../platform/outbox-config';

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
function controller(): Parameters<typeof scheduled.scheduled>[0] {
  return {
    cron: '*/2 * * * *',
    scheduledTime: Date.now(),
    noRetry() {},
  } as unknown as Parameters<typeof scheduled.scheduled>[0];
}

describe('scheduled entrypoint (AC7 — reclaim wiring)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
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

  it('is a clean no-op on an empty outbox', async () => {
    await expect(scheduled.scheduled(controller(), env)).resolves.toBeUndefined();
  });
});
