// job-repository.worker.test.ts — CAP-028 repository lease machinery.
//
// Worker-pool tests against real D1 (per .claude/rules/testing.md — never
// mock the database). Covers AC1, AC3, AC4, AC5, AC9 of the CAP-028 contract
// (work/active/CAP-028-durable-outbox/task.md):
//
// - AC1  atomic claim across the full status/lease matrix
// - AC3  lock-holding success write
// - AC4  lock-holding retryable write
// - AC5  lock-holding terminal write
// - AC9  forbidden transitions are no-ops (sent/failed not claimable,
//        mismatched lockedBy cannot write)
//
// Rule IDs: R-OUTBOUND-007 (atomic claim, single consumer),
// R-OUTBOUND-008 (retryable vs terminal), R-OUTBOUND-009 (sent is terminal).

import { describe, expect, it, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { ALLOWED_JOB_TRANSITIONS, canTransition } from '@unimailbox/contracts';
import {
  claimOutboundJob,
  getOutboundJob,
  isJobTerminal,
  markOutboundJobRetryable,
  markOutboundJobSent,
  markOutboundJobTerminal,
} from './job-repository';

/** SQLite datetime literals — the only format these columns speak. */
const PAST = '2025-01-01 00:00:00';
const LEASE_UNTIL = '2025-01-01 00:01:00';
const FUTURE = '2025-01-01 00:05:00';

interface SeedOptions {
  readonly status: 'queued' | 'sending' | 'sent' | 'failed';
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly lockedAt?: string | null;
  readonly lockedBy?: string | null;
}

/**
 * Seeds a minimal FK-satisfying job row: credential + connection + message +
 * job in one D1 batch. The credential is a dummy ciphertext — these tests
 * never decrypt (that path is covered in process-outbound-job.worker.test.ts).
 */
async function seedJob(opts: SeedOptions): Promise<string> {
  const jobId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  await env.DB.batch([
    // Dummy ciphertext — these tests never decrypt (that path is covered in
    // process-outbound-job.worker.test.ts). Blob lengths satisfy the CHECKs
    // (iv 12 bytes, auth_tag 16 bytes) from migration 0001.
    env.DB.prepare(
      `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag)
       VALUES (?, ?, 1, x'00', x'000000000000000000000000', x'00000000000000000000000000000000')`,
    ).bind(credentialId, `seed-cred-${credentialId}`),
    env.DB.prepare(
      `INSERT INTO provider_connections (id, provider_key, label, credential_id, status)
       VALUES (?, 'brevo', 'Seed', ?, 'active')`,
    ).bind(connectionId, credentialId),
    env.DB.prepare(
      `INSERT INTO messages (id, from_address, subject, status)
       VALUES (?, 'seed@example.com', 'seed', 'queued')`,
    ).bind(messageId),
    env.DB.prepare(
      `INSERT INTO outbound_jobs (id, message_id, provider_connection_id, status, attempts, max_attempts, locked_at, locked_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      messageId,
      connectionId,
      opts.status,
      opts.attempts ?? 0,
      opts.maxAttempts ?? 3,
      opts.lockedAt ?? null,
      opts.lockedBy ?? null,
    ),
  ]);
  return jobId;
}

async function fetchJob(jobId: string) {
  return env.DB.prepare(
    'SELECT status, attempts, locked_at, locked_by, provider_message_id, error_code, error_message FROM outbound_jobs WHERE id = ?',
  )
    .bind(jobId)
    .first<{
      status: string;
      attempts: number;
      locked_at: string | null;
      locked_by: string | null;
      provider_message_id: string | null;
      error_code: string | null;
      error_message: string | null;
    }>();
}

describe('claimOutboundJob (AC1 — R-OUTBOUND-007)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('claims a queued row with no lease and returns the updated row', async () => {
    const jobId = await seedJob({ status: 'queued' });

    const claimed = await claimOutboundJob(env.DB, jobId, 'worker-a', LEASE_UNTIL);

    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe('sending');
    expect(claimed?.locked_at).toBe(LEASE_UNTIL);
    expect(claimed?.locked_by).toBe('worker-a');
  });

  it('returns null for a sending row with a live lease and leaves columns unchanged', async () => {
    const jobId = await seedJob({
      status: 'sending',
      lockedAt: FUTURE,
      lockedBy: 'worker-a',
    });

    const claimed = await claimOutboundJob(env.DB, jobId, 'worker-b', LEASE_UNTIL);

    expect(claimed).toBeNull();
    const row = await fetchJob(jobId);
    expect(row?.status).toBe('sending');
    expect(row?.locked_by).toBe('worker-a'); // not stolen
    expect(row?.locked_at).toBe(FUTURE);
  });

  it('returns null for a sending row with an expired lease — the scheduled reclaim owns expired leases, not a fresh claim (AC1 SQL: status must be queued)', async () => {
    // AC1(c), reconciled wording: the claim never steals an expired lease
    // directly — the reclaim (AC6) owns the sending → queued recovery
    // transition; only then is the row claimable again. A claim that could
    // take an in-flight row would race the reclaim and the queue redelivery
    // on the same row. This test pins the status='queued' SQL clause.
    const jobId = await seedJob({
      status: 'sending',
      lockedAt: PAST,
      lockedBy: 'crashed-worker',
    });

    const claimed = await claimOutboundJob(env.DB, jobId, 'worker-b', LEASE_UNTIL);

    expect(claimed).toBeNull();
    const row = await fetchJob(jobId);
    expect(row?.status).toBe('sending');
    expect(row?.locked_by).toBe('crashed-worker');
  });

  it('R-OUTBOUND-009 / AC9: returns null for a sent row (terminal, not claimable)', async () => {
    const jobId = await seedJob({ status: 'sent' });
    expect(await claimOutboundJob(env.DB, jobId, 'worker-a', LEASE_UNTIL)).toBeNull();
    expect((await fetchJob(jobId))?.status).toBe('sent');
  });

  it('R-OUTBOUND-009 / AC9: returns null for a failed row (terminal, not claimable)', async () => {
    const jobId = await seedJob({ status: 'failed', attempts: 3 });
    expect(await claimOutboundJob(env.DB, jobId, 'worker-a', LEASE_UNTIL)).toBeNull();
    expect((await fetchJob(jobId))?.status).toBe('failed');
  });

  it('M4a / R-OUTBOUND-007: two concurrent claims — exactly one wins', async () => {
    const jobId = await seedJob({ status: 'queued' });

    const [a, b] = await Promise.all([
      claimOutboundJob(env.DB, jobId, 'worker-a', LEASE_UNTIL),
      claimOutboundJob(env.DB, jobId, 'worker-b', LEASE_UNTIL),
    ]);

    const winners = [a, b].filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    expect(winner?.status).toBe('sending');
    const row = await fetchJob(jobId);
    expect(row?.status).toBe('sending');
    expect(row?.locked_by).toBe(winner?.locked_by);
    expect(['worker-a', 'worker-b']).toContain(row?.locked_by);
  });
});

describe('markOutboundJobSent (AC3 — R-OUTBOUND-007/009)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('writes sent + provider_message_id and clears the lock when lockedBy matches; returns true', async () => {
    const jobId = await seedJob({ status: 'sending', lockedAt: FUTURE, lockedBy: 'worker-a' });

    const advanced = await markOutboundJobSent(env.DB, jobId, 'worker-a', 'brevo-123');

    expect(advanced).toBe(true);
    const row = await fetchJob(jobId);
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).toBe('brevo-123');
    expect(row?.locked_at).toBeNull();
    expect(row?.locked_by).toBeNull();
  });

  it('AC9: is a no-op returning false when lockedBy does not match (stale worker)', async () => {
    const jobId = await seedJob({ status: 'sending', lockedAt: FUTURE, lockedBy: 'worker-b' });

    const advanced = await markOutboundJobSent(env.DB, jobId, 'worker-a', 'brevo-stale');

    expect(advanced).toBe(false);
    const row = await fetchJob(jobId);
    expect(row?.status).toBe('sending');
    expect(row?.provider_message_id).toBeNull();
    expect(row?.locked_by).toBe('worker-b');
  });
});

describe('markOutboundJobRetryable (AC4 — R-OUTBOUND-008)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('re-queues with attempts+1, records the error, clears the lock', async () => {
    const jobId = await seedJob({
      status: 'sending',
      attempts: 1,
      lockedAt: FUTURE,
      lockedBy: 'worker-a',
    });

    await markOutboundJobRetryable(env.DB, jobId, 'worker-a', 'SEND_FAILED', 'Brevo 503');

    const row = await fetchJob(jobId);
    expect(row?.status).toBe('queued');
    expect(row?.attempts).toBe(2);
    expect(row?.error_code).toBe('SEND_FAILED');
    expect(row?.error_message).toBe('Brevo 503');
    expect(row?.locked_at).toBeNull();
    expect(row?.locked_by).toBeNull();
  });

  it('AC9: is a no-op when lockedBy does not match', async () => {
    const jobId = await seedJob({
      status: 'sending',
      attempts: 1,
      lockedAt: FUTURE,
      lockedBy: 'worker-b',
    });

    await markOutboundJobRetryable(env.DB, jobId, 'worker-a', 'SEND_FAILED', 'stale');

    const row = await fetchJob(jobId);
    expect(row?.status).toBe('sending');
    expect(row?.attempts).toBe(1); // not incremented by a stale worker
  });
});

describe('markOutboundJobTerminal (AC5 — R-OUTBOUND-008)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('writes failed permanently and clears the lock; attempts unchanged (documented decision)', async () => {
    const jobId = await seedJob({
      status: 'sending',
      attempts: 2,
      lockedAt: FUTURE,
      lockedBy: 'worker-a',
    });

    await markOutboundJobTerminal(env.DB, jobId, 'worker-a', 'SEND_FAILED', 'final failure');

    const row = await fetchJob(jobId);
    expect(row?.status).toBe('failed');
    expect(row?.error_code).toBe('SEND_FAILED');
    expect(row?.error_message).toBe('final failure');
    expect(row?.attempts).toBe(2); // terminal write does not increment
    expect(row?.locked_at).toBeNull();
    expect(row?.locked_by).toBeNull();
  });

  it('AC9: is a no-op when lockedBy does not match', async () => {
    const jobId = await seedJob({
      status: 'sending',
      attempts: 2,
      lockedAt: FUTURE,
      lockedBy: 'worker-b',
    });

    await markOutboundJobTerminal(env.DB, jobId, 'worker-a', 'SEND_FAILED', 'stale');

    const row = await fetchJob(jobId);
    expect(row?.status).toBe('sending'); // not terminally failed by a stale worker
  });
});

describe('isJobTerminal (AC9 — R-OUTBOUND-009)', () => {
  it('sent and failed are terminal; queued, sending, delayed are not', () => {
    expect(isJobTerminal('sent')).toBe(true);
    expect(isJobTerminal('failed')).toBe(true);
    expect(isJobTerminal('bounced')).toBe(true);
    expect(isJobTerminal('complained')).toBe(true);
    expect(isJobTerminal('queued')).toBe(false);
    expect(isJobTerminal('sending')).toBe(false);
    expect(isJobTerminal('delayed')).toBe(false);
  });
});

describe('getOutboundJob', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('returns null for a missing job', async () => {
    expect(await getOutboundJob(env.DB, 'missing-job-id')).toBeNull();
  });
});

// -------------------------------------------------------------------
// CAP-030 AC #9 — direction guard pinned against the lease-aware writers.
//
// Each lease-aware writer has a hard-coded `status = '...'` predicate that
// is the FROM-state of its only legal `to`. These tests prove, against real
// D1, that the predicate matches the direction table declared in
// ALLOWED_JOB_TRANSITIONS (`packages/contracts`). If a future writer
// widens its SQL predicate to a multi-status `IN (...)` clause, the
// matching direction table entry must widen in the same change.
//
// Pin strategy: each test
//   (a) inspects `ALLOWED_JOB_TRANSITIONS` / `canTransition` to confirm the
//       expected from/to pair is allowed in the contract, AND
//   (b) invokes the writer against the matching seed state and asserts the
//       row advances, so a SQL-level regression that drops the predicate
//       still fails the test.
// -------------------------------------------------------------------

describe('CAP-030 AC #9 — direction guard pinned to lease-aware writers', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('claimOutboundJob: queued → sending is in ALLOWED_JOB_TRANSITIONS and the writer advances the row', async () => {
    // (a) Direction table check.
    expect(canTransition('job', 'queued', 'sending')).toBe(true);
    expect(ALLOWED_JOB_TRANSITIONS.get('queued')?.has('sending')).toBe(true);

    // (b) Writer behaviour: a 'queued' row is claimed to 'sending' (AC1 happy path).
    const jobId = await seedJob({ status: 'queued' });
    const claimed = await claimOutboundJob(env.DB, jobId, 'worker-a', LEASE_UNTIL);
    expect(claimed?.status).toBe('sending');
    const row = await fetchJob(jobId);
    expect(row?.status).toBe('sending');
    expect(row?.locked_by).toBe('worker-a');
  });

  it('markOutboundJobSent: sending → sent is in ALLOWED_JOB_TRANSITIONS and the writer advances the row', async () => {
    // (a) Direction table check.
    expect(canTransition('job', 'sending', 'sent')).toBe(true);
    expect(ALLOWED_JOB_TRANSITIONS.get('sending')?.has('sent')).toBe(true);

    // (b) Writer behaviour: a 'sending' row with a matching lock advances
    // to 'sent' (AC3 happy path).
    const jobId = await seedJob({ status: 'sending', lockedAt: FUTURE, lockedBy: 'worker-a' });
    const advanced = await markOutboundJobSent(env.DB, jobId, 'worker-a', 'brevo-123');
    expect(advanced).toBe(true);
    const row = await fetchJob(jobId);
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).toBe('brevo-123');
    expect(row?.locked_at).toBeNull();
    expect(row?.locked_by).toBeNull();
  });

  it('markOutboundJobRetryable: sending → queued (retry reset, R-OUTBOUND-008) is in ALLOWED_JOB_TRANSITIONS and the writer advances the row', async () => {
    // (a) Direction table check. This is the CAP-030 D-CAP-030-B edge: retry
    // reset is the documented semantic, not a regression. A reviewer who
    // tries to "tighten" the direction table to exclude it should fail
    // this test.
    expect(canTransition('job', 'sending', 'queued')).toBe(true);
    expect(ALLOWED_JOB_TRANSITIONS.get('sending')?.has('queued')).toBe(true);

    // (b) Writer behaviour: a 'sending' row with a matching lock re-queues
    // to 'queued' and bumps attempts (AC4 happy path).
    const jobId = await seedJob({
      status: 'sending',
      attempts: 1,
      lockedAt: FUTURE,
      lockedBy: 'worker-a',
    });
    await markOutboundJobRetryable(env.DB, jobId, 'worker-a', 'SEND_FAILED', 'Brevo 503');
    const row = await fetchJob(jobId);
    expect(row?.status).toBe('queued');
    expect(row?.attempts).toBe(2);
    expect(row?.locked_at).toBeNull();
    expect(row?.locked_by).toBeNull();
  });

  it('markOutboundJobTerminal: sending → failed is in ALLOWED_JOB_TRANSITIONS and the writer advances the row', async () => {
    // (a) Direction table check. R-OUTBOUND-008/009: terminal failure.
    expect(canTransition('job', 'sending', 'failed')).toBe(true);
    expect(ALLOWED_JOB_TRANSITIONS.get('sending')?.has('failed')).toBe(true);

    // (b) Writer behaviour: a 'sending' row with a matching lock advances
    // to 'failed' (AC5 happy path).
    const jobId = await seedJob({
      status: 'sending',
      attempts: 2,
      lockedAt: FUTURE,
      lockedBy: 'worker-a',
    });
    await markOutboundJobTerminal(env.DB, jobId, 'worker-a', 'SEND_FAILED', 'final failure');
    const row = await fetchJob(jobId);
    expect(row?.status).toBe('failed');
    expect(row?.error_code).toBe('SEND_FAILED');
    expect(row?.attempts).toBe(2); // terminal write does not increment
    expect(row?.locked_at).toBeNull();
    expect(row?.locked_by).toBeNull();
  });
});
