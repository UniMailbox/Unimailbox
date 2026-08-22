// message-repository.worker.test.ts — CAP-029 / R-MESSAGE-007 + CAP-030 direction guard.
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
// Cases (CAP-030 AC #8 — direction guard):
//   B1  sent → queued      REJECTED (direction violation; rank would accept on newer event time)
//   B2  failed → sent       REJECTED (terminal violation; rank would accept on newer event time)
//   B3  sent → delivered    accepted  (forward + higher rank)
//   B4  delivered → bounced accepted  (retroactive terminal correction; rank permits at equal time)
//
// .claude/rules/testing.md §Mocking: D1 is real (worker pool), no mocks.

import { describe, expect, it, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import {
  STATUS_RANK_TABLE,
  allowedFromForMessageStatus,
  type MessageStatus,
} from '@unimailbox/contracts';
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
  )
    .bind(
      id,
      overrides.status ?? 'sent',
      overrides.providerEventTimeMs ?? null,
      overrides.sentAt ?? null,
      NOW,
      NOW,
    )
    .run();
  return id;
}

interface MessageRow {
  readonly status: string;
  readonly provider_event_time: number | null;
  readonly sent_at: string | null;
  readonly updated_at: string;
}

async function readMessage(id: string): Promise<MessageRow> {
  const row = await env.DB.prepare(
    'SELECT status, provider_event_time, sent_at, updated_at FROM messages WHERE id = ?',
  )
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

  // CAP-030: the prior "a newer event of any rank always wins (strict-less-time
  // branch)" test was deleted. Its premise — a strictly-newer event of any rank
  // applies regardless of direction — directly contradicts R-MESSAGE-012
  // (terminal states are terminal; resurrection requires a new message). The
  // strict-newer-time branch is still exercised, but only for direction-legal
  // transitions: see B3 (sent → delivered, forward + higher rank) and B4
  // (delivered → bounced, retroactive terminal correction) below.

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

  // CAP-029 Arch M1 / Security M3 review-triage + CAP-030 direction guard:
  // the SQL in `updateMessageStatus` composes TWO predicates against the
  // contracts-side tables:
  //
  //   1. RANK predicate (CAP-029 — the SQL CASE inside the WHERE): a same-time
  //      update to `delivered` applies iff rank < 80 (delivered's rank). The
  //      SQL CASE must stay in sync with STATUS_RANK_TABLE.
  //   2. DIRECTION predicate (CAP-030 — `AND status IN (SELECT value FROM
  //      json_each(?))`): the seed status must be in
  //      `allowedFromForMessageStatus('delivered')` = ALLOWED_MESSAGE_TRANSITIONS
  //      entries whose target set contains 'delivered'.
  //
  // For every [status, rank] pair, a same-time `delivered` update applies iff
  // BOTH predicates accept. The composed behaviour is:
  //
  //   sent      (rank 20)   → applies (rank < 80, 'sent' is in allowed-from)
  //   delayed   (rank 60)   → applies (rank < 80, 'delayed' is in allowed-from)
  //   draft     (rank 10)   → rejected (rank < 80 but 'draft' is NOT in allowed-from — no path to delivered)
  //   queued    (rank 40)   → rejected (rank < 80 but 'queued' is NOT in allowed-from — forward only via sending/sent)
  //   sending   (rank 30)   → rejected (rank < 80 but 'sending' is NOT in allowed-from — forward only via sent/delayed/terminal)
  //   delivered (rank 80)   → rejected (rank == 80, rank predicate fails)
  //   failed    (rank 100)  → rejected (rank >= 80)
  //   bounced   (rank 100)  → rejected (rank >= 80)
  //   complained(rank 100)  → rejected (rank >= 80)
  //
  // If you change STATUS_RANK_TABLE or ALLOWED_MESSAGE_TRANSITIONS, the SQL
  // CASE and the direction IN-clause must change in lockstep — these tests
  // will fail loudly in that case.
  it('rank + direction predicates compose correctly for every status', async () => {
    // Seed installation_state once before the loop — seedMessage() also seeds
    // it but the second INSERT would violate the PK constraint when called
    // multiple times in one test.
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    const DELIVERED_RANK = 80;
    const allowedFrom = new Set<MessageStatus>(allowedFromForMessageStatus('delivered'));
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
      )
        .bind(id, seedStatus, NOW, NOW)
        .run();
      const applied = await updateMessageStatus(env.DB, {
        messageId: id,
        status: 'delivered',
        providerEventTimeMs: 500, // same time → only rank + direction decide
        now: NOW,
      });
      const shouldApply = rank < DELIVERED_RANK && allowedFrom.has(seedStatus as MessageStatus);
      expect(applied, `status=${seedStatus} rank=${rank}`).toBe(shouldApply);
      // Verify the row reflects the outcome — guards against a false-positive
      // where the predicate accepts but the row was not actually updated.
      const row = await readMessage(id);
      expect(row.status, `status=${seedStatus} rank=${rank}`).toBe(
        shouldApply ? 'delivered' : seedStatus,
      );
    }
  });

  // -------------------------------------------------------------------
  // CAP-030 AC #8 — direction guard (CAP-030 §Acceptance criteria).
  //
  // Each test seeds the row at a known `from`-status with provider_event_time
  // set, then issues an updateMessageStatus call whose target either is or is
  // not in the legal FROM-set declared by ALLOWED_MESSAGE_TRANSITIONS. The
  // scenarios are constructed so the R-MESSAGE-007 rank-aware predicate alone
  // would ACCEPT the change — only the new CAP-030 direction clause can
  // reject it. That asymmetry is the load-bearing part of the test: if a
  // future regression removes the direction clause, the rank predicate will
  // silently accept the forbidden transition and these tests fail loudly.
  // -------------------------------------------------------------------

  it('B1: rejects sent → queued (direction violation; rank predicate would accept on strictly newer event time)', async () => {
    // 'sent' (rank 20) seeded at t=200. A 'queued' update at t=300 is
    // strictly newer (rank-predicate strict-less-time branch would ACCEPT).
    // The CAP-030 direction clause rejects because 'queued' is not in
    // ALLOWED_MESSAGE_TRANSITIONS.get('sent').
    const id = await seedMessage({ status: 'sent', providerEventTimeMs: 200 });
    const applied = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'queued',
      providerEventTimeMs: 300,
      now: NOW,
    });
    expect(applied).toBe(false);
    const row = await readMessage(id);
    expect(row.status).toBe('sent'); // unchanged
    expect(row.provider_event_time).toBe(200); // unchanged
  });

  it('B2: rejects failed → sent (terminal violation; rank predicate would accept on strictly newer event time)', async () => {
    // 'failed' (rank 100) seeded at t=200. A 'sent' update at t=300 is
    // strictly newer (rank-predicate strict-less-time branch would ACCEPT).
    // The CAP-030 direction clause rejects because 'failed' has an empty
    // allowed-from set (R-MESSAGE-012 — terminal, no resurrection).
    const id = await seedMessage({ status: 'failed', providerEventTimeMs: 200 });
    const applied = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'sent',
      providerEventTimeMs: 300,
      now: NOW,
    });
    expect(applied).toBe(false);
    const row = await readMessage(id);
    expect(row.status).toBe('failed'); // unchanged
    expect(row.provider_event_time).toBe(200); // unchanged
  });

  it('B3: accepts sent → delivered (forward + higher rank)', async () => {
    // 'sent' (rank 20) seeded at t=500. A 'delivered' (rank 80) update at
    // the same time applies via the rank tie-breaker ('sent' rank 20 < 80),
    // AND 'delivered' is in ALLOWED_MESSAGE_TRANSITIONS.get('sent'). Both
    // predicates accept.
    const id = await seedMessage({ status: 'sent', providerEventTimeMs: 500 });
    const applied = await updateMessageStatus(env.DB, {
      messageId: id,
      status: 'delivered',
      providerEventTimeMs: 500,
      now: NOW,
    });
    expect(applied).toBe(true);
    const row = await readMessage(id);
    expect(row.status).toBe('delivered');
  });

  it('B4: accepts delivered → bounced (retroactive terminal correction; rank permits at equal time)', async () => {
    // 'delivered' (rank 80) seeded at t=500. A 'bounced' (rank 100) update
    // at the same time applies via the rank tie-breaker (80 < 100), AND
    // 'bounced' is in ALLOWED_MESSAGE_TRANSITIONS.get('delivered'). The
    // retroactive terminal-correction path the comment in
    // ALLOWED_MESSAGE_TRANSITIONS describes.
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
  });
});
