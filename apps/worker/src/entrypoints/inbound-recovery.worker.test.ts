import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
  fakeClock,
  resetAndMigrate,
  seedInboundMailbox,
  INBOUND_RAW_FIXTURE,
} from '@unimailbox/test-kit';
import { buildAppContext } from '../app-context';
import {
  acceptInboundReceipt,
  processInboundReceipt,
  recoverInboundReceipts,
} from '../modules/inbound-mail/receive-inbound';
import {
  claimInboundReceipt,
  findInboundReceipt,
  prepareCompleteInboundReceipt,
  expireCompletedInboundReceipts,
  INBOUND_LEASE_MS,
  INBOUND_DEDUP_WINDOW_MS,
} from '../modules/messages';
import { findReferencedInboundObjectKeys } from '../modules/messages/inbound-object-repository';
import queueHandler from './queue';
import type { MessageBatch } from '@cloudflare/workers-types';
import inboundMigration from '../../../../migrations/0038_inbound_receipts.sql?raw';
import inboundVerification from '../../../../migrations/0038_inbound_receipts.verify.sql?raw';

const NOW = new Date('2026-10-15T00:00:00.000Z');
function context() {
  return { ...buildAppContext(env), clock: fakeClock(NOW) };
}
function input(mailboxId: string, raw = INBOUND_RAW_FIXTURE) {
  return {
    mailboxId,
    from: 'sender@example.net',
    to: 'inbox@example.test',
    raw: new TextEncoder().encode(raw).buffer,
    requestId: '40000000-0000-4000-8000-000000000001',
  };
}
async function count(
  table:
    | 'messages'
    | 'message_recipients'
    | 'inbound_message_attachments'
    | 'inbound_receipts'
    | 'audit_events',
) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
}

describe('R-INBOUND-012/013 durable inbound acceptance and recovery', () => {
  beforeEach(resetAndMigrate);
  afterEach(() => vi.restoreAllMocks());

  it('deduplicates concurrent accepts and processors atomically, including receive audit and attachment bytes', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const ctx = context();
    const ids = await Promise.all([
      acceptInboundReceipt(ctx, input(mailboxId)),
      acceptInboundReceipt(ctx, input(mailboxId)),
    ]);
    expect(ids[0]).toBe(ids[1]);
    const id = ids[0];
    if (!id) throw new Error('Missing receipt fixture');
    await Promise.all([processInboundReceipt(id, ctx), processInboundReceipt(id, ctx)]);
    await processInboundReceipt(id, ctx);
    expect(await count('messages')).toBe(1);
    expect(await count('message_recipients')).toBe(1);
    expect(await count('inbound_message_attachments')).toBe(1);
    expect(await count('audit_events')).toBe(1);
    expect(await count('inbound_receipts')).toBe(1);
    expect((await env.ATTACHMENTS.list({ prefix: 'raw-mime/' })).objects).toHaveLength(1);
    expect(await findInboundReceipt(env.DB, id)).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
  });

  it.each(['messages', 'audit_events'] as const)(
    'recovers after an atomic %s failure without partial mail or loss of raw MIME',
    async (table) => {
      const { mailboxId } = await seedInboundMailbox();
      const ctx = context();
      const id = await acceptInboundReceipt(ctx, input(mailboxId));
      await env.DB.exec(
        `CREATE TRIGGER fail_inbound BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`,
      );
      expect(await processInboundReceipt(id, ctx)).toEqual({ delaySeconds: 30 });
      expect(await findInboundReceipt(env.DB, id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_error_code: 'INBOUND_PROCESSING_FAILED',
      });
      for (const target of [
        'messages',
        'message_recipients',
        'inbound_message_attachments',
        'audit_events',
      ] as const)
        expect(await count(target)).toBe(0);
      expect(await env.ATTACHMENTS.get(`raw-mime/${id}`)).not.toBeNull();
      await env.DB.exec('DROP TRIGGER fail_inbound;');
      ctx.clock.advance(30_000);
      expect(await processInboundReceipt(id, ctx)).toBeUndefined();
      expect(await processInboundReceipt(id, ctx)).toBeUndefined();
      expect(await count('messages')).toBe(1);
      expect(await count('audit_events')).toBe(1);
      expect(await count('inbound_message_attachments')).toBe(1);
      expect(await findInboundReceipt(env.DB, id)).toMatchObject({
        status: 'completed',
        attempts: 2,
      });
    },
  );

  it('repairs a crash before enqueue and a failed recovery enqueue on the next bounded dispatch', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const ctx = context();
    const id = await acceptInboundReceipt(ctx, input(mailboxId));
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValue(undefined);
    await expect(recoverInboundReceipts({ ...ctx, queue: { send } })).rejects.toThrow('enqueue');
    await recoverInboundReceipts({ ...ctx, queue: { send } });
    expect(send).toHaveBeenCalledTimes(1);
    ctx.clock.advance(5 * 60_000);
    await recoverInboundReceipts({ ...ctx, queue: { send } });
    expect(send).toHaveBeenLastCalledWith({ kind: 'inbound', version: 1, receiptId: id });
    // Dispatch throttling must never postpone the processing eligibility itself.
    expect(await processInboundReceipt(id, ctx)).toBeUndefined();
    expect(await count('messages')).toBe(1);
  });

  it('bounds each recovery dispatch to 20 and continues from eligible remaining work', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const ctx = context();
    for (let index = 0; index < 21; index++)
      await acceptInboundReceipt(ctx, { ...input(mailboxId), to: `alias-${index}@example.test` });
    const send = vi.fn(async () => {});
    await recoverInboundReceipts({ ...ctx, queue: { send } });
    expect(send).toHaveBeenCalledTimes(20);
    await recoverInboundReceipts({ ...ctx, queue: { send } });
    expect(send).toHaveBeenCalledTimes(21);
  });

  it('does not acknowledge a failed durable reservation and can accept an upstream retry', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const ctx = context();
    await env.DB.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON inbound_receipts BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    await expect(acceptInboundReceipt(ctx, input(mailboxId))).rejects.toThrow();
    expect(await count('inbound_receipts')).toBe(0);
    expect(await count('messages')).toBe(0);
    await env.DB.exec('DROP TRIGGER fail_receipt;');
    const id = await acceptInboundReceipt(ctx, input(mailboxId));
    await processInboundReceipt(id, ctx);
    expect(await count('messages')).toBe(1);
  });

  it('reclaims an expired lease and rejects a stale worker finalization transaction', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const ctx = context();
    const id = await acceptInboundReceipt(ctx, input(mailboxId));
    expect(await claimInboundReceipt(env.DB, id, 'old-worker', ctx.clock.now())).not.toBeNull();
    ctx.clock.advance(INBOUND_LEASE_MS);
    expect(await claimInboundReceipt(env.DB, id, 'new-worker', ctx.clock.now())).not.toBeNull();
    await expect(
      env.DB.batch(prepareCompleteInboundReceipt(env.DB, id, 'old-worker', ctx.clock.now())),
    ).rejects.toThrow();
    expect(await findInboundReceipt(env.DB, id)).toMatchObject({
      status: 'processing',
      locked_by: 'new-worker',
    });
    ctx.clock.advance(INBOUND_LEASE_MS);
    const send = vi.fn(async () => {});
    await recoverInboundReceipts({ ...ctx, queue: { send } });
    await processInboundReceipt(id, ctx);
    expect(await count('messages')).toBe(1);
  });

  it('separates same Message-ID with changed bytes, sender, envelope recipient or mailbox', async () => {
    const { mailboxId, domainId, ownerId } = await seedInboundMailbox();
    const other = '30000000-0000-4000-8000-000000000002';
    await env.DB.prepare(
      "INSERT INTO mailboxes(id,domain_id,owner_user_id,local_part,status) VALUES (?,?,?,'other','active')",
    )
      .bind(other, domainId, ownerId)
      .run();
    const ctx = context();
    const original = input(mailboxId);
    const ids = await Promise.all([
      acceptInboundReceipt(ctx, original),
      acceptInboundReceipt(
        ctx,
        input(mailboxId, INBOUND_RAW_FIXTURE.replace('Fixture body', 'Changed body')),
      ),
      acceptInboundReceipt(ctx, { ...original, from: 'another@example.net' }),
      acceptInboundReceipt(ctx, { ...original, to: 'alias@example.test' }),
      acceptInboundReceipt(ctx, { ...original, mailboxId: other }),
    ]);
    expect(new Set(ids).size).toBe(5);
  });

  it('retains pending work beyond the completed dedup window and allows an identical new delivery after expiry', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const ctx = context();
    const id = await acceptInboundReceipt(ctx, input(mailboxId));
    ctx.clock.advance(INBOUND_DEDUP_WINDOW_MS + 1);
    await expireCompletedInboundReceipts(env.DB, ctx.clock.now());
    expect(await acceptInboundReceipt(ctx, input(mailboxId))).toBe(id);
    const requested = [
      `raw-mime/${id}`,
      ...Array.from({ length: 99 }, (_, i) => `raw-mime/missing-${i}`),
    ];
    expect(await findReferencedInboundObjectKeys(env.DB, 'raw-mime/', requested)).toEqual(
      new Set([`raw-mime/${id}`]),
    );
    await processInboundReceipt(id, ctx);
    ctx.clock.advance(INBOUND_DEDUP_WINDOW_MS);
    const newId = await acceptInboundReceipt(ctx, input(mailboxId));
    expect(newId).not.toBe(id);
    await processInboundReceipt(newId, ctx);
    expect(await count('messages')).toBe(2);
    ctx.clock.advance(INBOUND_DEDUP_WINDOW_MS);
    await expireCompletedInboundReceipts(env.DB, ctx.clock.now());
    expect(await count('inbound_receipts')).toBe(0);
    expect(await count('messages')).toBe(2);
  });

  it.each(['missing', 'corrupt'] as const)(
    'keeps %s raw work pending without creating visible mail',
    async (mode) => {
      const { mailboxId } = await seedInboundMailbox();
      const ctx = context();
      const id = await acceptInboundReceipt(ctx, input(mailboxId));
      if (mode === 'missing') await env.ATTACHMENTS.delete(`raw-mime/${id}`);
      else
        await env.ATTACHMENTS.put(
          `raw-mime/${id}`,
          new Uint8Array(input(mailboxId).raw.byteLength),
        );
      expect(await processInboundReceipt(id, ctx)).toEqual({ delaySeconds: 30 });
      expect(await count('messages')).toBe(0);
      expect(await findInboundReceipt(env.DB, id)).toMatchObject({ status: 'pending' });
    },
  );

  it('handles versioned inbound Queue work independently of outbound encryption credentials', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const ctx = context();
    const id = await acceptInboundReceipt(ctx, input(mailboxId));
    const ack = vi.fn(),
      retry = vi.fn();
    const batch = {
      messages: [{ body: { kind: 'inbound', version: 1, receiptId: id }, ack, retry }],
    } as unknown as MessageBatch<unknown>;
    const get = vi.fn(async () => {
      throw new Error('unavailable outbound secret');
    });
    await queueHandler.queue(batch, { ...env, CREDENTIAL_ENCRYPTION_KEY: { get } });
    expect(get).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(await count('messages')).toBe(1);
  });

  it('rejects unsupported queue envelope versions without processing or acknowledging them', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const id = await acceptInboundReceipt(context(), input(mailboxId));
    const ack = vi.fn(),
      retry = vi.fn();
    await queueHandler.queue(
      {
        messages: [{ body: { kind: 'inbound', version: 2, receiptId: id }, ack, retry }],
      } as unknown as MessageBatch<unknown>,
      env,
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await count('messages')).toBe(0);
  });

  it('R-DATA-004 repeats migration safely and passes the companion assertions with accepted mail', async () => {
    const { mailboxId } = await seedInboundMailbox();
    const ctx = context();
    const id = await acceptInboundReceipt(ctx, input(mailboxId));
    await processInboundReceipt(id, ctx);
    for (const sql of inboundMigration
      .replace(/^--.*$/gm, '')
      .split(';')
      .filter((sql) => sql.trim()))
      await env.DB.prepare(sql).run();
    for (const sql of inboundVerification.split(';').filter((sql) => sql.trim())) {
      const row = await env.DB.prepare(sql).first<{ assertion: string; pass: number }>();
      expect(row?.pass, row?.assertion).toBe(1);
    }
    expect(await findInboundReceipt(env.DB, id)).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
    await expect(
      env.DB.prepare("UPDATE inbound_receipts SET status='unknown' WHERE id=?").bind(id).run(),
    ).rejects.toThrow();
  });
});
