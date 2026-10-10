// queue.worker.test.ts — CAP-023 queue consumer use case.
//
// Worker-pool tests for processOutboundJob — the seam between the Cloudflare
// Queue plumbing (entrypoints/queue.ts) and the actual send. Tests call the
// use case directly so the happy / failure / idempotent-skip paths can be
// exercised without queue plumbing (per .claude/rules/testing.md §Failure
// paths).
//
// Covers:
// - Happy path: adapter.send succeeds → message status 'sent', job 'sent',
//   provider_message_id recorded.
// - Failure path: adapter.send throws → job status 'failed', attempts
//   incremented, error recorded; the error rethrows so the queue consumer
//   can retry.
// - Idempotent skip: job already 'sent' → adapter is not called.
//
// The adapter is mocked at the OutboundProviderAdapter interface boundary
// (per .claude/rules/testing.md §Mocking: do mock provider HTTP, never
// deeper). The D1 binding is real.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { MessageBatch } from '@cloudflare/workers-types';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { importEncryptionKey, encrypt } from '../platform/crypto';
import { processOutboundJob } from '../modules/outbound-mail';
import { updateJobStatus } from '../modules/outbound-mail/job-repository';
import { parseProviderKey, type OutboundProviderAdapter } from '@unimailbox/contracts';
import queueHandler from './queue';
import { providerRegistry } from '../integrations/providers/provider-registry';

// The test wrangler.test.jsonc pins CREDENTIAL_ENCRYPTION_KEY to 64 'a's.
const ENCRYPTION_KEY = 'a'.repeat(64);

/**
 * Builds a mock adapter that records every send call. The sendImpl runs
 * inside the outer async send function (rather than being awaited as a
 * nested promise) so a thrown error becomes the outer function's rejection —
 * vitest 4 otherwise flags the intermediate rejected promise as unhandled.
 */
function makeMockAdapter(
  sendImpl: (payload: {
    idempotencyKey: string;
    to: ReadonlyArray<{ address: string }>;
  }) =>
    | Promise<{ providerMessageId: string; acceptedAt: string }>
    | { providerMessageId: string; acceptedAt: string },
): OutboundProviderAdapter & { sendCalls: Array<{ idempotencyKey: string; toCount: number }> } {
  const sendCalls: Array<{ idempotencyKey: string; toCount: number }> = [];
  const adapter: OutboundProviderAdapter = {
    key: parseProviderKey('brevo'),
    validateConnection: async () => {},
    async send(_ctx, msg) {
      sendCalls.push({ idempotencyKey: msg.idempotencyKey, toCount: msg.to.length });
      // Inline the sendImpl call so its throw (sync or async) is caught by
      // this async function's implicit promise, not a wrapped one.
      const result = await sendImpl({
        idempotencyKey: msg.idempotencyKey,
        to: msg.to,
      });
      return result;
    },
  };
  return Object.assign(adapter, { sendCalls });
}

interface SeedResult {
  readonly jobId: string;
  readonly messageId: string;
  readonly connectionId: string;
}

/** Seeds a message + recipients + provider connection + credential + job. */
async function seedJob(): Promise<SeedResult> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();

  // Encrypt a fake API key so the decrypt path in processOutboundJob succeeds.
  const key = await importEncryptionKey(ENCRYPTION_KEY);
  const encrypted = await encrypt('test-brevo-api-key', key);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, from_address, from_name, subject, html_body, text_body,
         message_id_header, in_reply_to_header, references_header, status, created_at, updated_at)
       VALUES (?, 'sender@example.com', 'Sender', 'Hello', '<p>body</p>', 'body',
         NULL, NULL, '', 'queued', ?, ?)`,
    ).bind(messageId, now, now),
    env.DB.prepare(
      `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
       VALUES (?, ?, 'to@example.com', 'To', 'to', ?)`,
    ).bind(crypto.randomUUID(), messageId, now),
    env.DB.prepare(
      `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
       VALUES (?, ?, 'cc@example.com', '', 'cc', ?)`,
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
      `INSERT INTO outbound_jobs (id, message_id, provider_connection_id, status, attempts, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, 3, ?, ?)`,
    ).bind(jobId, messageId, connectionId, now, now),
  ]);

  return { jobId, messageId, connectionId };
}

describe('processOutboundJob', () => {
  beforeEach(async () => {
    // The setup gate middleware checks installation_state; we don't hit the
    // HTTP layer here but seed it anyway so the DB is in a realistic state.
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('sends via the adapter, then marks the message and job as sent', async () => {
    const { jobId, messageId } = await seedJob();

    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'brevo-123',
      acceptedAt: new Date().toISOString(),
    }));

    await processOutboundJob(jobId, { db: env.DB, encryptionKey: ENCRYPTION_KEY, adapter });

    // Adapter was called once with the message id as idempotency key.
    expect(adapter.sendCalls).toHaveLength(1);
    expect(adapter.sendCalls[0]?.idempotencyKey).toBe(messageId);
    // Only 'to' recipients are passed (cc is included too; bcc is dropped).
    expect(adapter.sendCalls[0]?.toCount).toBe(1);

    // Message row advanced to 'sent' with a sent_at timestamp.
    const msg = await env.DB.prepare('SELECT status, sent_at FROM messages WHERE id = ?')
      .bind(messageId)
      .first<{ status: string; sent_at: string | null }>();
    expect(msg?.status).toBe('sent');
    expect(msg?.sent_at).not.toBeNull();

    // Job row advanced to 'sent' with the provider message id recorded.
    const job = await env.DB.prepare(
      'SELECT status, provider_message_id, attempts FROM outbound_jobs WHERE id = ?',
    )
      .bind(jobId)
      .first<{ status: string; provider_message_id: string | null; attempts: number }>();
    expect(job?.status).toBe('sent');
    expect(job?.provider_message_id).toBe('brevo-123');
    expect(job?.attempts).toBe(0);
  });

  it('re-queues the job with attempts+1 and rethrows when the adapter throws (R-OUTBOUND-008 retryable path)', async () => {
    const { jobId, messageId } = await seedJob();

    const adapter = makeMockAdapter(async () => {
      throw new Error('Brevo 503');
    });

    // The use case rethrows so the queue consumer can retry. Use try/catch
    // rather than .rejects.toThrow — vitest 4 otherwise surfaces the inner
    // mock rejection as an unhandled rejection in addition to the awaited one.
    let caught: unknown;
    try {
      await processOutboundJob(jobId, { db: env.DB, encryptionKey: ENCRYPTION_KEY, adapter });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Brevo 503');

    // Job recorded the failure.
    const job = await env.DB.prepare(
      'SELECT status, error_code, error_message, attempts FROM outbound_jobs WHERE id = ?',
    )
      .bind(jobId)
      .first<{
        status: string;
        error_code: string | null;
        error_message: string | null;
        attempts: number;
      }>();
    // CAP-028: a first failure on a fresh attempts budget is retryable — the
    // row goes back to 'queued' (attempts 0 + 1 = 1 < max 3), not 'failed'.
    expect(job?.status).toBe('queued');
    expect(job?.error_message).toBe('Brevo 503');
    expect(job?.attempts).toBe(1);

    // The message stays 'queued' — only the queue consumer advancing the job
    // to 'sent' should flip the message.
    const msg = await env.DB.prepare('SELECT status FROM messages WHERE id = ?')
      .bind(messageId)
      .first<{ status: string }>();
    expect(msg?.status).toBe('queued');
  });

  it('skips silently when the job is already sent (idempotent redelivery)', async () => {
    const { jobId } = await seedJob();

    // Pretend a previous consumer already sent this job.
    await updateJobStatus(env.DB, jobId, 'sent', { providerMessageId: 'brevo-already' });

    const adapter = makeMockAdapter(async () => ({
      providerMessageId: 'should-not-be-called',
      acceptedAt: new Date().toISOString(),
    }));

    await processOutboundJob(jobId, { db: env.DB, encryptionKey: ENCRYPTION_KEY, adapter });

    // The adapter must not be called for an already-sent job.
    expect(adapter.sendCalls).toHaveLength(0);
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
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Outbound job not found/);
  });
});

describe('Queue entrypoint provider dispatch', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });

  it('R-OUTBOUND-008 acknowledges an inactive connection after recording a terminal job', async () => {
    const { jobId, connectionId } = await seedJob();
    await env.DB.prepare("UPDATE provider_connections SET status = 'disabled' WHERE id = ?")
      .bind(connectionId)
      .run();
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      messages: [{ body: { jobId }, ack, retry }],
    } as unknown as MessageBatch<unknown>;

    await queueHandler.queue(batch, env);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const job = await env.DB.prepare('SELECT status, error_code FROM outbound_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; error_code: string | null }>();
    expect(job).toMatchObject({ status: 'failed', error_code: 'TERMINAL_PROVIDER_ERROR' });
  });

  it('R-OUTBOUND-008 acknowledges an unregistered provider after recording a terminal job', async () => {
    const { jobId, connectionId } = await seedJob();
    await env.DB.prepare("UPDATE provider_connections SET provider_key = 'smtp-test' WHERE id = ?")
      .bind(connectionId)
      .run();
    const getAdapter = vi.spyOn(providerRegistry, 'get');
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      messages: [{ body: { jobId }, ack, retry }],
    } as unknown as MessageBatch<unknown>;

    try {
      await queueHandler.queue(batch, env);
      expect(getAdapter).toHaveBeenCalledWith(parseProviderKey('smtp-test'));
    } finally {
      getAdapter.mockRestore();
    }

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const job = await env.DB.prepare('SELECT status, error_code FROM outbound_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; error_code: string | null }>();
    expect(job).toMatchObject({ status: 'failed', error_code: 'TERMINAL_PROVIDER_ERROR' });
  });
});

// Silence the unused-import warning for vi when no spies are active in this
// file — keeps the lint gate green if a future test in this file adds one.
void vi;
