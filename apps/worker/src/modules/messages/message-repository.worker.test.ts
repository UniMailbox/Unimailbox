// message-repository.worker.test.ts — CAP-029 / R-MESSAGE-007.
//
// Worker-pool tests for updateMessageStatus, the rank-aware writer that is
// the single public surface for outbound-mail to transition messages.status
// (D-CAP-028-D). Covers the predicate in isolation against real D1 so a
// regression in the SQL is caught before the queue consumer / webhook
// processor routes a real event through it.
//
// Cases (CAP-029 A1–A4):
//   A1  baseline — empty history accepts any status
//   A2  older event after a higher-rank new one → REJECTED
//   A3  older event after a lower-rank new one  → REJECTED
//   A4  equal event time + higher rank          → applied (terminal-state promotion)
//   tie: equal event time + same rank           → REJECTED (no-op re-write)
//   tie: equal event time + lower rank          → REJECTED
//   sent_at: once-set is never overwritten (COALESCE)
//
// .claude/rules/testing.md §Mocking: D1 is real (worker pool), no mocks.

import { describe, expect, it, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { STATUS_RANK_TABLE } from '@unimailbox/contracts';
import { updateMessageStatus } from './message-repository';

const NOW = '2026-01-01 12:00:00';

async function seedMessage(
  overrides: { status?: string; providerEventTimeMs?: number | null; sentAt?: string | null } = {},
): Promise<string> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO messages (
      id, from_address, from_name, subject, html_body, text_body,
      references_header, status, provider_event_time, sent_at,
      created_at, updated_at
    ) VALUES (
      ?, 'sender@example.com', 'Sender', 'hello', '', '',
      '', ?, ?, ?,
      ?, ?
    )`,
  ).bind(
    id,
    overrides.status ?? 'sent',
    overrides.providerEventTimeMs ?? null,
    overrides.sentAt ?? null,
    NOW,
    NOW,
  ).run();
  return id;
}

interface MessageRow {
  readonly status: string;
  readonly provider_event_time: number | null;
  readonly sent_at: string | null;
  readonly updated_at: string;
}

async function readMessage(id: string): Promise<MessageRow> {
  const row = await env.DB
    .prepare('SELECT status, provider_event_time, sent_at, updated_at FROM messages WHERE id = ?')
    .bind(id)
    .first<MessageRow>();
  if (!row) throw new Error(`message ${id} not found`);
  return row;
}

describe('updateMessageStatus — R-MESSAGE-007 rank-aware predicate', () => {
  beforeEach(async () => {
    await resetAndMigrate();
  });

  it('A1: empty history accepts the first status update', async () => {
    const id = await seedMessage();
    const applied = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'delivered',
      providerEventTimeMs: 1_000,
      now: NOW,
    });
    expect(applied).toBe(true);
    const row = await readMessage(id);
    expect(row.status).toBe('delivered');
    expect(row.provider_event_time).toBe(1_000);
  });

  it('A2: an older event arriving after a higher-rank new one is REJECTED', async () => {
    // Seed at 'delivered' with t=200 (rank 80). An older 'sent' (rank 20)
    // at t=100 arrives → must NOT overwrite.
    const id = await seedMessage({ status: 'delivered', providerEventTimeMs: 200 });
    const applied = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'sent',
      providerEventTimeMs: 100,
      now: NOW,
    });
    expect(applied).toBe(false);
    const row = await readMessage(id);
    expect(row.status).toBe('delivered'); // unchanged
    expect(row.provider_event_time).toBe(200); // unchanged
  });

  it('A3: an older event arriving after a lower-rank new one is REJECTED', async () => {
    // Seed at 'sent' (rank 20) with t=200. A newer 'delivered' (rank 80) at
    // t=300 applies; then an older 'sent' (rank 20) at t=100 arrives → must
    // NOT clobber the newer delivered.
    const id = await seedMessage({ status: 'sent', providerEventTimeMs: 200 });
    const newer = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'delivered',
      providerEventTimeMs: 300,
      now: NOW,
    });
    expect(newer).toBe(true);
    const after = await readMessage(id);
    expect(after.status).toBe('delivered');

    const older = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'sent',
      providerEventTimeMs: 100,
      now: NOW,
    });
    expect(older).toBe(false);
    const row = await readMessage(id);
    expect(row.status).toBe('delivered'); // unchanged
    expect(row.provider_event_time).toBe(300); // unchanged
  });

  it('A4: equal event time + higher rank is applied (terminal-state promotion)', async () => {
    // Seed at 'delivered' (rank 80) with t=500. A 'bounced' (rank 100) at
    // the same t=500 must apply — the rank tie-breaker promotes to terminal.
    const id = await seedMessage({ status: 'delivered', providerEventTimeMs: 500 });
    const applied = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'bounced',
      providerEventTimeMs: 500,
      now: NOW,
    });
    expect(applied).toBe(true);
    const row = await readMessage(id);
    expect(row.status).toBe('bounced');
    expect(row.provider_event_time).toBe(500);
  });

  it('equal event time + same rank is REJECTED (no-op re-write)', async () => {
    const id = await seedMessage({ status: 'delivered', providerEventTimeMs: 500 });
    const applied = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'delivered',
      providerEventTimeMs: 500,
      now: NOW,
    });
    expect(applied).toBe(false);
    const row = await readMessage(id);
    expect(row.status).toBe('delivered');
  });

  it('equal event time + lower rank is REJECTED', async () => {
    // Seed at 'bounced' (rank 100) with t=500. A 'delivered' (rank 80) at
    // the same t=500 must NOT apply — the terminal state is sticky.
    const id = await seedMessage({ status: 'bounced', providerEventTimeMs: 500 });
    const applied = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'delivered',
      providerEventTimeMs: 500,
      now: NOW,
    });
    expect(applied).toBe(false);
    const row = await readMessage(id);
    expect(row.status).toBe('bounced');
  });

  it('a newer event of any rank always wins (strict-less-time branch)', async () => {
    // Seed at 'bounced' (rank 100) with t=200. A strictly-newer event of any
    // rank applies. This is the recovery path: a terminal-then-resent edge
    // case where the provider issues a 'sent' confirmation AFTER the bounce.
    const id = await seedMessage({ status: 'bounced', providerEventTimeMs: 200 });
    const applied = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'sent',
      providerEventTimeMs: 300,
      now: NOW,
    });
    expect(applied).toBe(true);
    const row = await readMessage(id);
    expect(row.status).toBe('sent');
    expect(row.provider_event_time).toBe(300);
  });

  it('sent_at is never overwritten when a later update omits it (COALESCE)', async () => {
    const id = await seedMessage({ status: 'queued', sentAt: '2026-01-01 12:00:00' });
    // Simulate the queue consumer's post-send write.
    const sent = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'sent',
      providerEventTimeMs: 1_000,
      sentAt: '2026-01-01 12:00:01',
      now: NOW,
    });
    expect(sent).toBe(true);
    let row = await readMessage(id);
    expect(row.sent_at).toBe('2026-01-01 12:00:01');

    // Now a webhook 'delivered' at a newer time — sent_at must NOT change.
    const delivered = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'delivered',
      providerEventTimeMs: 2_000,
      now: '2026-01-01 12:00:02',
    });
    expect(delivered).toBe(true);
    row = await readMessage(id);
    expect(row.status).toBe('delivered');
    expect(row.sent_at).toBe('2026-01-01 12:00:01'); // COALESCE preserved
  });

  it('returns false when the message id does not exist (no row to update)', async () => {
    const applied = await updateMessageStatus(env.DB, {
      messageId: '00000000-0000-0000-0000-000000000000',
      status: 'delivered',
      providerEventTimeMs: 1_000,
      now: NOW,
    });
    expect(applied).toBe(false);
  });

  // CAP-029 Arch M1 / Security M3 review-triage: the SQL CASE in
  // `updateMessageStatus` (lines 218–228) must stay in sync with
  // STATUS_RANK_TABLE in packages/contracts/src/index.ts. The contracts-side
  // test pins the table to a literal EXPECTED_PAIRS; this test pins the
  // SQL-side behaviour against the same table. For every [status, rank] pair,
  // a same-time `delivered` update applies iff rank < 80 (delivered's rank)
  // and is rejected iff rank >= 80. If you change STATUS_RANK_TABLE, also
  // change the SQL CASE — these tests will fail loudly in that case.
  it('SQL CASE rank predicate is consistent with STATUS_RANK_TABLE for every status', async () => {
    // Seed installation_state once before the loop — seedMessage() also seeds
    // it but the second INSERT would violate the PK constraint when called
    // multiple times in one test.
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    const DELIVERED_RANK = 80;
    for (const [seedStatus, rank] of STATUS_RANK_TABLE) {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO messages (
          id, from_address, from_name, subject, html_body, text_body,
          references_header, status, provider_event_time, sent_at,
          created_at, updated_at
        ) VALUES (
          ?, 'sender@example.com', 'Sender', 'hello', '', '',
          '', ?, 500, NULL,
          ?, ?
        )`,
      ).bind(id, seedStatus, NOW, NOW).run();
      const applied = await updateMessageStatus(env.DB, {
        messageId: id,
        status: 'delivered',
        providerEventTimeMs: 500, // same time → only rank decides
        now: NOW,
      });
      const shouldApply = rank < DELIVERED_RANK;
      expect(applied, `status=${seedStatus} rank=${rank}`).toBe(shouldApply);
      // Verify the row reflects the outcome — guards against a false-positive
      // where the predicate accepts but the row was not actually updated.
      const row = await readMessage(id);
      expect(row.status, `status=${seedStatus} rank=${rank}`).toBe(shouldApply ? 'delivered' : seedStatus);
    }
  });
});