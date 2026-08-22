// process-outbound-job.worker.test.ts — CAP-028 queue consumer use case.
//
// Worker-pool tests for the claim-first flow (AC2 of the CAP-028 contract):
//
// - claim happens before any other write — an unclaimable row throws a typed
//   DomainError(LOCK_CONTENTION) and the provider adapter is never called
// - a 'sent' row returns silently with no provider call (R-OUTBOUND-009,
//   at-least-once idempotency)
// - a stale worker's success write is a no-op when the lock was stolen
//   mid-send (R-OUTBOUND-007)
// - retryable vs terminal failure split (R-OUTBOUND-008)
// - a pre-send failure AFTER the claim (missing message, decrypt failure)
//   routes through the same retryable/terminal decision — never strands the
//   row in 'sending' with a held lease and no attempts++
// - sequential attempts exhaustion 0→1→2→3 (M4b)
// - end-to-end crash/reclaim/re-drive loop against real D1 + real queue
//   producer (H4)
//
// The adapter is mocked at the OutboundProviderAdapter boundary; the D1
// binding is real (.claude/rules/testing.md §Mocking).

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { importEncryptionKey, encrypt } from '../../platform/crypto';
import { DomainError } from '../../platform/errors';
import { OUTBOX_LEASE_TTL_MS } from '../../platform/outbox-config';
import { processOutboundJob } from './process-outbound-job';
import { claimOutboundJob } from './job-repository';
import { reclaimStaleJobs } from './reclaim-stale-jobs';
import {
  parseProviderKey,
  RetryableProviderError,
  TerminalProviderError,
  type OutboundProviderAdapter,
} from '@unimailbox/contracts';

// The test wrangler.test.jsonc pins CREDENTIAL_ENCRYPTION_KEY to 64 'a's.
const ENCRYPTION_KEY = 'a'.repeat(64);

function makeMockAdapter(
  sendImpl: () => Promise<{ providerMessageId: string; acceptedAt: string }>,
): OutboundProviderAdapter & { sendCalls: { count: number } } {
  // Counter rides on a mutable object so the assertion sees the live count
  // (Object.assign would snapshot a primitive).
  const sendCalls = { count: 0 };
  const adapter: OutboundProviderAdapter = {
    key: parseProviderKey('brevo'),
    validateConnection: async () => {},
    async send(_ctx, _msg) {
      sendCalls.count += 1;
      // Await inline so a thrown sendImpl rejects THIS async function —
      // returning the promise unwrapped leaves it flagged as an unhandled
      // intermediate rejection under vitest 4.
      return await sendImpl();
    },
  };
  return Object.assign(adapter, { sendCalls });
}

interface SeedOptions {
  readonly status?: 'queued' | 'sending' | 'sent' | 'failed';
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly lockedAt?: string | null;
  readonly lockedBy?: string | null;
}

/** Seeds a message + recipients + credential + connection + job in one batch. */
async function seedJob(opts: SeedOptions = {}): Promise<{ jobId: string; messageId: string }> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();

  const key = await importEncryptionKey(ENCRYPTION_KEY);
  const encrypted = await encrypt('test-brevo-api-key', key);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, from_address, from_name, subject, html_body, text_body, status, created_at, updated_at)
       VALUES (?, 'sender@example.com', 'Sender', 'Hello', '<p>body</p>', 'body', 'queued', ?, ?)`,
    ).bind(messageId, now, now),
    env.DB.prepare(
      `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
       VALUES (?, ?, 'to@example.com', 'To', 'to', ?)`,
    ).bind(crypto.randomUUID(), messageId, now),
    env.DB.prepare(
      `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
       VALUES (?, 'brevo-api-key', 1, ?, ?, ?, ?, ?)`,
    ).bind(credentialId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, now, now),
    env.DB.prepare(
      `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, created_at, updated_at)
       VALUES (?, 'brevo', 'Brevo', ?, 'active', ?, ?)`,
    ).bind(connectionId, credentialId, now, now),
    env.DB.prepare(
      `INSERT INTO outbound_jobs (id, message_id, provider_connection_id, status, attempts, max_attempts, locked_at, locked_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      messageId,
      connectionId,
      opts.status ?? 'queued',
      opts.attempts ?? 0,
      opts.maxAttempts ?? 3,
      opts.lockedAt ?? null,
      opts.lockedBy ?? null,
      now,
      now,
    ),
  ]);

  return { jobId, messageId };
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

describe('processOutboundJob (AC2 — claim-first, R-OUTBOUND-007/009)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('sends successfully and marks the job sent under its own lease', async () => {
    const { jobId } = await seedJob();
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'brevo-ok',
      acceptedAt: new Date().toISOString(),
    }));

    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-a',
    });

    expect(adapter.sendCalls.count).toBe(1);
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('sent');
    expect(job?.locked_by).toBeNull(); // lock released on success
  });

  it('throws DomainError(LOCK_CONTENTION) without a provider call when another worker holds a live lease', async () => {
    const liveLease = new Date(Date.now() + 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const { jobId } = await seedJob({
      status: 'sending',
      lockedAt: liveLease,
      lockedBy: 'worker-b',
    });
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'must-not-happen',
      acceptedAt: new Date().toISOString(),
    }));

    let caught: unknown;
    try {
      await processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-a',
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('LOCK_CONTENTION');
    expect(adapter.sendCalls.count).toBe(0); // claim failed before any send
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('sending');
    expect(job?.locked_by).toBe('worker-b'); // untouched
  });

  it('throws DomainError(LOCK_CONTENTION) for a failed row (terminal, not claimable — R-OUTBOUND-009)', async () => {
    const { jobId } = await seedJob({ status: 'failed', attempts: 3 });
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'must-not-happen',
      acceptedAt: new Date().toISOString(),
    }));

    let caught: unknown;
    try {
      await processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-a',
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('LOCK_CONTENTION');
    expect(adapter.sendCalls.count).toBe(0);
    expect((await fetchJob(jobId))?.status).toBe('failed');
  });

  it('returns silently, with no provider call, for an already-sent row (R-OUTBOUND-009 idempotent skip)', async () => {
    const { jobId } = await seedJob({ status: 'sent' });
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'must-not-happen',
      acceptedAt: new Date().toISOString(),
    }));

    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-a',
    });

    expect(adapter.sendCalls.count).toBe(0);
    expect((await fetchJob(jobId))?.status).toBe('sent');
  });

  it('leaves the row alone when the lock is stolen mid-send (stale worker no-op, R-OUTBOUND-007)', async () => {
    const { jobId } = await seedJob();
    // Simulate a reclaim firing while this worker is inside adapter.send: the
    // send hook steals the row back to 'queued' before the success write runs.
    const adapter = makeMockAdapter(async () => {
      await env.DB.prepare(
        `UPDATE outbound_jobs
              SET status = 'queued', locked_at = NULL, locked_by = NULL
            WHERE id = ?`,
      )
        .bind(jobId)
        .run();
      return { providerMessageId: 'brevo-raced', acceptedAt: new Date().toISOString() };
    });

    // Must not throw — the divergence is resolved by whoever stole the lock.
    // H3: the swallow is surfaced as a warn carrying the job ID only
    // (R-LOG-001 — no bodies, no provider payload). The setup file's console
    // spy lives in the node context; re-spy here so mock.calls is inspectable
    // inside workerd.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-a',
    });

    const warnCalls = warnSpy.mock.calls;
    warnSpy.mockRestore();
    const divergence = warnCalls.filter((args) =>
      String(args[0]).includes('outbound.job_sent_divergence'),
    );
    expect(divergence).toHaveLength(1);
    const line = JSON.parse(String(divergence[0]?.[0])) as Record<string, unknown>;
    expect(line.jobId).toBe(jobId);
    expect(String(line.reason)).not.toMatch(/<p>|body|html/i);

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('queued'); // stale success write was a no-op
    expect(job?.locked_by).toBeNull();
  });
});

describe('processOutboundJob failure split (AC4/AC5 — R-OUTBOUND-008)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('re-queues with attempts+1 and rethrows on a retryable error (attempts budget remains)', async () => {
    const { jobId } = await seedJob({ attempts: 0 });
    const adapter = makeMockAdapter(async () => {
      throw new Error('Brevo 503');
    });

    let caught: unknown;
    try {
      await processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-a',
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Brevo 503'); // rethrown for the queue retry

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(job?.error_message).toBe('Brevo 503');
    expect(job?.locked_by).toBeNull(); // lock released for the next claim
  });

  it('marks the job failed without rethrowing when the attempts budget is exhausted', async () => {
    const { jobId } = await seedJob({ attempts: 2 });
    // attempts=2, max_attempts=3 → this failure is the last permitted attempt.
    const adapter = makeMockAdapter(async () => {
      throw new Error('Brevo 503 final');
    });

    // No try/catch: a terminal failure must resolve (job acked, not retried).
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-a',
    });

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error_message).toBe('Brevo 503 final');
    expect(job?.locked_by).toBeNull();
  });

  it('B4: TerminalProviderError (4xx) marks the job failed on the first attempt, not after burning the budget (D-CAP-028-A)', async () => {
    const { jobId } = await seedJob({ attempts: 0 });
    const adapter = makeMockAdapter(async () => {
      throw new TerminalProviderError({
        message: 'Brevo send failed: 400 {"code":"invalid_parameter"}',
        httpStatus: 400,
      });
    });

    // No try/catch: a terminal failure must resolve (job acked, not retried).
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-a',
    });

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('failed');
    // B4 / D-CAP-028-A: the attempts budget is bypassed. A 4xx is terminal
    // immediately — retrying identical payload would never succeed.
    expect(job?.attempts).toBe(0);
    // The error code is the stable provider-error code; the message records
    // the underlying 4xx for the operator's audit trail.
    expect(job?.error_code).toBe('TERMINAL_PROVIDER_ERROR');
    expect(job?.error_message).toMatch(/400/);
    expect(job?.locked_by).toBeNull();
  });

  it('B5: RetryableProviderError (5xx) routes through the attempts budget', async () => {
    const { jobId } = await seedJob({ attempts: 0 });
    const adapter = makeMockAdapter(async () => {
      throw new RetryableProviderError({
        message: 'Brevo send failed: 503',
        httpStatus: 503,
      });
    });

    let caught: unknown;
    try {
      await processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-a',
      });
    } catch (e) {
      caught = e;
    }

    // Rethrown for queue retry.
    expect(caught).toBeInstanceOf(RetryableProviderError);
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(job?.error_code).toBe('SEND_FAILED'); // generic retryable code
    expect(job?.locked_by).toBeNull();
  });

  it('B6: TerminalProviderError wins over the attempts budget even on a high-attempts row', async () => {
    const { jobId } = await seedJob({ attempts: 2 });
    const adapter = makeMockAdapter(async () => {
      throw new TerminalProviderError({
        message: 'Brevo send failed: 401 unauthorized',
        httpStatus: 401,
      });
    });

    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-a',
    });

    const job = await fetchJob(jobId);
    // 401 must NOT burn the remaining attempt. Terminal takes precedence.
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(2);
    expect(job?.error_code).toBe('TERMINAL_PROVIDER_ERROR');
  });

  // CAP-029 QA M5 review-triage: the previous B6 only covered a typed
  // TerminalProviderError. An SDK error that is neither Retryable nor
  // TerminalProviderError (e.g. a bare Error from fetch's TypeError when
  // DNS resolution fails AFTER the typed-error paths) must still take the
  // existing `SEND_FAILED` fallback — retries up to the budget, then
  // terminal. This is the "unknown error" branch in the steps-3–9 catch.
  it('B6b: an untyped SDK error (raw Error) routes through the SEND_FAILED fallback path', async () => {
    const { jobId } = await seedJob({ attempts: 0, maxAttempts: 2 });
    const adapter = makeMockAdapter(async () => {
      // A bare Error — NOT a RetryableProviderError, NOT a TerminalProviderError.
      // Simulates a SDK or runtime error that bypasses the typed taxonomy.
      throw new Error('upstream SDK blew up: ECONNRESET in keep-alive');
    });

    let caught: unknown;
    try {
      await processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-a',
      });
    } catch (e) {
      caught = e;
    }
    // Fallback is retryable: the consumer rethrows so the queue can retry.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/ECONNRESET/);

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    // SEND_FAILED is the closed-catalog code for non-typed failures.
    expect(job?.error_code).toBe('SEND_FAILED');
  });

  it('B6c: an untyped SDK error on the last attempt goes terminal with SEND_FAILED', async () => {
    const { jobId } = await seedJob({ attempts: 1, maxAttempts: 2 });
    const adapter = makeMockAdapter(async () => {
      throw new Error('parse failed: missing closing brace');
    });

    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-a',
    });

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(1); // terminal path does not increment
    expect(job?.error_code).toBe('SEND_FAILED');
  });

  it('throws when the job does not exist', async () => {
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'x',
      acceptedAt: new Date().toISOString(),
    }));

    let caught: unknown;
    try {
      await processOutboundJob('missing-job-id', {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-a',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Outbound job not found/);
  });
});

describe('processOutboundJob pre-send failures after a successful claim (H1 — R-OUTBOUND-008)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('re-queues with attempts+1 and rethrows when the message vanished after the claim', async () => {
    const { jobId } = await seedJob({ attempts: 0 });
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'must-not-happen',
      acceptedAt: new Date().toISOString(),
    }));

    // Simulate the message-vanished race with a delegating DB wrapper: every
    // call forwards to the real binding untouched, except the ONE
    // messages-by-id SELECT after the claim, whose read reports the row gone.
    // A literal DELETE is impossible here — outbound_jobs.message_id has
    // ON DELETE CASCADE (migration 0007), so deleting the message would take
    // the job row too and there would be nothing to assert on. The shim only
    // simulates the read side of the race window; every write (claim, retryable
    // mark) still hits real D1, which is what H1 is about.
    const realDb = env.DB;
    let armed = false;
    const wrapStmt = (stmt: unknown): unknown =>
      new Proxy(stmt, {
        get(s, prop, receiver) {
          if (prop === 'bind') {
            return (...args: unknown[]) =>
              wrapStmt((Reflect.get(s, 'bind', s) as (...a: unknown[]) => unknown).apply(s, args));
          }
          if (prop === 'first') {
            return async (): Promise<null> => null; // the race: row gone
          }
          const value = Reflect.get(s, prop, receiver);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(s)
            : value;
        },
      });
    const racingDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (query: string) => {
          const stmt = target.prepare(query);
          if (!armed && query.includes('FROM messages WHERE id = ?')) {
            armed = true; // claim already happened — claim precedes this read
            return wrapStmt(stmt);
          }
          return stmt;
        };
      },
    });

    let caught: unknown;
    try {
      await processOutboundJob(jobId, {
        db: racingDb as unknown as typeof env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-a',
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Message not found/);
    expect(adapter.sendCalls.count).toBe(0);
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(job?.locked_by).toBeNull();
  });

  it('re-queues with attempts+1 and rethrows when credential decryption fails (wrong key)', async () => {
    const { jobId } = await seedJob({ attempts: 0 });
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'must-not-happen',
      acceptedAt: new Date().toISOString(),
    }));

    let caught: unknown;
    try {
      await processOutboundJob(jobId, {
        db: env.DB,
        // Valid-shape key that does NOT match the seed — AES-GCM auth fails
        // in step 7, before the adapter call.
        encryptionKey: 'f'.repeat(64),
        adapter,
        lockedBy: 'worker-a',
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(adapter.sendCalls.count).toBe(0);
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1); // H1: post-claim failure increments
    expect(job?.locked_by).toBeNull();
  });

  it('goes terminal on a decrypt failure when the attempts budget is exhausted', async () => {
    const { jobId } = await seedJob({ attempts: 2 }); // next failure = 3 = max
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'must-not-happen',
      acceptedAt: new Date().toISOString(),
    }));

    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: 'f'.repeat(64),
      adapter,
      lockedBy: 'worker-a',
    });

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(2); // terminal write never increments
    expect(job?.locked_by).toBeNull();
  });
});

describe('processOutboundJob sequential attempts exhaustion (M4b — R-OUTBOUND-008)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('drives retryable failures 0→1→2→3: the third failure routes terminal', async () => {
    const { jobId } = await seedJob({ attempts: 0 });
    const adapter = makeMockAdapter(async () => {
      throw new Error('Brevo 503');
    });

    // Attempt 1: 0 → 1, rethrown, row queued.
    await expect(
      processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-a',
      }),
    ).rejects.toThrow('Brevo 503');
    let job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);

    // Attempt 2: 1 → 2, rethrown, row queued.
    await expect(
      processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-b',
      }),
    ).rejects.toThrow('Brevo 503');
    job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(2);

    // Attempt 3: 2 → 3 = max_attempts → terminal, resolved (no rethrow).
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-c',
    });
    job = await fetchJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error_message).toBe('Brevo 503');
    expect(job?.attempts).toBe(2); // terminal write keeps the last count
    expect(job?.locked_by).toBeNull();
  });
});

describe('processOutboundJob post-send write failure (CAP-028 F2 — R-OUTBOUND-007/008/009)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('leaves the row sending with the lease held, attempts unchanged, and recoverable by reclaim when the post-success messages UPDATE fails', async () => {
    // attempts=1 so "unchanged" is distinguishable from a fresh 0-seed write.
    const { jobId } = await seedJob({ attempts: 1 });
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'brevo-sent-once',
      acceptedAt: new Date().toISOString(),
    }));

    // CAP-029 M3 review-triage + CAP-030 direction guard: the precise SQL of the
    // post-send `updateMessageStatus` statement. Matched as a full string
    // (whitespace-normalised) so a future change that adds `provider_event_time`
    // to another statement cannot silently re-route that statement through the
    // failing proxy. The CAP-030 direction clause
    // `AND status IN (SELECT value FROM json_each(?))` now sits alongside the
    // CAP-029 rank CASE in the WHERE — both must be present for the proxy to
    // match. Update this constant when `updateMessageStatus` is refactored.
    const UPDATE_MESSAGE_STATUS_SQL = `UPDATE messages
          SET status = ?,
              provider_event_time = ?,
              sent_at = COALESCE(?, sent_at),
              updated_at = ?
        WHERE id = ?
          AND status IN (SELECT value FROM json_each(?))
          AND (
            provider_event_time IS NULL
            OR provider_event_time < ?
            OR (
              provider_event_time = ?
              AND CASE status
                    WHEN 'failed' THEN 100
                    WHEN 'bounced' THEN 100
                    WHEN 'complained' THEN 100
                    WHEN 'delivered' THEN 80
                    WHEN 'delayed' THEN 60
                    WHEN 'queued' THEN 40
                    WHEN 'sending' THEN 30
                    WHEN 'sent' THEN 20
                    WHEN 'draft' THEN 10
                    ELSE -1
                  END < ?
            )
          )`;

    function normalizeSql(s: string): string {
      return s.replace(/\s+/g, ' ').trim();
    }

    // Same delegating-Proxy seam as the message-vanished test: every call
    // forwards to real D1 except the ONE post-send `updateMessageStatus`
    // statement (CAP-029 D-CAP-028-D — the only `messages` row writer for
    // status transitions outside inbound-mail). We detect it by exact
    // SQL match (whitespace-normalised) so a future change that adds
    // `provider_event_time` to another statement cannot silently re-route
    // that statement through the failing proxy. The pre-send reads and
    // the claim still hit the real binding.
    const realDb = env.DB;
    const wrapStmt = (stmt: unknown): unknown =>
      new Proxy(stmt, {
        get(s, prop, receiver) {
          if (prop === 'bind') {
            return (...args: unknown[]) =>
              wrapStmt((Reflect.get(s, 'bind', s) as (...a: unknown[]) => unknown).apply(s, args));
          }
          if (prop === 'run') {
            return async (): Promise<never> => {
              throw new Error('simulated D1 failure in messages UPDATE');
            };
          }
          const value = Reflect.get(s, prop, receiver);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(s)
            : value;
        },
      });
    const failingDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (query: string) => {
          const stmt = target.prepare(query);
          // CAP-029 M3 review-triage: full-statement identity match
          // (whitespace-normalised) rather than the previous substring
          // `provider_event_time = ?` which silently tripped any future
          // statement that referenced the column.
          if (normalizeSql(query) === normalizeSql(UPDATE_MESSAGE_STATUS_SQL)) {
            return wrapStmt(stmt);
          }
          return stmt;
        };
      },
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let caught: unknown;
    try {
      await processOutboundJob(jobId, {
        db: failingDb as unknown as typeof env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        lockedBy: 'worker-a',
      });
    } catch (e) {
      caught = e;
    }
    // Capture calls before restore — mockRestore clears them (same pattern as
    // the H3 divergence-warn test).
    const errorCalls = errorSpy.mock.calls;
    errorSpy.mockRestore();

    // Rethrown raw — NOT routed through the attempts logic (that is the F2
    // fix: a successful send must not burn an attempt or go terminal).
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('simulated D1 failure in messages UPDATE');
    expect(adapter.sendCalls.count).toBe(1); // the send itself succeeded

    const postSendErrors = errorCalls.filter((args) =>
      String(args[0]).includes('outbound.job_post_send_write_failed'),
    );
    expect(postSendErrors).toHaveLength(1);
    const line = JSON.parse(String(postSendErrors[0]?.[0])) as Record<string, unknown>;
    // R-LOG-001: job ID only — no bodies, no provider payload.
    expect(line.jobId).toBe(jobId);

    // The row keeps its lease and its attempts count: recoverable by the
    // lease-expiry + reclaim path, not by queue retry.
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('sending');
    expect(job?.attempts).toBe(1); // F2: no attempts++ on a successful send
    expect(job?.error_code).toBeNull(); // no terminal/retryable write happened
    expect(job?.locked_by).toBe('worker-a'); // lease held
    expect(job?.locked_at).not.toBeNull();

    // Recovery: once the lease expires, the cron reclaim pulls the row back
    // to queued. leaseCutoff(now) = now − OUTBOX_LEASE_TTL_MS, so pass a
    // `now` a full TTL past the lease — no real time has to pass.
    const leaseUntil = new Date(String(job?.locked_at).replace(' ', 'T') + 'Z').getTime();
    const reclaimed = await reclaimStaleJobs(
      env.DB,
      new Date(leaseUntil + OUTBOX_LEASE_TTL_MS + 60_000),
      { send: async () => {} },
    );
    expect(reclaimed.reclaimed).toBe(1);
    const recovered = await fetchJob(jobId);
    expect(recovered?.status).toBe('queued');
    expect(recovered?.attempts).toBe(1); // reclaim never increments (R-OUTBOUND-007)
    expect(recovered?.locked_by).toBeNull();
  });
});

describe('processOutboundJob end-to-end crash → reclaim → re-drive loop (H4 — R-OUTBOUND-007/009)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('recovers a job whose consumer died mid-claim, without losing or double-sending it', async () => {
    const { jobId, messageId } = await seedJob();

    // One fixed clock drives every phase; each phase advances it explicitly
    // (.claude/rules/testing.md §Determinism — no sleeps, no Date.now()).
    let t = new Date('2025-01-01T12:00:00Z');
    const clockAt = (instant: Date) => ({
      now: () => instant,
      unixMs: () => instant.getTime(),
    });

    // Phase 1 — the consumer claims, then dies: no further writes.
    await claimOutboundJob(
      env.DB,
      jobId,
      'crashed-worker',
      new Date(t.getTime() + OUTBOX_LEASE_TTL_MS).toISOString().slice(0, 19).replace('T', ' '),
    );
    let job = await fetchJob(jobId);
    expect(job?.status).toBe('sending');
    expect(job?.locked_by).toBe('crashed-worker');

    // Phase 2 — time passes past the lease TTL; the cron reclaims. Advance
    // well beyond the cutoff (the reclaim predicate is strict <; the lease runs
    // to t0+TTL, so t0+3×TTL puts the cutoff a full TTL past the lease).
    t = new Date(t.getTime() + 3 * OUTBOX_LEASE_TTL_MS);
    const enqueuedBodies: string[] = [];
    const result = await reclaimStaleJobs(env.DB, t, {
      send: async (body) => {
        enqueuedBodies.push(body);
      },
    });

    expect(result.reclaimed).toBe(1);
    expect(result.terminal).toBe(0);
    job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.locked_at).toBeNull();
    expect(job?.locked_by).toBeNull();
    expect(job?.attempts).toBe(0); // reclaim never increments (R-OUTBOUND-007)
    // Re-enqueued in exactly the body format the queue consumer parses.
    expect(enqueuedBodies).toEqual([JSON.stringify({ jobId })]);

    // Phase 3 — the redelivered job is claimed and sends successfully.
    t = new Date(t.getTime() + 30_000);
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'brevo-recovered',
      acceptedAt: new Date().toISOString(),
    }));
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-recovery',
      clock: clockAt(t),
    });

    expect(adapter.sendCalls.count).toBe(1);
    job = await fetchJob(jobId);
    expect(job?.status).toBe('sent');
    expect(job?.locked_by).toBeNull();
    const message = await env.DB.prepare('SELECT status FROM messages WHERE id = ?')
      .bind(messageId)
      .first<{ status: string }>();
    expect(message?.status).toBe('sent');
    const jobRow = await env.DB.prepare(
      'SELECT provider_message_id FROM outbound_jobs WHERE id = ?',
    )
      .bind(jobId)
      .first<{ provider_message_id: string | null }>();
    expect(jobRow?.provider_message_id).toBe('brevo-recovered');
  });

  it('F1: a sweep-enqueued row that is also delivered normally resolves exactly once', async () => {
    // The orphan sweep re-enqueues a queued row with no coordination against
    // the original queue delivery, so both can arrive. Double-enqueue safety
    // is structural: the atomic claim has exactly one winner (R-OUTBOUND-007,
    // pinned by the concurrent-claims repository test), and the duplicate
    // delivery finds the row terminal and skips (R-OUTBOUND-009). Drive the
    // two deliveries sequentially so the interleaving is deterministic — the
    // pre-claim `sent` skip is the path a late duplicate actually takes.
    const { jobId } = await seedJob({ attempts: 0 });
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'brevo-exactly-once',
      acceptedAt: new Date().toISOString(),
    }));

    // Delivery 1 (from the sweep's re-enqueue) sends and resolves the row.
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'sweep-delivery',
    });

    // Delivery 2 (the original queue message, arriving late) must resolve
    // silently — the pre-claim `sent` skip, no second provider call.
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'normal-delivery',
    });

    expect(adapter.sendCalls.count).toBe(1);
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('sent');
    expect(job?.attempts).toBe(0); // no attempts burned by the duplicate drive
    expect(job?.locked_by).toBeNull();
    const jobRow = await env.DB.prepare(
      'SELECT provider_message_id FROM outbound_jobs WHERE id = ?',
    )
      .bind(jobId)
      .first<{ provider_message_id: string | null }>();
    expect(jobRow?.provider_message_id).toBe('brevo-exactly-once');
  });
});
