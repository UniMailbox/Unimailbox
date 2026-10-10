// reclaim-stale-jobs.worker.test.ts — CAP-028 scheduled dispatcher (AC6).
//
// Worker-pool tests against real D1 for `reclaimStaleJobs` (the thin wrapper
// around `reclaimStaleOutboundJobs` the cron entrypoint calls). Deterministic:
// every scenario passes a fixed `now` and seeds `locked_at` literals around
// the derived lease cutoff (.claude/rules/testing.md §Determinism — no
// sleeps, no Date.now-dependent assertions inside the reclaim).
//
// Rule IDs: R-OUTBOUND-007 (lease reclaim, no attempts++ on reclaim),
// R-OUTBOUND-008 (terminal once attempts exhausted), R-OUTBOUND-009
// (terminal rows untouched).

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { reclaimStaleJobs, type OutboundJobEnqueuer } from './reclaim-stale-jobs';
import { OUTBOX_LEASE_TTL_MS, OUTBOUND_ORPHAN_SWEEP_AFTER_MS } from '../../platform/outbox-config';

// Fixed clock. The reclaim treats `now` as authoritative, so seeded lease
// literals are stable regardless of wall-clock time.
const NOW = new Date('2025-01-01T12:00:00Z');

/** SQLite datetime literals relative to NOW. */
function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

const EXPIRED_LEASE = at(-OUTBOX_LEASE_TTL_MS - 60_000); // cutoff - 1 min
const LIVE_LEASE = at(OUTBOX_LEASE_TTL_MS); // well past the cutoff

interface SeedOptions {
  readonly status: 'queued' | 'sending' | 'sent' | 'failed';
  readonly attempts?: number;
  readonly lockedAt?: string | null;
  readonly lockedBy?: string | null;
  /**
   * `updated_at` for the outbound_jobs row. Defaults to 11:00 — one hour
   * before NOW, i.e. older than the orphan-sweep threshold. Tests that seed
   * a `queued` row and expect the sweep to leave it alone must pass a fresh
   * literal.
   */
  readonly updatedAt?: string;
}

/** Seeds one FK-satisfying job row; the reclaim never reads message/credential. */
async function seedJob(opts: SeedOptions): Promise<string> {
  const now = '2025-01-01 11:00:00';
  const jobId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  await env.DB.batch([
    // Dummy ciphertext (blob lengths satisfy the 0001 CHECKs); the reclaim
    // never reads the credential.
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
       VALUES (?, ?, ?, ?, ?, 3, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      messageId,
      connectionId,
      opts.status,
      opts.attempts ?? 0,
      opts.lockedAt ?? null,
      opts.lockedBy ?? null,
      now,
      opts.updatedAt ?? now,
    ),
  ]);
  return jobId;
}

function fetchJob(jobId: string) {
  return env.DB.prepare(
    'SELECT status, attempts, error_code, error_message, locked_at, locked_by FROM outbound_jobs WHERE id = ?',
  )
    .bind(jobId)
    .first<{
      status: string;
      attempts: number;
      error_code: string | null;
      error_message: string | null;
      locked_at: string | null;
      locked_by: string | null;
    }>();
}

describe('reclaimStaleJobs (AC6 — R-OUTBOUND-007/008/009)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  /** Recording enqueuer — captures bodies in the exact producer format. */
  function recordingEnqueuer(): OutboundJobEnqueuer & { bodies: string[] } {
    const bodies: string[] = [];
    const enqueuer: OutboundJobEnqueuer = {
      async send(body: string): Promise<void> {
        bodies.push(body);
      },
    };
    return Object.assign(enqueuer, { bodies });
  }

  it('re-queues an expired lease with attempts unchanged and clears the lock, and re-enqueues it exactly once', async () => {
    const jobId = await seedJob({
      status: 'sending',
      attempts: 1,
      lockedAt: EXPIRED_LEASE,
      lockedBy: 'crashed-worker',
    });
    const outbound = recordingEnqueuer();

    const result = await reclaimStaleJobs(env.DB, NOW, outbound);

    expect(result.reclaimed).toBe(1);
    expect(result.terminal).toBe(0);
    expect(result.reclaimedIds).toEqual([jobId]);
    // H2: one send per reclaimed ID, in the body format the consumer parses.
    expect(outbound.bodies).toEqual([JSON.stringify({ jobId })]);
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1); // R-OUTBOUND-007: reclaim never increments
    expect(job?.locked_at).toBeNull();
    expect(job?.locked_by).toBeNull();
  });

  it('marks an expired lease failed when attempts are exhausted (R-OUTBOUND-008) and does NOT re-enqueue a terminal row', async () => {
    const jobId = await seedJob({
      status: 'sending',
      attempts: 3,
      lockedAt: EXPIRED_LEASE,
      lockedBy: 'crashed-worker',
    });
    const outbound = recordingEnqueuer();

    const result = await reclaimStaleJobs(env.DB, NOW, outbound);

    expect(result.reclaimed).toBe(0);
    expect(result.terminal).toBe(1);
    expect(result.reclaimedIds).toEqual([]);
    expect(outbound.bodies).toEqual([]); // terminal rows are never re-driven
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error_code).toBe('RECLAIM_EXHAUSTED');
    expect(job?.attempts).toBe(3); // terminal reclaim never increments
    expect(job?.locked_at).toBeNull();
    expect(job?.locked_by).toBeNull();
  });

  it('leaves a live lease untouched (R-OUTBOUND-007) and sends nothing', async () => {
    const jobId = await seedJob({
      status: 'sending',
      attempts: 1,
      lockedAt: LIVE_LEASE,
      lockedBy: 'healthy-worker',
    });
    const outbound = recordingEnqueuer();

    const result = await reclaimStaleJobs(env.DB, NOW, outbound);

    expect(result.reclaimed).toBe(0);
    expect(result.terminal).toBe(0);
    expect(result.reclaimedIds).toEqual([]);
    expect(outbound.bodies).toEqual([]);
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('sending');
    expect(job?.locked_by).toBe('healthy-worker');
    expect(job?.locked_at).toBe(LIVE_LEASE);
  });

  it('leaves terminal rows untouched (R-OUTBOUND-009) and fresh queued rows alone', async () => {
    const sentJobId = await seedJob({ status: 'sent', attempts: 0 });
    const failedJobId = await seedJob({ status: 'failed', attempts: 3 });
    // Fresh queued row — its enqueue has not had time to be "lost", so the
    // orphan sweep must not touch it (sweep tests below pin the old-row side).
    const queuedJobId = await seedJob({ status: 'queued', attempts: 0, updatedAt: at(-60_000) });
    const outbound = recordingEnqueuer();

    const result = await reclaimStaleJobs(env.DB, NOW, outbound);

    expect(result.reclaimed).toBe(0);
    expect(result.terminal).toBe(0);
    expect(result.reclaimedIds).toEqual([]);
    expect(outbound.bodies).toEqual([]);
    expect((await fetchJob(sentJobId))?.status).toBe('sent');
    expect((await fetchJob(failedJobId))?.status).toBe('failed');
    expect((await fetchJob(queuedJobId))?.status).toBe('queued');
  });

  it('is idempotent under repeated cron ticks — a reclaimed row is not reclaimed twice (AC7 precondition)', async () => {
    await seedJob({
      status: 'sending',
      attempts: 1,
      lockedAt: EXPIRED_LEASE,
      lockedBy: 'crashed-worker',
    });
    const firstOutbound = recordingEnqueuer();
    const secondOutbound = recordingEnqueuer();

    const first = await reclaimStaleJobs(env.DB, NOW, firstOutbound);
    const second = await reclaimStaleJobs(env.DB, NOW, secondOutbound);

    expect(first.reclaimed).toBe(1);
    expect(firstOutbound.bodies).toHaveLength(1);
    expect(second.reclaimed).toBe(0);
    expect(secondOutbound.bodies).toHaveLength(0); // no duplicate re-drive
  });

  it('reports both counts when a mixed batch is recovered and re-enqueues only the reclaimable rows', async () => {
    const a = await seedJob({
      status: 'sending',
      attempts: 0,
      lockedAt: EXPIRED_LEASE,
      lockedBy: 'w1',
    });
    const b = await seedJob({
      status: 'sending',
      attempts: 1,
      lockedAt: EXPIRED_LEASE,
      lockedBy: 'w2',
    });
    await seedJob({ status: 'sending', attempts: 3, lockedAt: EXPIRED_LEASE, lockedBy: 'w3' });
    const outbound = recordingEnqueuer();

    const result = await reclaimStaleJobs(env.DB, NOW, outbound);

    expect(result.reclaimed).toBe(2);
    expect(result.terminal).toBe(1);
    expect(result.reclaimedIds).toHaveLength(2);
    expect(outbound.bodies).toHaveLength(2);
    for (const id of [a, b]) {
      expect(outbound.bodies).toContain(JSON.stringify({ jobId: id }));
    }
  });

  describe('orphan sweep (CAP-028 F1 — lost-enqueue recovery)', () => {
    it('reserves a bounded retry window, including failed enqueue and concurrent ticks', async () => {
      const jobId = await seedJob({ status: 'queued', updatedAt: at(-600_000) });
      const outbound = recordingEnqueuer();
      await Promise.all([
        reclaimStaleJobs(env.DB, NOW, outbound),
        reclaimStaleJobs(env.DB, NOW, outbound),
      ]);
      expect(outbound.bodies).toEqual([JSON.stringify({ jobId })]);
      await reclaimStaleJobs(env.DB, new Date(NOW.getTime() + 240_000), outbound);
      expect(outbound.bodies).toHaveLength(1);
      await expect(
        reclaimStaleJobs(env.DB, new Date(NOW.getTime() + 360_000), {
          async send() {
            throw new Error('unavailable');
          },
        }),
      ).resolves.toBeDefined();
      await reclaimStaleJobs(env.DB, new Date(NOW.getTime() + 360_000), outbound);
      expect(outbound.bodies).toHaveLength(1);
      await reclaimStaleJobs(env.DB, new Date(NOW.getTime() + 720_000), outbound);
      expect(outbound.bodies).toHaveLength(2);
      expect((await fetchJob(jobId))?.attempts).toBe(0);
    });

    it('bounds each sending-reclaim and queued-orphan batch to 100 jobs', async () => {
      const reference = await seedJob({ status: 'sent' });
      const row = await env.DB.prepare(
        'SELECT message_id,provider_connection_id FROM outbound_jobs WHERE id=?',
      )
        .bind(reference)
        .first<{ message_id: string; provider_connection_id: string }>();
      if (!row) throw new Error('Missing seeded outbound job');
      for (const status of ['sending', 'queued']) {
        await env.DB.prepare(
          `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<101)
          INSERT INTO outbound_jobs (id,message_id,provider_connection_id,status,attempts,max_attempts,locked_at,locked_by,created_at,updated_at)
          SELECT ?||v,?,?,?,0,3,?,'crashed','2025-01-01 11:00:00','2025-01-01 11:00:00' FROM n`,
        )
          .bind(status, row.message_id, row.provider_connection_id, status, EXPIRED_LEASE)
          .run();
      }
      const outbound = recordingEnqueuer();
      const result = await reclaimStaleJobs(env.DB, NOW, outbound);
      expect(result.reclaimed).toBe(100);
      expect(outbound.bodies).toHaveLength(200);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS count FROM outbound_jobs WHERE status='sending'",
        ).first('count'),
      ).toBe(1);
    });

    it('re-enqueues a queued row whose updated_at is older than the sweep threshold', async () => {
      // 11:54 — one minute past the 5-minute sweep cutoff (11:55).
      const jobId = await seedJob({
        status: 'queued',
        attempts: 0,
        updatedAt: at(-OUTBOUND_ORPHAN_SWEEP_AFTER_MS - 60_000),
      });
      const outbound = recordingEnqueuer();

      const result = await reclaimStaleJobs(env.DB, NOW, outbound);

      // The reclaim pass found nothing (no sending rows) — the send below came
      // from the sweep, in exactly the body format the consumer parses.
      expect(result.reclaimed).toBe(0);
      expect(result.terminal).toBe(0);
      expect(outbound.bodies).toEqual([JSON.stringify({ jobId })]);
      // The sweep reserves a retry window without consuming a send attempt.
      const job = await fetchJob(jobId);
      expect(job?.status).toBe('queued');
      expect(job?.attempts).toBe(0);
      expect(job?.locked_by).toBeNull();
    });

    it('sweeps on a later tick after a reclaim re-enqueue failed, and logs a warn without the job ID', async () => {
      // Tick 1: the reclaim pulls an expired lease back to queued, but the
      // queue send fails — the row is orphaned in queued (the F1 scenario).
      const jobId = await seedJob({
        status: 'sending',
        attempts: 1,
        lockedAt: EXPIRED_LEASE,
        lockedBy: 'crashed-worker',
      });
      const failingOutbound: OutboundJobEnqueuer = {
        async send(): Promise<void> {
          throw new Error('queue unavailable');
        },
      };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await reclaimStaleJobs(env.DB, NOW, failingOutbound);

      // Tick 2 (same fixed `now`): the reclaim rewrote updated_at with the
      // real clock, so backdate it explicitly to model "queued for 5+
      // minutes" deterministically — that is exactly the state the sweep
      // exists for.
      warnSpy.mockRestore();
      await env.DB.prepare('UPDATE outbound_jobs SET updated_at = ? WHERE id = ?')
        .bind(at(-OUTBOUND_ORPHAN_SWEEP_AFTER_MS - 60_000), jobId)
        .run();
      const sweepOutbound = recordingEnqueuer();
      const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await reclaimStaleJobs(env.DB, NOW, sweepOutbound);

      warnSpy2.mockRestore();
      expect(result.reclaimed).toBe(0);
      expect(sweepOutbound.bodies).toEqual([JSON.stringify({ jobId })]);
    });
  });

  it('H2: a failed queue send logs a warn WITHOUT the job ID and does not abort the remaining re-enqueues', async () => {
    await seedJob({ status: 'sending', attempts: 0, lockedAt: EXPIRED_LEASE, lockedBy: 'w1' });
    await seedJob({ status: 'sending', attempts: 1, lockedAt: EXPIRED_LEASE, lockedBy: 'w2' });
    const attempted: string[] = [];
    const outbound: OutboundJobEnqueuer = {
      async send(body: string): Promise<void> {
        attempted.push(body);
        if (attempted.length === 1) {
          throw new Error('queue unavailable');
        }
      },
    };
    // The setup file's console spy lives in the node context; re-spy here so
    // mock.calls is inspectable inside workerd.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await reclaimStaleJobs(env.DB, NOW, outbound);

    // Both rows were reclaimed in D1 and both sends were attempted — the
    // first failure did not abort the second re-enqueue.
    expect(result.reclaimed).toBe(2);
    expect(attempted).toHaveLength(2);

    const warnCalls = warnSpy.mock.calls;
    warnSpy.mockRestore();
    const reenqueueWarnings = warnCalls.filter((args) =>
      String(args[0]).includes('outbound.reclaim_reenqueue_failed'),
    );
    expect(reenqueueWarnings).toHaveLength(1);
    const line = JSON.parse(String(reenqueueWarnings[0]?.[0])) as Record<string, unknown>;
    // R-LOG-001: the warn must not carry the job ID.
    expect(line.jobId).toBeUndefined();
    expect(String(line.error)).toBe('QUEUE_ENQUEUE_FAILED');
  });
});
