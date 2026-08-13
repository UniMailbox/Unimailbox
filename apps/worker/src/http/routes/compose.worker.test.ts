// compose.worker.test.ts — CAP-023 POST /api/v1/mailboxes/:mailboxId/messages/send.
//
// Worker-pool tests for the compose (send) endpoint. Uses SELF.fetch to
// exercise the full request pipeline: router → authn → requirePermission →
// assertCan → D1 batch insert → OUTBOUND queue send → 202 response.
//
// Covers:
// - Happy path: 202 + messageId + status='queued'; message, recipients,
//   mailbox_message (folder='sent') and outbound_jobs rows all written.
// - Authz: viewer role cannot send (403 MAILBOX_ACCESS_DENIED).
// - IDOR: user A cannot send from user B's mailbox (403 MAILBOX_ACCESS_DENIED).
// - Unauthenticated request → 401 AUTHENTICATION_REQUIRED.
// - Validation: missing 'to' array → 400.
// - No active provider connection → 409 PROVIDER_CONNECTION_NOT_FOUND.

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword, importEncryptionKey, encrypt } from '../../platform/crypto';

const ENCRYPTION_KEY = 'a'.repeat(64);

// R-OUTBOUND-005 / R-API-004 / R-OUTBOUND-006: send requires Idempotency-Key.
// One key per test is sufficient — beforeEach resets the DB.
const IDEMPOTENCY_KEY = 'test-idem-key-compose01';

// ---------------------------------------------------------------------------
// Seeding helpers (modelled on mailboxes.worker.test.ts and
// messages.worker.test.ts).
// ---------------------------------------------------------------------------

async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('message.read', 'message.read', 'Read messages', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('message.send', 'message.send', 'Send messages', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('mailbox.create', 'mailbox.create', 'Create mailboxes', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('role.manage', 'role.manage', 'Manage roles', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    // Administrator: all the permissions we need, plus role.manage (admin bypass).
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
    // Member: read + send + mailbox.create. No role.manage (so no admin bypass).
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
    env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)`,
    ).bind(userId, roleName, now),
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

  await env.CACHE.put(
    `auth:${accessToken}`,
    JSON.stringify({ userId }),
    { expirationTtl: 15 * 60 },
  );

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

async function createMailbox(
  domainId: string,
  ownerUserId: string,
  localPart = 'inbox',
): Promise<string> {
  const mailboxId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'active', ?, ?)`,
  )
    .bind(mailboxId, domainId, ownerUserId, localPart, now, now)
    .run();
  return mailboxId;
}

async function addMailboxMember(
  mailboxId: string,
  userId: string,
  role: 'viewer' | 'sender' | 'admin',
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(mailboxId, userId, role, new Date().toISOString())
    .run();
}

/** Creates an active provider connection + encrypted credential so the
 * compose route has a connection to point the outbound job at. */
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

// ---------------------------------------------------------------------------
// POST /api/v1/mailboxes/:mailboxId/messages/send
// ---------------------------------------------------------------------------

describe('POST /api/v1/mailboxes/:mailboxId/messages/send', () => {
  let queueSendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    // The OUTBOUND queue binding exists in the test harness; spy on send so
    // we can assert the route enqueues a jobId without depending on a real
    // consumer.
    queueSendSpy = vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);
  });

  afterEach(() => {
    queueSendSpy.mockRestore();
  });

  it('returns 401 without authentication', async () => {
    const response = await SELF.fetch(
      'http://localhost/api/v1/mailboxes/00000000-0000-4000-8000-000000000001/messages/send',
      {
        method: 'POST',
        body: JSON.stringify({ to: [{ address: 'recipient@example.com' }] }),
        headers: { 'Content-Type': 'application/json' },
      },
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 400 when the to array is missing', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await createActiveProviderConnection();

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({ subject: 'no recipients' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
      },
    );

    expect(response.status).toBe(400);
  });

  it('creates a queued message + recipients + mailbox_message + outbound_job and enqueues', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'me');
    await createActiveProviderConnection();

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({
          to: [{ address: 'to@example.com', displayName: 'To' }],
          cc: [{ address: 'cc@example.com' }],
          subject: 'Hello',
          htmlBody: '<p>body</p>',
          textBody: 'body',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
      },
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.data).toHaveProperty('messageId');
    expect(body.data).toHaveProperty('status', 'queued');

    const messageId = body.data.messageId;

    // Message row: status 'queued', from the mailbox address, created_by set.
    const msg = await env.DB
      .prepare(
        'SELECT from_address, subject, status, created_by_user_id FROM messages WHERE id = ?',
      )
      .bind(messageId)
      .first<{ from_address: string; subject: string; status: string; created_by_user_id: string }>();
    expect(msg?.from_address).toBe('me@example.com');
    expect(msg?.subject).toBe('Hello');
    expect(msg?.status).toBe('queued');
    expect(msg?.created_by_user_id).toBe(ownerId);

    // Recipients: one 'to', one 'cc'.
    const recipients = await env.DB
      .prepare(
        "SELECT type, address FROM message_recipients WHERE message_id = ? ORDER BY type",
      )
      .bind(messageId)
      .all<{ type: string; address: string }>();
    const types = (recipients.results ?? []).map((r) => `${r.type}:${r.address}`).sort();
    expect(types).toEqual(['cc:cc@example.com', 'to:to@example.com']);

    // Mailbox association: folder 'sent', is_read true (the sender's own copy).
    const mailboxMessage = await env.DB
      .prepare(
        'SELECT folder, is_read FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ?',
      )
      .bind(mailboxId, messageId)
      .first<{ folder: string; is_read: number }>();
    expect(mailboxMessage?.folder).toBe('sent');
    expect(mailboxMessage?.is_read).toBe(1);

    // Outbound job: status 'queued', linked to the message.
    const job = await env.DB
      .prepare(
        'SELECT status, message_id FROM outbound_jobs WHERE message_id = ?',
      )
      .bind(messageId)
      .first<{ status: string; message_id: string }>();
    expect(job?.status).toBe('queued');
    expect(job?.message_id).toBe(messageId);

    // The route enqueued exactly one message with { jobId }.
    expect(queueSendSpy).toHaveBeenCalledTimes(1);
    const enqueued = JSON.parse(
      (queueSendSpy.mock.calls[0]?.[0] as string) ?? '{}',
    ) as { jobId?: string };
    expect(enqueued.jobId).toBeDefined();
  });

  it('returns the success envelope { data: T } with messageId and status', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'me');
    await createActiveProviderConnection();

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({ to: [{ address: 'to@example.com' }] }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
      },
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.messageId).toEqual(expect.any(String));
    expect(body.data.status).toBe('queued');
  });

  it('returns 403 when a viewer member tries to send (R-AUTHZ-003)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'shared');
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    await createActiveProviderConnection();

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({ to: [{ address: 'to@example.com' }] }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${viewerToken}`,
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  });

  it('returns 403 when a non-member tries to send from another user\'s mailbox (IDOR, R-AUTHZ-004)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const intruderId = await createUserWithRole('member', 'intruder@example.com');
    const intruderToken = await createSession(intruderId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'private');
    await createActiveProviderConnection();

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({ to: [{ address: 'to@example.com' }] }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${intruderToken}`,
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  });

  it('lets a sender-role member send (allowed by the permission matrix)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const senderId = await createUserWithRole('member', 'sender@example.com');
    const senderToken = await createSession(senderId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'shared');
    await addMailboxMember(mailboxId, senderId, 'sender');
    await createActiveProviderConnection();

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({ to: [{ address: 'to@example.com' }] }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${senderToken}`,
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
      },
    );

    expect(response.status).toBe(202);
  });

  it('returns 409 when there is no active provider connection', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'me');
    // Deliberately do NOT create a provider connection.

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({ to: [{ address: 'to@example.com' }] }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
      },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('PROVIDER_CONNECTION_NOT_FOUND');
  });
});
