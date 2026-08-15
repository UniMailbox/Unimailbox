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
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
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
