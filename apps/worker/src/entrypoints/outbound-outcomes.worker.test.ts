import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
  fakeClock,
  resetAndMigrate,
  seedInstallationState,
  seedOutboundSubmission,
  seedInboundMailbox,
} from '@unimailbox/test-kit';
import {
  parseProviderKey,
  RetryableProviderError,
  UnknownProviderOutcomeError,
  outboundAttemptTag,
  type OutboundProviderAdapter,
} from '@unimailbox/contracts';
import { encrypt, importEncryptionKey } from '../platform/crypto';
import { buildAppContext } from '../app-context';
import {
  processOutboundJob,
  reclaimStaleJobs,
  reconcileOutboundSubmissions,
  claimOutboundJob,
} from '../modules/outbound-mail';
import {
  getOutboundAttempt,
  prepareOutboundAttempt,
  submitOutboundAttempt,
  findUnresolvedAttempt,
} from '../modules/outbound-mail/attempt-repository';
import { OUTBOX_LEASE_TTL_MS, OUTBOUND_REQUEST_TIMEOUT_MS } from '../platform/outbox-config';
import { sqliteTimestamp } from '../platform/idempotency';
import { app } from './http';
import { verifyAndProcessEvent } from '../modules/outbound-mail/webhook-processor';
import { brevoWebhookAdapter } from '../integrations/providers/brevo-webhook';
import verification from '../../../../migrations/0039_outbound_send_attempts.verify.sql?raw';

const ENCRYPTION_KEY = 'a'.repeat(64);
const NOW = new Date('2026-10-15T12:00:00.000Z');
const ATTEMPT_ID = 'a0000000-0000-4000-8000-000000000001';
function webhookBody(attemptId: string, messageId = '<accepted@example.test>') {
  return JSON.stringify({
    event: 'delivered',
    'message-id': messageId,
    'X-Mailin-custom': outboundAttemptTag(attemptId),
    ts_event: Math.floor(NOW.getTime() / 1000),
  });
}
async function fixture() {
  const seeded = await seedOutboundSubmission(
    await encrypt('synthetic-key', await importEncryptionKey(ENCRYPTION_KEY)),
  );
  const ctx = { ...buildAppContext(env), clock: fakeClock(NOW) };
  const send = vi.fn<OutboundProviderAdapter['send']>(async () => ({
    providerMessageId: '<accepted@example.test>',
    acceptedAt: NOW.toISOString(),
  }));
  const findSubmission = vi.fn<NonNullable<OutboundProviderAdapter['findSubmission']>>(
    async () => null,
  );
  const adapter: OutboundProviderAdapter = {
    key: parseProviderKey('brevo'),
    validateConnection: async () => {},
    send,
    findSubmission,
  };
  const deps = { ...ctx, encryptionKey: ENCRYPTION_KEY, adapter };
  const reconcile = () =>
    reconcileOutboundSubmissions({
      ...ctx,
      encryptionKey: async () => ENCRYPTION_KEY,
      resolveAdapter: () => adapter,
    });
  return { ...seeded, ctx, deps, send, findSubmission, reconcile };
}
async function webhook(
  connectionId: string,
  attemptId: string,
  options: { secret?: string; messageId?: string } = {},
) {
  return app.fetch(
    new Request(`https://example.test/api/v1/webhooks/brevo/${connectionId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.secret ?? 'synthetic-webhook-secret'}`,
        'Content-Type': 'application/json',
      },
      body: webhookBody(attemptId, options.messageId),
    }),
    env,
  );
}
function job(id: string) {
  return env.DB.prepare(
    'SELECT status,attempts,error_code,next_attempt_at,provider_message_id FROM outbound_jobs WHERE id=?',
  )
    .bind(id)
    .first();
}

describe('R-OUTBOUND-013/014/015 durable submission outcomes', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists submitted intent before the provider call and never blindly retries a lost response', async () => {
    const f = await fixture();
    f.send.mockImplementation(async (_ctx, message) => {
      expect(message.attemptId).toBeTypeOf('string');
      expect(await getOutboundAttempt(env.DB, message.attemptId ?? '')).toMatchObject({
        status: 'submitted',
      });
      throw new Error('response lost after upstream accepted');
    });
    await processOutboundJob(f.jobId, f.deps);
    expect(await job(f.jobId)).toMatchObject({
      status: 'sending',
      attempts: 0,
      error_code: 'SEND_OUTCOME_UNKNOWN',
    });
    expect(await findUnresolvedAttempt(env.DB, f.jobId)).toMatchObject({ status: 'unknown' });
    await processOutboundJob(f.jobId, f.deps);
    f.ctx.clock.advance(3 * OUTBOX_LEASE_TTL_MS);
    expect((await reclaimStaleJobs(env.DB, f.ctx.clock.now(), { send: vi.fn() })).reclaimed).toBe(
      0,
    );
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('repairs accepted evidence after an atomic audit failure without another send', async () => {
    const f = await fixture();
    await env.DB.exec(
      "CREATE TRIGGER fail_accept_audit BEFORE INSERT ON audit_events WHEN NEW.action='message.send' BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    await expect(processOutboundJob(f.jobId, f.deps)).rejects.toThrow();
    expect(await findUnresolvedAttempt(env.DB, f.jobId)).toMatchObject({ status: 'accepted' });
    expect(await job(f.jobId)).toMatchObject({ status: 'sending', provider_message_id: null });
    expect(
      await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(f.messageId).first(),
    ).toMatchObject({ status: 'queued' });
    await env.DB.exec('DROP TRIGGER fail_accept_audit;');
    await processOutboundJob(f.jobId, f.deps);
    expect(await job(f.jobId)).toMatchObject({ status: 'sent' });
    expect(f.send).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_events WHERE action='message.send'",
      ).first(),
    ).toMatchObject({ n: 1 });
  });

  it('recovers through provider evidence when recording the successful HTTP result itself fails', async () => {
    const f = await fixture();
    await env.DB.exec(
      "CREATE TRIGGER fail_accept_record BEFORE UPDATE ON outbound_send_attempts WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    await expect(processOutboundJob(f.jobId, f.deps)).rejects.toThrow();
    expect(await findUnresolvedAttempt(env.DB, f.jobId)).toMatchObject({ status: 'submitted' });
    await env.DB.exec('DROP TRIGGER fail_accept_record;');
    f.ctx.clock.advance(OUTBOX_LEASE_TTL_MS);
    f.findSubmission.mockResolvedValue({
      providerMessageId: '<accepted@example.test>',
      acceptedAt: NOW.toISOString(),
    });
    await f.reconcile();
    expect(await job(f.jobId)).toMatchObject({ status: 'sent' });
    expect(f.findSubmission).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('uses an authenticated attempt-correlated callback to resolve a lost response', async () => {
    const f = await fixture();
    f.send.mockRejectedValue(new UnknownProviderOutcomeError({ message: 'unknown' }));
    await processOutboundJob(f.jobId, f.deps);
    const attempt = await findUnresolvedAttempt(env.DB, f.jobId);
    expect((await webhook(f.connectionId, attempt?.id ?? '')).status).toBe(200);
    expect(await job(f.jobId)).toMatchObject({
      status: 'sent',
      provider_message_id: '<accepted@example.test>',
    });
    expect(
      await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(f.messageId).first(),
    ).toMatchObject({ status: 'delivered' });
    await processOutboundJob(f.jobId, f.deps);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('atomically rejects conflicting callback evidence prepared before another callback commits', async () => {
    const f = await fixture();
    f.send.mockRejectedValue(new Error('unknown'));
    await processOutboundJob(f.jobId, f.deps);
    const attempt = await findUnresolvedAttempt(env.DB, f.jobId);
    const prepare = (providerId: string) =>
      verifyAndProcessEvent({
        db: env.DB,
        connectionId: f.connectionId,
        providerKey: 'brevo',
        rawBody: new TextEncoder().encode(webhookBody(attempt?.id ?? '', providerId)),
        signatureHeader: 'Bearer synthetic-webhook-secret',
        adapter: brevoWebhookAdapter,
      });
    const first = await prepare('<first@example.test>');
    const conflicting = await prepare('<conflict@example.test>');
    await env.DB.batch([...first.preparedStatements.statements]);
    await expect(env.DB.batch([...conflicting.preparedStatements.statements])).rejects.toThrow();
    expect(await job(f.jobId)).toMatchObject({
      status: 'sent',
      provider_message_id: '<first@example.test>',
    });
    expect(
      await env.DB.prepare(
        'SELECT verified_provider_message_id FROM webhook_deliveries WHERE message_id=?',
      )
        .bind(f.messageId)
        .all(),
    ).toMatchObject({ results: [{ verified_provider_message_id: '<first@example.test>' }] });
  });

  it('keeps a scheduled message pending until acceptance is proven, then atomically moves it to sent', async () => {
    const f = await fixture();
    const { mailboxId } = await seedInboundMailbox();
    await env.DB.prepare(
      "UPDATE outbound_jobs SET mailbox_id=?,scheduled_at='2026-10-15 11:59:00' WHERE id=?",
    )
      .bind(mailboxId, f.jobId)
      .run();
    await env.DB.prepare(
      "INSERT INTO mailbox_messages(id,mailbox_id,message_id,folder) VALUES ('b0000000-0000-4000-8000-000000000001',?,?,'scheduled')",
    )
      .bind(mailboxId, f.messageId)
      .run();
    f.send.mockRejectedValue(new Error('lost response'));
    await processOutboundJob(f.jobId, f.deps);
    expect(
      await env.DB.prepare('SELECT folder FROM mailbox_messages WHERE message_id=?')
        .bind(f.messageId)
        .first(),
    ).toMatchObject({ folder: 'scheduled' });
    const attempt = await findUnresolvedAttempt(env.DB, f.jobId);
    expect((await webhook(f.connectionId, attempt?.id ?? '')).status).toBe(200);
    expect(
      await env.DB.prepare('SELECT folder FROM mailbox_messages WHERE message_id=?')
        .bind(f.messageId)
        .first(),
    ).toMatchObject({ folder: 'sent' });
  });

  it('does not trust an invalid signature or a different connection to resolve unknown work', async () => {
    const f = await fixture();
    f.send.mockRejectedValue(new Error('unknown'));
    await processOutboundJob(f.jobId, f.deps);
    const attempt = await findUnresolvedAttempt(env.DB, f.jobId);
    expect((await webhook(f.connectionId, attempt?.id ?? '', { secret: 'wrong' })).status).toBe(
      401,
    );
    await env.DB.prepare(
      `INSERT INTO provider_connections(id,provider_key,label,credential_id,status,webhook_secret)
      SELECT 'other-connection',provider_key,label,credential_id,status,webhook_secret FROM provider_connections WHERE id=?`,
    )
      .bind(f.connectionId)
      .run();
    expect((await webhook('other-connection', attempt?.id ?? '')).status).toBe(200);
    expect(await job(f.jobId)).toMatchObject({ status: 'sending', provider_message_id: null });
  });

  it('keeps early callback acceptance even when the subsequent send response is lost', async () => {
    const f = await fixture();
    f.send.mockImplementation(async (_ctx, message) => {
      expect((await webhook(f.connectionId, message.attemptId ?? '')).status).toBe(200);
      throw new Error('lost response after webhook');
    });
    await processOutboundJob(f.jobId, f.deps);
    expect(await job(f.jobId)).toMatchObject({ status: 'sent' });
    expect(f.send).toHaveBeenCalledOnce();
    f.ctx.clock.advance(3600_000);
    await f.reconcile();
    expect(f.findSubmission).not.toHaveBeenCalled();
  });

  it.each(['empty', 'error'] as const)(
    'keeps a %s reconciliation result fenced instead of resending',
    async (mode) => {
      const f = await fixture();
      f.send.mockRejectedValue(new Error('unknown'));
      await processOutboundJob(f.jobId, f.deps);
      f.ctx.clock.advance(300_000);
      if (mode === 'error') f.findSubmission.mockRejectedValue(new Error('provider unavailable'));
      if (mode === 'error') await expect(f.reconcile()).rejects.toThrow('reconciliation');
      else await f.reconcile();
      await processOutboundJob(f.jobId, f.deps);
      expect(await job(f.jobId)).toMatchObject({
        status: 'sending',
        error_code: 'SEND_OUTCOME_UNKNOWN',
      });
      expect(f.send).toHaveBeenCalledOnce();
    },
  );

  it('enforces persisted Retry-After across immediate Queue redelivery and then permits one new attempt', async () => {
    const f = await fixture();
    f.send.mockRejectedValueOnce(
      new RetryableProviderError({ message: 'throttled', httpStatus: 429, retryAfterSeconds: 600 }),
    );
    await expect(processOutboundJob(f.jobId, f.deps)).rejects.toBeInstanceOf(
      RetryableProviderError,
    );
    expect(await processOutboundJob(f.jobId, f.deps)).toEqual({ delaySeconds: 600 });
    expect(f.send).toHaveBeenCalledTimes(1);
    f.ctx.clock.advance(599_000);
    expect(await processOutboundJob(f.jobId, f.deps)).toEqual({ delaySeconds: 1 });
    f.ctx.clock.advance(1000);
    await processOutboundJob(f.jobId, f.deps);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[0]?.[1].attemptId).not.toBe(f.send.mock.calls[1]?.[1].attemptId);
    expect(f.send.mock.calls[0]?.[1].idempotencyKey).toBe(f.send.mock.calls[1]?.[1].idempotencyKey);
    expect(await job(f.jobId)).toMatchObject({ status: 'sent' });
  });

  it('fences submission if the remaining lease cannot cover the request and write margin', async () => {
    const f = await fixture();
    await claimOutboundJob(
      env.DB,
      f.jobId,
      'short-lease',
      sqliteTimestamp(new Date(NOW.getTime() + 10_000)),
      sqliteTimestamp(NOW),
    );
    await prepareOutboundAttempt(env.DB, {
      id: ATTEMPT_ID,
      jobId: f.jobId,
      providerKey: 'brevo',
      lockedBy: 'short-lease',
      now: NOW,
      requestId: null,
    });
    await expect(
      submitOutboundAttempt(
        env.DB,
        ATTEMPT_ID,
        'short-lease',
        NOW,
        new Date(NOW.getTime() + 25_000),
      ),
    ).rejects.toThrow();
    expect(await getOutboundAttempt(env.DB, ATTEMPT_ID)).toMatchObject({ status: 'prepared' });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('quarantines a crash after submitted intent even if no HTTP call can be proven', async () => {
    const f = await fixture();
    await claimOutboundJob(
      env.DB,
      f.jobId,
      'crashed',
      sqliteTimestamp(new Date(NOW.getTime() + OUTBOX_LEASE_TTL_MS)),
      sqliteTimestamp(NOW),
    );
    await prepareOutboundAttempt(env.DB, {
      id: ATTEMPT_ID,
      jobId: f.jobId,
      providerKey: 'brevo',
      lockedBy: 'crashed',
      now: NOW,
      requestId: null,
    });
    await submitOutboundAttempt(
      env.DB,
      ATTEMPT_ID,
      'crashed',
      NOW,
      new Date(NOW.getTime() + 25_000),
    );
    f.ctx.clock.advance(OUTBOX_LEASE_TTL_MS);
    await f.reconcile();
    expect(await getOutboundAttempt(env.DB, ATTEMPT_ID)).toMatchObject({ status: 'unknown' });
    await processOutboundJob(f.jobId, f.deps);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('bounds an adapter that never settles and records unknown instead of releasing the send fence', async () => {
    const f = await fixture();
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.send.mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const processing = processOutboundJob(f.jobId, f.deps);
    await ready;
    await vi.advanceTimersByTimeAsync(OUTBOUND_REQUEST_TIMEOUT_MS);
    await processing;
    expect(await findUnresolvedAttempt(env.DB, f.jobId)).toMatchObject({ status: 'unknown' });
    expect(await job(f.jobId)).toMatchObject({ status: 'sending' });
  });

  it('verifies migration constraints and repeated migration dispatch without deleting attempt evidence', async () => {
    const f = await fixture();
    await processOutboundJob(f.jobId, f.deps);
    const { migrationsDb } = await import('@unimailbox/test-kit');
    await migrationsDb();
    for (const sql of verification.split(';').filter((sql) => sql.trim())) {
      const row = await env.DB.prepare(sql).first<{ assertion: string; pass: number }>();
      expect(row?.pass, row?.assertion).toBe(1);
    }
    expect(await findUnresolvedAttempt(env.DB, f.jobId)).toMatchObject({ status: 'accepted' });
    await expect(
      env.DB.prepare("UPDATE outbound_send_attempts SET status='unknown-state'").run(),
    ).rejects.toThrow();
  });

  it.each(['queued', 'sending'])(
    'quarantines a pre-journal due %s job on upgrade instead of reclaiming and resending it',
    async (legacyStatus) => {
      const { reset } = await import('cloudflare:test');
      await reset();
      const f = await seedOutboundSubmission(
        await encrypt('synthetic-key', await importEncryptionKey(ENCRYPTION_KEY)),
        { through: '0038_inbound_receipts' },
      );
      await env.DB.prepare(
        "UPDATE outbound_jobs SET status=?,locked_by='legacy',locked_at='2000-01-01 00:00:00' WHERE id=?",
      )
        .bind(legacyStatus, f.jobId)
        .run();
      const { migrationsDb } = await import('@unimailbox/test-kit');
      await migrationsDb();
      expect(await findUnresolvedAttempt(env.DB, f.jobId)).toMatchObject({
        status: 'unknown',
        correlated: 0,
      });
      const send = vi.fn();
      expect((await reclaimStaleJobs(env.DB, NOW, { send })).reclaimed).toBe(0);
      await processOutboundJob(f.jobId, {
        ...buildAppContext(env),
        encryptionKey: ENCRYPTION_KEY,
        adapter: { key: parseProviderKey('brevo'), validateConnection: async () => {}, send },
      });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('preserves a future legacy scheduled job as unsent queued work during migration', async () => {
    const { reset } = await import('cloudflare:test');
    await reset();
    const f = await seedOutboundSubmission(
      await encrypt('synthetic-key', await importEncryptionKey(ENCRYPTION_KEY)),
      { through: '0038_inbound_receipts' },
    );
    await env.DB.prepare("UPDATE outbound_jobs SET scheduled_at='2099-01-01 00:00:00' WHERE id=?")
      .bind(f.jobId)
      .run();
    const { migrationsDb } = await import('@unimailbox/test-kit');
    await migrationsDb();
    expect(await job(f.jobId)).toMatchObject({ status: 'queued' });
    expect(await findUnresolvedAttempt(env.DB, f.jobId)).toBeNull();
  });

  it('repairs a legacy saved provider ID on upgrade without another provider request', async () => {
    const { reset } = await import('cloudflare:test');
    await reset();
    const f = await seedOutboundSubmission(
      await encrypt('synthetic-key', await importEncryptionKey(ENCRYPTION_KEY)),
      { through: '0038_inbound_receipts' },
    );
    await env.DB.prepare(
      "UPDATE outbound_jobs SET status='sending',provider_message_id='<legacy@example.test>' WHERE id=?",
    )
      .bind(f.jobId)
      .run();
    const { migrationsDb } = await import('@unimailbox/test-kit');
    await migrationsDb();
    const send = vi.fn();
    await processOutboundJob(f.jobId, {
      ...buildAppContext(env),
      encryptionKey: ENCRYPTION_KEY,
      adapter: { key: parseProviderKey('brevo'), validateConnection: async () => {}, send },
    });
    expect(await job(f.jobId)).toMatchObject({
      status: 'sent',
      provider_message_id: '<legacy@example.test>',
    });
    expect(send).not.toHaveBeenCalled();
  });
});
