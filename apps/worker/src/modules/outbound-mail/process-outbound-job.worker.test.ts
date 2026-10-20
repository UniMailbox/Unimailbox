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
import { resetAndMigrate, seedInstallationState, fakeClock } from '@unimailbox/test-kit';
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
  providerKey = 'brevo',
): OutboundProviderAdapter & { sendCalls: { count: number } } {
  // Counter rides on a mutable object so the assertion sees the live count
  // (Object.assign would snapshot a primitive).
  const sendCalls = { count: 0 };
  const adapter: OutboundProviderAdapter = {
    key: parseProviderKey(providerKey),
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
  readonly providerKey?: string;
  readonly connectionStatus?: 'active' | 'disabled' | 'invalid';
}

/** Seeds a message + recipients + credential + connection + job in one batch. */
async function seedJob(opts: SeedOptions = {}): Promise<{
  jobId: string;
  messageId: string;
  connectionId: string;
}> {
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
       VALUES (?, ?, 'Test connection', ?, ?, ?, ?)`,
    ).bind(
      connectionId,
      opts.providerKey ?? 'brevo',
      credentialId,
      opts.connectionStatus ?? 'active',
      now,
      now,
    ),
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

  return { jobId, messageId, connectionId };
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

  it('R-OUTBOUND-004 delivers blind recipients only through the separate Bcc envelope', async () => {
    const { jobId, messageId } = await seedJob();
    await env.DB.prepare(
      `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at) VALUES (?, ?, 'hidden@example.com', 'Hidden', 'bcc', datetime('now'))`,
    )
      .bind(crypto.randomUUID(), messageId)
      .run();
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'bcc-ok',
      acceptedAt: new Date().toISOString(),
    }));
    const send = vi.spyOn(adapter, 'send');
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      lockedBy: 'worker-bcc',
    });
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      to: [{ address: 'to@example.com' }],
      cc: [],
      bcc: [{ address: 'hidden@example.com', displayName: 'Hidden' }],
    });
  });

  it('calls the provider only when the authoritative scheduled time is due', async () => {
    const { jobId } = await seedJob();
    const now = new Date();
    const time = new Date(now.getTime() + 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    await env.DB.prepare('UPDATE outbound_jobs SET scheduled_at=? WHERE id=?')
      .bind(time, jobId)
      .run();
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'scheduled-ok',
      acceptedAt: new Date().toISOString(),
    }));
    expect(
      await processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        adapter,
        clock: { now: () => now, unixMs: () => now.getTime() },
      }),
    ).toMatchObject({ delaySeconds: expect.any(Number) });
    expect(adapter.sendCalls.count).toBe(0);
    const due = new Date(now.getTime() + 3600_000);
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter,
      clock: { now: () => due, unixMs: () => due.getTime() },
    });
    expect(adapter.sendCalls.count).toBe(1);
    expect(await fetchJob(jobId)).toMatchObject({ status: 'sent' });
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

  it('R-OUTBOUND-007 resolves the adapter from the claimed job connection', async () => {
    const { jobId } = await seedJob({ providerKey: 'smtp-test' });
    const adapter = makeMockAdapter(
      async () => ({ providerMessageId: 'smtp-ok', acceptedAt: new Date().toISOString() }),
      'smtp-test',
    );
    const resolvedKeys: string[] = [];

    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      resolveAdapter: (key) => {
        resolvedKeys.push(key);
        return key === adapter.key ? adapter : undefined;
      },
    });

    expect(resolvedKeys).toEqual(['smtp-test']);
    expect(adapter.sendCalls.count).toBe(1);
    expect((await fetchJob(jobId))?.status).toBe('sent');
  });

  it.each(['disabled', 'invalid'] as const)(
    'R-OUTBOUND-008 records a %s connection as terminal after claim',
    async (connectionStatus) => {
      const { jobId } = await seedJob({ connectionStatus });
      const resolveAdapter = vi.fn(() =>
        makeMockAdapter(async () => ({
          providerMessageId: 'must-not-send',
          acceptedAt: new Date().toISOString(),
        })),
      );

      await processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        resolveAdapter,
      });

      expect(resolveAdapter).not.toHaveBeenCalled();
      expect(await fetchJob(jobId)).toMatchObject({
        status: 'failed',
        attempts: 0,
        error_code: 'TERMINAL_PROVIDER_ERROR',
        locked_by: null,
      });
    },
  );

  it('R-OUTBOUND-008 records an unregistered provider as terminal after claim', async () => {
    const { jobId } = await seedJob({ providerKey: 'smtp-test' });
    const resolveAdapter = vi.fn(() => undefined);

    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      resolveAdapter,
    });

    expect(resolveAdapter).toHaveBeenCalledWith(parseProviderKey('smtp-test'));
    expect(await fetchJob(jobId)).toMatchObject({
      status: 'failed',
      attempts: 0,
      error_code: 'TERMINAL_PROVIDER_ERROR',
      locked_by: null,
    });
  });

  it('R-OUTBOUND-009 skips a failed redelivery before resolving the adapter', async () => {
    const { jobId } = await seedJob({ status: 'failed' });
    const resolveAdapter = vi.fn(() => undefined);

    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      resolveAdapter,
    });

    expect(resolveAdapter).not.toHaveBeenCalled();
    expect((await fetchJob(jobId))?.status).toBe('failed');
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

  it('R-OUTBOUND-009 skips a failed row without calling the provider', async () => {
    const { jobId } = await seedJob({ status: 'failed', attempts: 3 });
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

  it('repairs accepted evidence after a legacy reclaim resets the job, without resending', async () => {
    const { jobId } = await seedJob();
    const adapter = makeMockAdapter(async () => {
      await env.DB.prepare(
        "UPDATE outbound_jobs SET status='queued',locked_at=NULL,locked_by=NULL WHERE id=?",
      )
        .bind(jobId)
        .run();
      return { providerMessageId: 'brevo-raced', acceptedAt: new Date().toISOString() };
    });
    await processOutboundJob(jobId, { db: env.DB, encryptionKey: ENCRYPTION_KEY, adapter });
    await processOutboundJob(jobId, { db: env.DB, encryptionKey: ENCRYPTION_KEY, adapter });
    expect(adapter.sendCalls.count).toBe(1);
    expect((await fetchJob(jobId))?.status).toBe('sent');
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
      throw new RetryableProviderError({ message: 'Brevo 429', httpStatus: 429 });
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
    expect((caught as Error).message).toBe('Brevo 429'); // rethrown for the queue retry

    const job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(job?.error_message).toMatch(/deferred|exhausted/);
    expect(job?.locked_by).toBeNull(); // lock released for the next claim
  });

  it('marks the job failed without rethrowing when the attempts budget is exhausted', async () => {
    const { jobId } = await seedJob({ attempts: 2 });
    // attempts=2, max_attempts=3 → this failure is the last permitted attempt.
    const adapter = makeMockAdapter(async () => {
      throw new RetryableProviderError({ message: 'Brevo 429 final', httpStatus: 429 });
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
    expect(job?.error_message).toMatch(/exhausted/);
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
  it('R-OUTBOUND-013: an untyped post-submit error holds unknown work without retrying', async () => {
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
    expect(caught).toBeUndefined();
    const job = await fetchJob(jobId);
    expect(job?.status).toBe('sending');
    expect(job?.attempts).toBe(0);
    expect(job?.error_code).toBe('SEND_OUTCOME_UNKNOWN');
    await processOutboundJob(jobId, { db: env.DB, encryptionKey: ENCRYPTION_KEY, adapter });
    expect(adapter.sendCalls.count).toBe(1);
  });

  it('R-OUTBOUND-013: unknown outcome is not turned into a false terminal failure at the attempts limit', async () => {
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
    expect(job?.status).toBe('sending');
    expect(job?.attempts).toBe(1); // terminal path does not increment
    expect(job?.error_code).toBe('SEND_OUTCOME_UNKNOWN');
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
      throw new RetryableProviderError({ message: 'Brevo 429', httpStatus: 429 });
    });

    const clock = fakeClock(new Date());
    // Attempt 1: 0 → 1, rethrown, row queued.
    await expect(
      processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        clock,
        adapter,
        lockedBy: 'worker-a',
      }),
    ).rejects.toThrow('Brevo 429');
    let job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);

    clock.advance(30_000);
    // Attempt 2: 1 → 2, rethrown, row queued.
    await expect(
      processOutboundJob(jobId, {
        db: env.DB,
        encryptionKey: ENCRYPTION_KEY,
        clock,
        adapter,
        lockedBy: 'worker-b',
      }),
    ).rejects.toThrow('Brevo 429');
    job = await fetchJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(2);

    clock.advance(60_000);
    // Attempt 3: 2 → 3 = max_attempts → terminal, resolved (no rethrow).
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      clock,
      adapter,
      lockedBy: 'worker-c',
    });
    job = await fetchJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error_message).toMatch(/deferred|exhausted/);
    expect(job?.attempts).toBe(2); // terminal write keeps the last count
    expect(job?.locked_by).toBeNull();
  });
});

describe('R-OUTBOUND-014 post-acceptance finalization repair', () => {
  beforeEach(resetAndMigrate);
  it('keeps accepted evidence after a real D1 message failure and repairs without provider replay', async () => {
    const { jobId } = await seedJob();
    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'accepted-before-write',
      acceptedAt: new Date().toISOString(),
    }));
    await env.DB.exec(
      "CREATE TRIGGER fail_finalize BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT,'fixture finalization'); END;",
    );
    await expect(
      processOutboundJob(jobId, { db: env.DB, encryptionKey: ENCRYPTION_KEY, adapter }),
    ).rejects.toThrow();
    expect((await fetchJob(jobId))?.status).toBe('sending');
    expect(
      await env.DB.prepare('SELECT status FROM outbound_send_attempts WHERE job_id=?')
        .bind(jobId)
        .first(),
    ).toMatchObject({ status: 'accepted' });
    await env.DB.exec('DROP TRIGGER fail_finalize;');
    await processOutboundJob(jobId, { db: env.DB, encryptionKey: ENCRYPTION_KEY, adapter });
    expect(adapter.sendCalls.count).toBe(1);
    expect((await fetchJob(jobId))?.status).toBe('sent');
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
