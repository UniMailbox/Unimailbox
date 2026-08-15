// webhooks.worker.test.ts — CAP-024 POST /api/v1/webhooks/:providerKey/:connectionId.
//
// Worker-pool tests for the Brevo webhook receiver. Uses SELF.fetch to
// exercise the full pipeline: router → setup-gate → raw body read →
// HMAC-SHA256 verify (constant-time) → JSON parse → message status update
// → webhook_deliveries insert.
//
// Covers:
// - Valid signature → 200, message status 'delivered', webhook_deliveries row.
// - Invalid signature → 401 WEBHOOK_SIGNATURE_INVALID.
// - Missing X-Webhook-Signature → 401 WEBHOOK_SIGNATURE_MISSING.
// - Unknown connectionId → 404 WEBHOOK_CONNECTION_NOT_FOUND.
// - Connection exists but webhook_secret is NULL → 409 WEBHOOK_NOT_CONFIGURED.
// - Bounce event → message status 'bounced'.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

const WEBHOOK_SECRET = 'a'.repeat(64); // 64-char hex secret, matches production entropy.
const PROVIDER_MESSAGE_ID = '<202601011200.abc@example.com>';

// UUIDv4 regex — reused from request-id.test.ts so the format check stays
// in one place. AC4 / CAP-032.
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Computes HMAC-SHA256(body, secret) as a lowercase hex string — the exact
 * shape webhook-processor recomputes and constant-time compares against.
 */
async function computeHmac(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Seeds the fixtures a valid webhook needs to land on the happy path:
 *   installation_state complete, provider_connections row with a webhook
 *   secret, an encrypted_credentials stub (required FK), a messages row
 *   the webhook can update, and an outbound_jobs row carrying the
 *   provider_message_id the webhook echoes back.
 *
 * Returns the connectionId and messageId so each test can post to the
 * right URL and assert on the right row.
 */
async function seedConnectionAndMessage(
  overrides: { webhookSecret: string | null } = { webhookSecret: WEBHOOK_SECRET },
): Promise<{ connectionId: string; messageId: string }> {
  // INSERT OR IGNORE because some tests (notably the CAP-029 cross-tenant
  // IDOR regression test) seed two independent connections inside one test
  // — the second call would otherwise trip the PK on installation_state.
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO installation_state (id, status, current_step, schema_version, updated_at, created_at)
       VALUES (1, 'complete', 'complete', 1, ?, ?)`,
    )
    .bind(now, now)
    .run();

  const credentialId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const messageId = crypto.randomUUID();

  await env.DB.batch([
    // Stub encrypted_credentials row — the FK must exist; contents do not
    // matter for this test (we never send through the adapter here). iv /
    // auth_tag must satisfy the table's length CHECK constraints (12 / 16).
    env.DB.prepare(
      `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
       VALUES (?, ?, 1, X'00', X'000000000000000000000000', X'00000000000000000000000000000000', ?, ?)`,
    ).bind(credentialId, `cred-${connectionId}`, now, now),
    env.DB.prepare(
      `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, webhook_secret, created_at, updated_at)
       VALUES (?, 'brevo', ?, ?, 'active', ?, ?, ?)`,
    ).bind(connectionId, `conn-${connectionId}`, credentialId, overrides.webhookSecret, now, now),
    // A message the webhook will update. status starts as 'sent' so we can
    // assert the webhook flipped it to 'delivered' / 'bounced'.
    env.DB.prepare(
      `INSERT INTO messages (id, from_address, from_name, subject, html_body, text_body, references_header, status, created_at, updated_at)
       VALUES (?, 'sender@example.com', 'Sender', 'hello', '', '', '', 'sent', ?, ?)`,
    ).bind(messageId, now, now),
    // outbound_jobs row carrying the provider_message_id the webhook echoes.
    env.DB.prepare(
      `INSERT INTO outbound_jobs (id, message_id, provider_connection_id, status, provider_message_id, created_at, updated_at)
       VALUES (?, ?, ?, 'sent', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), messageId, connectionId, PROVIDER_MESSAGE_ID, now, now),
  ]);

  return { connectionId, messageId };
}

describe('POST /api/v1/webhooks/:providerKey/:connectionId', () => {
  beforeEach(async () => {
    await resetAndMigrate();
  });

  it('valid signature → 200, message updated to delivered, delivery row stored', async () => {
    const { connectionId, messageId } = await seedConnectionAndMessage();

    const body = JSON.stringify({
      event: 'delivered',
      messageId: PROVIDER_MESSAGE_ID,
    });
    const signature = await computeHmac(body, WEBHOOK_SECRET);

    const response = await SELF.fetch(
      `http://localhost/api/v1/webhooks/brevo/${connectionId}`,
      {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
      },
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ data: { ok: true } });

    // Message status flipped 'sent' → 'delivered'.
    const message = await env.DB
      .prepare('SELECT status FROM messages WHERE id = ?')
      .bind(messageId)
      .first<{ status: string }>();
    expect(message?.status).toBe('delivered');

    // webhook_deliveries row persisted with the raw payload verbatim.
    const delivery = await env.DB
      .prepare(
        'SELECT event_type, raw_payload, message_id, status FROM webhook_deliveries WHERE connection_id = ?',
      )
      .bind(connectionId)
      .first<{ event_type: string; raw_payload: string; message_id: string; status: string }>();
    expect(delivery?.event_type).toBe('delivered');
    expect(delivery?.raw_payload).toBe(body);
    expect(delivery?.message_id).toBe(messageId);
    expect(delivery?.status).toBe('processed');
  });

  it('invalid signature → 401 WEBHOOK_SIGNATURE_INVALID', async () => {
    const { connectionId } = await seedConnectionAndMessage();

    const body = JSON.stringify({ event: 'delivered', messageId: PROVIDER_MESSAGE_ID });
    // Wrong signature: HMAC of a different body.
    const signature = await computeHmac('tampered', WEBHOOK_SECRET);

    const response = await SELF.fetch(
      `http://localhost/api/v1/webhooks/brevo/${connectionId}`,
      {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
      },
    );

    expect(response.status).toBe(401);
    const responseBody = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(responseBody.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(responseBody.error.requestId).toMatch(UUID_V4_REGEX);

    // No delivery row should have been written for a rejected payload.
    const count = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM webhook_deliveries')
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('missing X-Webhook-Signature header → 401 WEBHOOK_SIGNATURE_MISSING', async () => {
    const { connectionId } = await seedConnectionAndMessage();

    const body = JSON.stringify({ event: 'delivered', messageId: PROVIDER_MESSAGE_ID });

    const response = await SELF.fetch(
      `http://localhost/api/v1/webhooks/brevo/${connectionId}`,
      {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
      },
    );

    expect(response.status).toBe(401);
    const responseBody = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(responseBody.error.code).toBe('WEBHOOK_SIGNATURE_MISSING');
    expect(responseBody.error.requestId).toMatch(UUID_V4_REGEX);
  });

  it('unknown connectionId → 404 WEBHOOK_CONNECTION_NOT_FOUND', async () => {
    // Seed so the setup gate passes, but POST against a random connection id.
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });

    const body = JSON.stringify({ event: 'delivered', messageId: PROVIDER_MESSAGE_ID });
    const signature = await computeHmac(body, WEBHOOK_SECRET);

    const response = await SELF.fetch(
      `http://localhost/api/v1/webhooks/brevo/${crypto.randomUUID()}`,
      {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
      },
    );

    expect(response.status).toBe(404);
    const responseBody = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(responseBody.error.code).toBe('WEBHOOK_CONNECTION_NOT_FOUND');
    expect(responseBody.error.requestId).toMatch(UUID_V4_REGEX);
  });

  it('connection without webhook_secret → 409 WEBHOOK_NOT_CONFIGURED', async () => {
    const { connectionId } = await seedConnectionAndMessage({ webhookSecret: null });

    const body = JSON.stringify({ event: 'delivered', messageId: PROVIDER_MESSAGE_ID });
    const signature = await computeHmac(body, WEBHOOK_SECRET);

    const response = await SELF.fetch(
      `http://localhost/api/v1/webhooks/brevo/${connectionId}`,
      {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
      },
    );

    expect(response.status).toBe(409);
    const responseBody = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(responseBody.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
    expect(responseBody.error.requestId).toMatch(UUID_V4_REGEX);
  });

  it('bounce event → message status "bounced"', async () => {
    const { connectionId, messageId } = await seedConnectionAndMessage();

    const body = JSON.stringify({
      event: 'bounce',
      messageId: PROVIDER_MESSAGE_ID,
    });
    const signature = await computeHmac(body, WEBHOOK_SECRET);

    const response = await SELF.fetch(
      `http://localhost/api/v1/webhooks/brevo/${connectionId}`,
      {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
      },
    );

    expect(response.status).toBe(200);

    const message = await env.DB
      .prepare('SELECT status FROM messages WHERE id = ?')
      .bind(messageId)
      .first<{ status: string }>();
    expect(message?.status).toBe('bounced');

    const delivery = await env.DB
      .prepare('SELECT event_type FROM webhook_deliveries WHERE connection_id = ?')
      .bind(connectionId)
      .first<{ event_type: string }>();
    expect(delivery?.event_type).toBe('bounce');
  });
});

describe('POST /api/v1/webhooks ordering (CAP-029 / R-MESSAGE-007)', () => {
  beforeEach(async () => {
    await resetAndMigrate();
  });

  /**
   * Returns the stored message status, provider_event_time, and the last
   * webhook_delivery row's event_time + event_time_source — the trio an
   * operator inspects when triaging a mis-ordering incident.
   */
  async function readState(messageId: string, connectionId: string) {
    const message = await env.DB
      .prepare(
        'SELECT status, provider_event_time FROM messages WHERE id = ?',
      )
      .bind(messageId)
      .first<{ status: string; provider_event_time: number | null }>();
    const delivery = await env.DB
      .prepare(
        'SELECT event_type, event_time, event_time_source FROM webhook_deliveries WHERE connection_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .bind(connectionId)
      .first<{
        event_type: string;
        event_time: number | null;
        event_time_source: string | null;
      }>();
    return { message, delivery };
  }

  async function postEvent(
    connectionId: string,
    event: Record<string, unknown>,
  ): Promise<Response> {
    const body = JSON.stringify(event);
    const signature = await computeHmac(body, WEBHOOK_SECRET);
    return SELF.fetch(
      `http://localhost/api/v1/webhooks/brevo/${connectionId}`,
      {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
      },
    );
  }

  it('A2: a strictly newer event of any rank wins over an older one (event-time gate)', async () => {
    const { connectionId, messageId } = await seedConnectionAndMessage();

    // First, a bounce at t=100 (terminal, rank 100).
    const tBounce = 100_000;
    const r1 = await postEvent(connectionId, {
      event: 'bounce',
      messageId: PROVIDER_MESSAGE_ID,
      ts: tBounce / 1000,
    });
    expect(r1.status).toBe(200);
    let state = await readState(messageId, connectionId);
    expect(state.message?.status).toBe('bounced');
    expect(state.message?.provider_event_time).toBe(tBounce);
    expect(state.delivery?.event_time_source).toBe('provider');

    // Then a delivered at t=200 (newer, lower rank). The contract is: a
    // strictly newer event wins regardless of rank. The equal-time +
    // lower-rank gate is the only rejection case.
    const tDelivered = 200_000;
    const r2 = await postEvent(connectionId, {
      event: 'delivered',
      messageId: PROVIDER_MESSAGE_ID,
      ts: tDelivered / 1000,
    });
    expect(r2.status).toBe(200);
    state = await readState(messageId, connectionId);
    expect(state.message?.status).toBe('delivered');
    expect(state.message?.provider_event_time).toBe(tDelivered);
  });

  it('A3: an older delivered after a terminal bounced is rejected (older event)', async () => {
    const { connectionId, messageId } = await seedConnectionAndMessage();

    // First, a terminal bounce at t=200.
    const tBounce = 200_000;
    await postEvent(connectionId, {
      event: 'bounce',
      messageId: PROVIDER_MESSAGE_ID,
      ts: tBounce / 1000,
    });
    let state = await readState(messageId, connectionId);
    expect(state.message?.status).toBe('bounced');

    // Now an older delivered at t=100 — this is the canonical out-of-order
    // case the predicate must reject. The earlier delivered arrived before
    // the bounce but the bounce is newer.
    const tDelivered = 100_000;
    const r = await postEvent(connectionId, {
      event: 'delivered',
      messageId: PROVIDER_MESSAGE_ID,
      ts: tDelivered / 1000,
    });
    expect(r.status).toBe(200); // webhook itself is fine; it just doesn't apply
    state = await readState(messageId, connectionId);
    expect(state.message?.status).toBe('bounced'); // unchanged
    expect(state.message?.provider_event_time).toBe(tBounce); // unchanged
  });

  it('A4: equal-time + lower-rank event is rejected (terminal-state promotion gate)', async () => {
    const { connectionId, messageId } = await seedConnectionAndMessage();

    // Two events with the same timestamp. First, delivered. Then a bounce at
    // the same instant — should win because bounced is terminal (rank 100)
    // and delivered is rank 80.
    const t = 300_000;
    await postEvent(connectionId, {
      event: 'delivered',
      messageId: PROVIDER_MESSAGE_ID,
      ts: t / 1000,
    });
    let state = await readState(messageId, connectionId);
    expect(state.message?.status).toBe('delivered');
    expect(state.message?.provider_event_time).toBe(t);

    // Bounce at the SAME instant — terminal-state promotion must apply.
    const r = await postEvent(connectionId, {
      event: 'bounce',
      messageId: PROVIDER_MESSAGE_ID,
      ts: t / 1000,
    });
    expect(r.status).toBe(200);
    state = await readState(messageId, connectionId);
    expect(state.message?.status).toBe('bounced');
    expect(state.message?.provider_event_time).toBe(t);
  });

  it('A5: webhook without ts/time falls back to server clock and the audit row records server source', async () => {
    const { connectionId, messageId } = await seedConnectionAndMessage();

    const r = await postEvent(connectionId, {
      event: 'delivered',
      messageId: PROVIDER_MESSAGE_ID,
    });
    expect(r.status).toBe(200);
    const state = await readState(messageId, connectionId);
    expect(state.message?.status).toBe('delivered');
    expect(state.delivery?.event_time_source).toBe('server');
    // The message row stores the server-side ts too.
    expect(state.message?.provider_event_time).toBeGreaterThan(0);
    expect(state.message?.provider_event_time).toBe(Number(state.delivery?.event_time));
  });

  // CAP-029 H1 Security review-triage (R-AUTHZ-004 cross-tenant IDOR):
  // when two distinct provider connections both have an outbound_jobs row
  // that shares the same `provider_message_id` (a realistic collision:
  // Brevo IDs are global, and two tenants could in principle reuse an ID
  // string — though ours are UUIDs and shouldn't collide in practice, the
  // lookup must not silently trust the global), a webhook to connection A
  // must not update the message row owned by connection B. Before the fix
  // the repository's `findJobByProviderMessageId` queried by message id
  // alone — the first match won, regardless of connection.
  it('cross-tenant: webhook to connection A does NOT update the message owned by connection B when provider_message_id collides', async () => {
    // Two independent connections with their own messages and their own
    // outbound_jobs rows — both carrying the SAME provider_message_id.
    const { connectionId: connectionIdA, messageId: messageIdA } = await seedConnectionAndMessage();
    const { connectionId: connectionIdB, messageId: messageIdB } = await seedConnectionAndMessage();

    // Both jobs carry the same provider_message_id. The fix must scope the
    // lookup to the receiving connection.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE outbound_jobs SET provider_message_id = ? WHERE message_id = ?`,
      ).bind(PROVIDER_MESSAGE_ID, messageIdA),
      env.DB.prepare(
        `UPDATE outbound_jobs SET provider_message_id = ? WHERE message_id = ?`,
      ).bind(PROVIDER_MESSAGE_ID, messageIdB),
    ]);

    // Sanity: confirm the collision is in place — both jobs have the same id.
    const collision = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM outbound_jobs WHERE provider_message_id = ?`,
      )
      .bind(PROVIDER_MESSAGE_ID)
      .first<{ n: number }>();
    expect(collision?.n).toBe(2);

    // POST a webhook to connection A. The signature is computed for A's secret.
    const body = JSON.stringify({
      event: 'delivered',
      messageId: PROVIDER_MESSAGE_ID,
    });
    const signatureA = await computeHmac(body, WEBHOOK_SECRET);
    const responseA = await SELF.fetch(
      `http://localhost/api/v1/webhooks/brevo/${connectionIdA}`,
      {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signatureA,
        },
      },
    );
    expect(responseA.status).toBe(200);

    // Message A flipped 'sent' → 'delivered' — the legitimate owner.
    const messageA = await env.DB
      .prepare('SELECT status FROM messages WHERE id = ?')
      .bind(messageIdA)
      .first<{ status: string }>();
    expect(messageA?.status).toBe('delivered');

    // Message B is unchanged — the IDOR is closed. A pre-fix implementation
    // would have flipped B too because the lookup ignored connection_id.
    const messageB = await env.DB
      .prepare('SELECT status FROM messages WHERE id = ?')
      .bind(messageIdB)
      .first<{ status: string }>();
    expect(messageB?.status).toBe('sent');

    // Audit trail: only connection A has a delivery row.
    const deliveriesA = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE connection_id = ?')
      .bind(connectionIdA)
      .first<{ n: number }>();
    const deliveriesB = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE connection_id = ?')
      .bind(connectionIdB)
      .first<{ n: number }>();
    expect(deliveriesA?.n).toBe(1);
    expect(deliveriesB?.n).toBe(0);
  });

  // CAP-029 H1 Code review-triage: extractBrevoEventTimeMs used to apply a
  // magnitude heuristic (`> 1e12 ? ms : s*1000`) which silently misclassified
  // microseconds, nanoseconds, and "post-2286 seconds" values. The fix
  // discriminates by *format* (integer + threshold, ISO string, fallback).
  // Exercised through the public API: the resulting `provider_event_time`
  // on the messages row and `event_time` on the delivery row reveal which
  // path fired.
  describe('extractBrevoEventTimeMs — format-based discrimination', () => {
    it('integer seconds (≤ 10^10) are multiplied by 1000', async () => {
      const { connectionId, messageId } = await seedConnectionAndMessage();
      const SECONDS = 1_700_000_000; // 2023-11-14 in seconds
      const MS = SECONDS * 1000;
      await postEvent(connectionId, {
        event: 'delivered',
        messageId: PROVIDER_MESSAGE_ID,
        ts: SECONDS,
      });
      const state = await readState(messageId, connectionId);
      expect(state.message?.provider_event_time).toBe(MS);
      expect(state.delivery?.event_time).toBe(MS);
      expect(state.delivery?.event_time_source).toBe('provider');
    });

    it('integer ms (> 10^10) are passed through unchanged', async () => {
      const { connectionId, messageId } = await seedConnectionAndMessage();
      const MS = 1_700_000_000_000; // post-2286 seconds would also land here
      await postEvent(connectionId, {
        event: 'delivered',
        messageId: PROVIDER_MESSAGE_ID,
        ts: MS,
      });
      const state = await readState(messageId, connectionId);
      expect(state.message?.provider_event_time).toBe(MS);
      expect(state.delivery?.event_time).toBe(MS);
      expect(state.delivery?.event_time_source).toBe('provider');
    });

    it('integer 0 is rejected and falls back to server time', async () => {
      const { connectionId, messageId } = await seedConnectionAndMessage();
      await postEvent(connectionId, {
        event: 'delivered',
        messageId: PROVIDER_MESSAGE_ID,
        ts: 0,
      });
      const state = await readState(messageId, connectionId);
      // Server fallback — value is Date.now() at request time, > 0.
      expect(state.delivery?.event_time_source).toBe('server');
      expect(state.message?.provider_event_time).toBeGreaterThan(0);
      // The fallback path stores the server time, not 0.
      expect(state.message?.provider_event_time).not.toBe(0);
    });

    it('fractional numbers are rejected and fall back to server time', async () => {
      const { connectionId, messageId } = await seedConnectionAndMessage();
      await postEvent(connectionId, {
        event: 'delivered',
        messageId: PROVIDER_MESSAGE_ID,
        ts: 1_700_000_000.5,
      });
      const state = await readState(messageId, connectionId);
      expect(state.delivery?.event_time_source).toBe('server');
      expect(state.message?.provider_event_time).toBeGreaterThan(0);
    });

    it('boolean is rejected and falls back to server time', async () => {
      const { connectionId, messageId } = await seedConnectionAndMessage();
      await postEvent(connectionId, {
        event: 'delivered',
        messageId: PROVIDER_MESSAGE_ID,
        ts: true,
      });
      const state = await readState(messageId, connectionId);
      expect(state.delivery?.event_time_source).toBe('server');
    });

    it('null is rejected and falls back to server time', async () => {
      const { connectionId, messageId } = await seedConnectionAndMessage();
      await postEvent(connectionId, {
        event: 'delivered',
        messageId: PROVIDER_MESSAGE_ID,
        ts: null,
      });
      const state = await readState(messageId, connectionId);
      expect(state.delivery?.event_time_source).toBe('server');
    });

    it('object is rejected and falls back to server time', async () => {
      const { connectionId, messageId } = await seedConnectionAndMessage();
      await postEvent(connectionId, {
        event: 'delivered',
        messageId: PROVIDER_MESSAGE_ID,
        ts: { foo: 'bar' },
      });
      const state = await readState(messageId, connectionId);
      expect(state.delivery?.event_time_source).toBe('server');
    });

    it('ISO 8601 string is parsed as provider-supplied ms', async () => {
      const { connectionId, messageId } = await seedConnectionAndMessage();
      const ISO = '2026-08-15T12:00:00.000Z';
      const MS = Date.parse(ISO);
      await postEvent(connectionId, {
        event: 'delivered',
        messageId: PROVIDER_MESSAGE_ID,
        time: ISO,
      });
      const state = await readState(messageId, connectionId);
      expect(state.delivery?.event_time_source).toBe('provider');
      expect(state.message?.provider_event_time).toBe(MS);
    });

    it('non-ISO string is rejected and falls back to server time', async () => {
      const { connectionId, messageId } = await seedConnectionAndMessage();
      await postEvent(connectionId, {
        event: 'delivered',
        messageId: PROVIDER_MESSAGE_ID,
        time: 'not-a-date',
      });
      const state = await readState(messageId, connectionId);
      expect(state.delivery?.event_time_source).toBe('server');
    });
  });
});
