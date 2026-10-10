// audit-events.worker.test.ts — CAP-026.
//
// Worker-pool tests verifying that every state transition in the business
// loop writes an audit_events row. Each test exercises the full pipeline
// (SELF.fetch or direct handler call), then queries audit_events directly.
//
// Covers the six emit points:
//   setup.claim, setup.complete, mailbox.create,
//   message.receive, message.send, webhook.delivered

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword, importEncryptionKey, encrypt } from '../../platform/crypto';
import inboundEmail from '../../entrypoints/inbound-email';

const ENCRYPTION_KEY = 'a'.repeat(64);
const WEBHOOK_SECRET = 'a'.repeat(64);
const PROVIDER_MESSAGE_ID = '<202601011200.abc@example.com>';

// UUIDv4 regex — reused from request-id.test.ts so the format check stays
// in one place. AC4 / CAP-032.
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Shared seeding helpers (same patterns as mailboxes/compose/webhooks tests)
// ---------------------------------------------------------------------------

async function completeSetupSeed(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('message.read', 'message.read', 'Read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('message.send', 'message.send', 'Send', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('mailbox.create', 'mailbox.create', 'Create', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('role.manage', 'role.manage', 'Manage roles', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'message.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'message.send', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'mailbox.create', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'role.manage', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('member', 'message.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('member', 'message.send', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('member', 'mailbox.create', datetime('now'))`,
    ),
  ]);
}

async function hashToken(token: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function createUserWithRole(
  roleName: 'administrator' | 'member',
  email: string,
): Promise<string> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('testPassword123');
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      email,
      `${roleName} user`,
      'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(`INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)`).bind(
      userId,
      roleName,
      now,
    ),
  ]);

  return userId;
}

async function createSession(userId: string): Promise<string> {
  const accessToken = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();
  const refreshTokenHash = await hashToken(refreshToken);
  const sessionId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, userId, refreshTokenHash, expiresAt, new Date().toISOString())
    .run();

  await env.CACHE.put(`auth:${accessToken}`, JSON.stringify({ userId, sessionId }), {
    expirationTtl: 15 * 60,
  });

  return accessToken;
}

async function createDomain(name = 'example.com'): Promise<string> {
  const domainId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
     VALUES (?, ?, 'active', NULL, ?, ?)`,
  )
    .bind(domainId, name, now, now)
    .run();
  return domainId;
}

async function createActiveProviderConnection(): Promise<string> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const connectionId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();

  const key = await importEncryptionKey(ENCRYPTION_KEY);
  const encrypted = await encrypt('test-brevo-api-key', key);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
       VALUES (?, 'brevo-api-key', 1, ?, ?, ?, ?, ?)`,
    ).bind(credentialId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, now, now),
    env.DB.prepare(
      `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, created_at, updated_at)
       VALUES (?, 'brevo', 'Brevo', ?, 'active', ?, ?)`,
    ).bind(connectionId, credentialId, now, now),
  ]);

  return connectionId;
}

async function getAuditEvents(): Promise<
  Array<{
    action: string;
    resource_type: string;
    resource_id: string | null;
    actor_user_id: string | null;
  }>
> {
  const result = await env.DB.prepare(
    'SELECT action, resource_type, resource_id, actor_user_id FROM audit_events ORDER BY created_at DESC',
  ).all<{
    action: string;
    resource_type: string;
    resource_id: string | null;
    actor_user_id: string | null;
  }>();
  return result.results ?? [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit_events on state transitions', () => {
  beforeEach(async () => {
    await resetAndMigrate();
  });

  it('setup.claim writes audit event', async () => {
    await SELF.fetch('http://localhost/api/v1/setup/claim', {
      method: 'POST',
      body: JSON.stringify({ token: 'test-installation-token' }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'test-audit-claim-key',
      },
    });

    const events = await getAuditEvents();
    const claimEvent = events.find((e) => e.action === 'setup.claim');
    expect(claimEvent).toBeDefined();
    expect(claimEvent?.resource_type).toBe('system');
    expect(claimEvent?.resource_id).toBeNull();
    expect(claimEvent?.actor_user_id).toBeNull();
  });

  it('setup.complete writes audit event', async () => {
    // Claim a session
    const claimResponse = await SELF.fetch('http://localhost/api/v1/setup/claim', {
      method: 'POST',
      body: JSON.stringify({ token: 'test-installation-token' }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'test-audit-claim-key',
      },
    });
    const sessionToken = (await claimResponse.json()).data.sessionToken;

    // Create administrator
    await SELF.fetch('http://localhost/api/v1/setup/administrator', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'securePassword123',
        displayName: 'Admin User',
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'test-audit-admin-key',
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    // Create domain
    await SELF.fetch('http://localhost/api/v1/setup/domain', {
      method: 'POST',
      body: JSON.stringify({ name: 'example.com' }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'test-audit-domain-key',
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    // Advance step to complete
    await env.DB.prepare(
      `UPDATE installation_state SET current_step = 'complete', updated_at = '2026-01-01 00:00:00' WHERE id = 1`,
    ).run();

    // Call complete
    await SELF.fetch('http://localhost/api/v1/setup/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'test-audit-complete-key',
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    const events = await getAuditEvents();
    const completeEvent = events.find((e) => e.action === 'setup.complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.resource_type).toBe('system');
    expect(completeEvent?.resource_id).toBeNull();
  });

  it('mailbox.create writes audit event with correct resourceId', async () => {
    await completeSetupSeed();

    const userId = await createUserWithRole('member', 'user@example.com');
    const accessToken = await createSession(userId);
    const domainId = await createDomain();

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      method: 'POST',
      body: JSON.stringify({ localPart: 'test', domainId }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Idempotency-Key': 'test-idem-key-audit-mb01',
      },
    });

    expect(response.status).toBe(200);
    const mailboxId = (await response.json()).data.id;

    const events = await getAuditEvents();
    const mailboxEvent = events.find((e) => e.action === 'mailbox.create');
    expect(mailboxEvent).toBeDefined();
    expect(mailboxEvent?.resource_type).toBe('mailbox');
    expect(mailboxEvent?.resource_id).toBe(mailboxId);
    expect(mailboxEvent?.actor_user_id).toBe(userId);
  });

  it('message.receive writes audit event', async () => {
    // Seed a mailbox so the inbound handler accepts the message
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const userId = crypto.randomUUID();
    const domainId = crypto.randomUUID();
    const mailboxId = crypto.randomUUID();
    const passwordHash = await hashPassword('testPassword123');

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        userId,
        'test@example.com',
        'Test',
        'active',
        passwordHash.algorithm,
        passwordHash.iterations,
        passwordHash.salt,
        passwordHash.hash,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
         VALUES (?, 'example.com', 'active', NULL, ?, ?)`,
      ).bind(domainId, now, now),
      env.DB.prepare(
        `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'inbox', 'Inbox', 'active', ?, ?)`,
      ).bind(mailboxId, domainId, userId, now, now),
    ]);

    const rawEmail = `From: sender@example.com
To: inbox@example.com
Subject: Audit test
Message-ID: <audit-test@message.id>

Body text.`;

    const message: ForwardableEmailMessage = {
      to: 'inbox@example.com',
      from: 'sender@example.com',
      headers: new Headers(),
      raw: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(rawEmail));
          controller.close();
        },
      }),
      rawSize: rawEmail.length,
      setReject: async () => {},
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage;

    await inboundEmail.email(message, env);

    const events = await getAuditEvents();
    const receiveEvent = events.find((e) => e.action === 'message.receive');
    expect(receiveEvent).toBeDefined();
    expect(receiveEvent?.resource_type).toBe('message');
    expect(receiveEvent?.resource_id).not.toBeNull();
    expect(receiveEvent?.actor_user_id).toBeNull();
  });

  describe('message.send writes audit event', () => {
    let queueSendSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      await completeSetupSeed();
      queueSendSpy = vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);
    });

    afterEach(() => {
      queueSendSpy.mockRestore();
    });

    it('writes audit event with actor and messageId', async () => {
      const ownerId = await createUserWithRole('member', 'owner@example.com');
      const token = await createSession(ownerId);
      const domainId = await createDomain();
      const mailboxId = crypto.randomUUID();
      const now = new Date().toISOString();

      await env.DB.prepare(
        `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'me', '', 'active', ?, ?)`,
      )
        .bind(mailboxId, domainId, ownerId, now, now)
        .run();

      const connectionId = await createActiveProviderConnection();
      await env.DB.prepare('UPDATE managed_domains SET outbound_connection_id = ? WHERE id = ?')
        .bind(connectionId, domainId)
        .run();

      const response = await SELF.fetch(
        `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
        {
          method: 'POST',
          body: JSON.stringify({ to: [{ address: 'to@example.com' }] }),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': 'test-idem-key-audit-send1',
          },
        },
      );

      expect(response.status).toBe(202);
      const messageId = (await response.json()).data.messageId;

      const events = await getAuditEvents();
      const sendEvent = events.find((e) => e.action === 'message.send');
      expect(sendEvent).toBeDefined();
      expect(sendEvent?.resource_type).toBe('message');
      expect(sendEvent?.resource_id).toBe(messageId);
      expect(sendEvent?.actor_user_id).toBe(ownerId);
    });
  });

  describe('webhook.delivered writes audit event', () => {
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

    it('writes audit event after webhook processing', async () => {
      await seedInstallationState({ status: 'complete', currentStep: 'complete' });

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const credentialId = crypto.randomUUID();
      const connectionId = crypto.randomUUID();
      const messageId = crypto.randomUUID();

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
           VALUES (?, ?, 1, X'00', X'000000000000000000000000', X'00000000000000000000000000000000', ?, ?)`,
        ).bind(credentialId, `cred-${connectionId}`, now, now),
        env.DB.prepare(
          `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, webhook_secret, created_at, updated_at)
           VALUES (?, 'brevo', ?, ?, 'active', ?, ?, ?)`,
        ).bind(connectionId, `conn-${connectionId}`, credentialId, WEBHOOK_SECRET, now, now),
        env.DB.prepare(
          `INSERT INTO messages (id, from_address, from_name, subject, html_body, text_body, references_header, status, created_at, updated_at)
           VALUES (?, 'sender@example.com', 'Sender', 'hello', '', '', '', 'sent', ?, ?)`,
        ).bind(messageId, now, now),
        env.DB.prepare(
          `INSERT INTO outbound_jobs (id, message_id, provider_connection_id, status, provider_message_id, created_at, updated_at)
           VALUES (?, ?, ?, 'sent', ?, ?, ?)`,
        ).bind(crypto.randomUUID(), messageId, connectionId, PROVIDER_MESSAGE_ID, now, now),
      ]);

      const body = JSON.stringify({ event: 'delivered', messageId: PROVIDER_MESSAGE_ID });
      const signature = await computeHmac(body, WEBHOOK_SECRET);

      const response = await SELF.fetch(`http://localhost/api/v1/webhooks/brevo/${connectionId}`, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature },
      });

      expect(response.status).toBe(200);

      const events = await getAuditEvents();
      const webhookEvent = events.find((e) => e.action === 'webhook.delivered');
      expect(webhookEvent).toBeDefined();
      expect(webhookEvent?.resource_type).toBe('message');
      expect(webhookEvent?.resource_id).toBe(messageId);
      expect(webhookEvent?.actor_user_id).toBeNull();
    });
  });

  // CAP-032 / R-API-001 / QA M1: error path emits the canonical envelope.
  // /api/v1/setup/claim with a wrong installation token throws a typed
  // DomainError (SETUP_CLAIM_INVALID_TOKEN, 401) — same shape every other
  // route returns. Asserts status, code, message, requestId, and the
  // X-Request-Id header mirroring the envelope.
  it('canonical error envelope on a thrown DomainError (R-API-001)', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
      method: 'POST',
      body: JSON.stringify({ token: 'definitely-not-the-real-token' }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'test-audit-envelope-key',
      },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe('SETUP_CLAIM_INVALID_TOKEN');
    expect(body.error.message).toEqual(expect.any(String));
    expect(body.error.requestId).toMatch(UUID_V4_REGEX);
    expect(response.headers.get('X-Request-Id')).toBe(body.error.requestId);
  });
});
