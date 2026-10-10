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
    // Administrator: global permissions alone do not grant mailbox access.
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
    // Member: read + send + mailbox.create.
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
    env.DB.prepare(
      `UPDATE managed_domains
          SET outbound_connection_id = ?, updated_at = ?
        WHERE id = (SELECT id FROM managed_domains ORDER BY created_at ASC, id ASC LIMIT 1)`,
    ).bind(connectionId, now),
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
          bcc: [{ address: 'hidden@example.com' }],
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
    const msg = await env.DB.prepare(
      'SELECT from_address, subject, status, created_by_user_id FROM messages WHERE id = ?',
    )
      .bind(messageId)
      .first<{
        from_address: string;
        subject: string;
        status: string;
        created_by_user_id: string;
      }>();
    expect(msg?.from_address).toBe('me@example.com');
    expect(msg?.subject).toBe('Hello');
    expect(msg?.status).toBe('queued');
    expect(msg?.created_by_user_id).toBe(ownerId);

    // Recipients: one 'to', one 'cc'.
    const recipients = await env.DB.prepare(
      'SELECT type, address FROM message_recipients WHERE message_id = ? ORDER BY type',
    )
      .bind(messageId)
      .all<{ type: string; address: string }>();
    const types = (recipients.results ?? []).map((r) => `${r.type}:${r.address}`).sort();
    expect(types).toEqual(['bcc:hidden@example.com', 'cc:cc@example.com', 'to:to@example.com']);

    // Mailbox association: folder 'sent', is_read true (the sender's own copy).
    const mailboxMessage = await env.DB.prepare(
      'SELECT folder, is_read FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ?',
    )
      .bind(mailboxId, messageId)
      .first<{ folder: string; is_read: number }>();
    expect(mailboxMessage?.folder).toBe('sent');
    expect(mailboxMessage?.is_read).toBe(1);

    // Outbound job: status 'queued', linked to the message.
    const job = await env.DB.prepare(
      'SELECT status, message_id FROM outbound_jobs WHERE message_id = ?',
    )
      .bind(messageId)
      .first<{ status: string; message_id: string }>();
    expect(job?.status).toBe('queued');
    expect(job?.message_id).toBe(messageId);

    // The route enqueued exactly one message with { jobId }.
    expect(queueSendSpy).toHaveBeenCalledTimes(1);
    const enqueued = JSON.parse((queueSendSpy.mock.calls[0]?.[0] as string) ?? '{}') as {
      jobId?: string;
    };
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

  it("returns 403 when a non-member tries to send from another user's mailbox (IDOR, R-AUTHZ-004)", async () => {
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

  it('requires sender membership for a global administrator to send from a mailbox', async () => {
    const ownerId = await createUserWithRole('member', 'owner-admin-send@example.com');
    const adminId = await createUserWithRole('administrator', 'admin-send@example.com');
    const adminToken = await createSession(adminId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'admin-send-boundary');
    await createActiveProviderConnection();
    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`;
    const body = JSON.stringify({ to: [{ address: 'to@example.com' }] });

    const denied = await SELF.fetch(url, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'admin-send-denied',
      },
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe('MAILBOX_ACCESS_DENIED');

    await addMailboxMember(mailboxId, adminId, 'sender');
    const granted = await SELF.fetch(url, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'admin-send-granted',
      },
    });
    expect(granted.status).toBe(202);
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

  // ---------------------------------------------------------------------------
  // Idempotency tests (Fix 2 / BLOCKER)
  // ---------------------------------------------------------------------------

  it('returns 400 when Idempotency-Key header is missing', async () => {
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
        },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 400 when Idempotency-Key header is too short', async () => {
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
          'Idempotency-Key': 'short',
        },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('replays the stored response when same key + same body (R-API-004)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'me');
    await createActiveProviderConnection();

    const requestBody = JSON.stringify({
      to: [{ address: 'to@example.com', displayName: 'To' }],
      subject: 'Hello',
      htmlBody: '<p>body</p>',
      textBody: 'body',
    });
    const idempotencyKey = 'test-replay-key-001';

    // First request
    const firstResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: requestBody,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(firstResponse.status).toBe(202);
    const firstBody = await firstResponse.json();
    const firstMessageId = firstBody.data.messageId;

    // Verify idempotency record was written
    const record = await env.DB.prepare(
      `SELECT response_status, response_json, request_hash
         FROM idempotency_records
         WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
    )
      .bind(ownerId, 'POST /api/v1/mailboxes/:mailboxId/messages/send', idempotencyKey)
      .first<{ response_status: number; response_json: string; request_hash: string }>();
    expect(record).toBeDefined();
    expect(record?.response_status).toBe(202);

    // Second request with same key + same body → replay
    const secondResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: requestBody,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(secondResponse.status).toBe(202);
    const secondBody = await secondResponse.json();
    expect(secondBody.data.messageId).toBe(firstMessageId);
    expect(secondBody.data.status).toBe('queued');

    // Verify no additional message was created
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE created_by_user_id = ?',
    )
      .bind(ownerId)
      .first<{ count: number }>();
    expect(messageCount?.count).toBe(1);

    // Verify OUTBOUND.send was called only once (no second job)
    expect(queueSendSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when same key + different body (IDEMPOTENCY_KEY_REUSED)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'me');
    await createActiveProviderConnection();

    const idempotencyKey = 'test-reuse-key-001';

    // First request
    const firstResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({
          to: [{ address: 'to1@example.com' }],
          subject: 'First',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(firstResponse.status).toBe(202);

    // Second request with same key + different body → 409
    const secondResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({
          to: [{ address: 'to2@example.com' }],
          subject: 'Different',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(secondResponse.status).toBe(409);
    const body = await secondResponse.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays the stored response byte-identically (JSON whitespace preserved)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'me');
    await createActiveProviderConnection();

    // Deliberately non-minified JSON with whitespace
    const requestBody = JSON.stringify(
      { to: [{ address: 'to@example.com' }], subject: 'Hello' },
      null,
      2,
    );
    const idempotencyKey = 'test-whitespace-key-001';

    const firstResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: requestBody,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(firstResponse.status).toBe(202);
    const firstText = await firstResponse.text();

    // Replay with identical whitespace
    const secondResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: requestBody,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(secondResponse.status).toBe(202);
    const secondText = await secondResponse.text();
    expect(secondText).toBe(firstText);
  });

  it('replays after UNIQUE-constraint race (R-OUTBOUND-005) — loser returns winner response', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'me');
    await createActiveProviderConnection();

    const requestBody = JSON.stringify({
      to: [{ address: 'to@example.com' }],
      subject: 'Race test',
      htmlBody: '<p>body</p>',
      textBody: 'body',
    });
    const idempotencyKey = 'test-race-loser-key-001';
    const winnerMessageId = crypto.randomUUID();
    const operation = 'POST /api/v1/mailboxes/:mailboxId/messages/send';

    // Simulate the race winner: pre-insert the idempotency record as if the winner
    // already committed (message + job + record atomically).
    const { sha256Hex, sqliteTimestamp } = await import('../../platform/idempotency');
    const { prepareCreateIdempotencyRecord } = await import('../../platform/idempotency');
    const requestHash = await sha256Hex(requestBody);
    const now = sqliteTimestamp(new Date());
    const successBody = JSON.stringify({
      data: { messageId: winnerMessageId, status: 'queued' },
    });

    await prepareCreateIdempotencyRecord(env.DB, {
      id: crypto.randomUUID(),
      actorId: ownerId,
      operation,
      idempotencyKey,
      requestHash,
      responseStatus: 202,
      responseJson: successBody,
      createdAt: now,
    }).run();

    // The loser fires its request with the same key + same body. Because the
    // winner's record exists, the loser must replay it (return 202 with the
    // winner's messageId, NOT 500, NOT 409).
    const loserResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: requestBody,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(loserResponse.status).toBe(202);
    const loserBody = await loserResponse.json();
    expect(loserBody.data.messageId).toBe(winnerMessageId);
    expect(loserBody.data.status).toBe('queued');

    // Verify no second message was created (the loser replayed, didn't execute)
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE created_by_user_id = ?',
    )
      .bind(ownerId)
      .first<{ count: number }>();
    expect(messageCount?.count).toBe(0);
  });

  // -----------------------------------------------------------------------
  // CAP-031 / R-INPUT-002: malformed JSON returns 400 INVALID_JSON
  // (stable code from parseJsonBody), not a raw SyntaxError or 500.
  // -----------------------------------------------------------------------
  it('returns 400 INVALID_JSON when request body is not valid JSON', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await createActiveProviderConnection();

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: '{not valid json',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'compose-invalid-json-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });

  // -----------------------------------------------------------------------
  // CAP-031 / D-CAP-037-A / AC11: a corrected retry with the same
  // Idempotency-Key after an INVALID_JSON rejection succeeds — the helper
  // throws BEFORE the D1 batch, so no idempotency_records row was written
  // and the retry is not flagged as IDEMPOTENCY_KEY_REUSED.
  // -----------------------------------------------------------------------
  it('after INVALID_JSON, a corrected retry with the same Idempotency-Key succeeds', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await createActiveProviderConnection();

    const idempotencyKey = 'compose-retry-after-invalid-json-' + crypto.randomUUID();

    // First request: malformed body. Returns 400 INVALID_JSON.
    const malformedResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: '{not valid json',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );
    expect(malformedResponse.status).toBe(400);

    // Second request: same Idempotency-Key, valid body. Must succeed — NOT 409.
    const validBody = JSON.stringify({
      to: [{ address: 'recipient@example.com' }],
      subject: 'retry after malformed',
    });
    const retryResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: validBody,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );
    expect(retryResponse.status).toBe(202);
    const retryBody = await retryResponse.json();
    expect(retryBody.data.status).toBe('queued');
  });
  it('appends a sanitized enabled domain signature once, including on idempotent replay', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await createActiveProviderConnection();
    await env.DB.prepare(
      `INSERT INTO domain_signatures (id,domain_id,html_content,text_content,is_enabled,created_at,updated_at) VALUES (?,?,'<p>Regards &amp; thanks</p>','Regards & thanks',1,datetime('now'),datetime('now'))`,
    )
      .bind(crypto.randomUUID(), domainId)
      .run();
    const key = crypto.randomUUID();
    const request = () =>
      SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          to: [{ address: 'recipient@example.com' }],
          subject: 'Signature check',
          htmlBody: '<p><strong>Hello</strong><script>bad()</script></p>',
          textBody: 'Hello',
        }),
      });
    const response = await request();
    expect(response.status).toBe(202);
    const result = await response.json<{ data: { messageId: string } }>();
    expect((await request()).status).toBe(202);
    const row = await env.DB.prepare('SELECT html_body,text_body FROM messages WHERE id=?')
      .bind(result.data.messageId)
      .first<{ html_body: string; text_body: string }>();
    expect(row?.html_body).toBe(
      '<p><strong>Hello</strong></p><div><br><p>Regards &amp; thanks</p></div>',
    );
    expect(row?.text_body).toBe('Hello\n\nRegards & thanks');
  });
});

describe('Scheduled sending — durable snapshot and management', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let owner: string;
  let token: string;
  let mailbox: string;
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    owner = await createUserWithRole('member', 'schedule-owner@example.com');
    token = await createSession(owner);
    mailbox = await createMailbox(await createDomain(), owner);
    await createActiveProviderConnection();
    sendSpy = vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  const future = (hours = 1) =>
    new Date(Math.ceil((Date.now() + hours * 3600_000) / 1000) * 1000).toISOString();
  function request(
    path: string,
    method = 'GET',
    body?: unknown,
    key = crypto.randomUUID(),
    auth = token,
  ) {
    return SELF.fetch(`http://localhost/api/v1/mailboxes/${mailbox}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function schedule(time = future(), key = crypto.randomUUID()) {
    const response = await request(
      'messages/send',
      'POST',
      {
        to: [{ address: 'to@example.com' }],
        bcc: [{ address: 'blind@example.com' }],
        subject: 'Scheduled snapshot',
        htmlBody: '<p><strong>Keep me</strong></p>',
        textBody: 'Keep me',
        inReplyTo: '<parent@example.com>',
        scheduledAt: time,
      },
      key,
    );
    expect(response.status).toBe(202);
    return (await response.json<{ data: { messageId: string; scheduledAt: string } }>()).data;
  }
  async function job(id: string) {
    return env.DB.prepare('SELECT * FROM outbound_jobs WHERE message_id=?').bind(id).first<{
      id: string;
      status: string;
      scheduled_at: string;
      attempts: number;
      schedule_revision: number;
      updated_at: string;
    }>();
  }

  it('delays once, preserves the snapshot, and replays without another enqueue', async () => {
    const time = future();
    const key = crypto.randomUUID();
    const first = await schedule(time, key);
    const second = await schedule(time, key);
    expect(second).toEqual(first);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[1]).toMatchObject({ delaySeconds: expect.any(Number) });
    expect(sendSpy.mock.calls[0]?.[1]?.delaySeconds).toBeGreaterThan(3590);
    expect(await job(first.messageId)).toMatchObject({
      status: 'queued',
      attempts: 0,
      scheduled_at: time.slice(0, 19).replace('T', ' '),
      updated_at: time.slice(0, 19).replace('T', ' '),
    });
    const message = await env.DB.prepare(
      'SELECT html_body,in_reply_to_header,status FROM messages WHERE id=?',
    )
      .bind(first.messageId)
      .first();
    expect(message).toMatchObject({
      html_body: '<p><strong>Keep me</strong></p>',
      in_reply_to_header: '<parent@example.com>',
      status: 'queued',
    });
    const list = await request('scheduled-sends');
    expect(list.status).toBe(200);
    const wire = await list.text();
    expect(wire).toContain(first.messageId);
    expect(wire).not.toContain('blind@example.com');
    expect((await request('messages?folder=sent')).status).toBe(200);
    expect(await (await request('messages?folder=sent')).text()).not.toContain(first.messageId);
  });

  it('holds far-future tasks without Queue calls, then dispatches once within 24h', async () => {
    const time = future(48);
    const sent = await schedule(time);
    expect(sendSpy).not.toHaveBeenCalled();
    const { reclaimStaleJobs } = await import('../../modules/outbound-mail');
    await reclaimStaleJobs(env.DB, new Date(), env.OUTBOUND);
    expect(sendSpy).not.toHaveBeenCalled();
    const window = new Date(Date.parse(time) - 23 * 3600_000);
    await reclaimStaleJobs(env.DB, window, env.OUTBOUND);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[1]).toEqual({ delaySeconds: 23 * 3600 });
    await reclaimStaleJobs(env.DB, new Date(window.getTime() + 10 * 60_000), env.OUTBOUND);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(await job(sent.messageId)).toMatchObject({
      updated_at: time.slice(0, 19).replace('T', ' '),
    });
  });

  it('retries a failed delayed enqueue on recovery instead of losing the future task', async () => {
    const time = future(48);
    await schedule(time);
    const { reclaimStaleJobs } = await import('../../modules/outbound-mail');
    const window = new Date(Date.parse(time) - 23 * 3600_000);
    sendSpy.mockRejectedValueOnce(new Error('synthetic queue outage'));
    await reclaimStaleJobs(env.DB, window, env.OUTBOUND);
    await reclaimStaleJobs(env.DB, new Date(window.getTime() + 10 * 60_000), env.OUTBOUND);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects early atomic claims and defers delivery without consuming an attempt', async () => {
    const sent = await schedule();
    const row = await job(sent.messageId);
    if (!row) throw new Error('Missing job');
    const { processOutboundJob, claimOutboundJob } = await import('../../modules/outbound-mail');
    const adapter = vi.fn(() => undefined);
    const deferred = await processOutboundJob(row.id, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      resolveAdapter: adapter,
    });
    expect(deferred).toMatchObject({ delaySeconds: expect.any(Number) });
    expect(adapter).not.toHaveBeenCalled();
    expect(
      await claimOutboundJob(
        env.DB,
        row.id,
        crypto.randomUUID(),
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).toBeNull();
    expect(await job(sent.messageId)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('changes time with CAS, rejects stale changes, and defers old deliveries to the new time', async () => {
    const sent = await schedule(future(48));
    const time = future(2);
    const change = await request(`scheduled-sends/${sent.messageId}`, 'PATCH', {
      scheduledAt: time,
      expectedRevision: 0,
    });
    expect(change.status).toBe(200);
    expect(await job(sent.messageId)).toMatchObject({
      scheduled_at: time.slice(0, 19).replace('T', ' '),
      schedule_revision: 1,
    });
    expect(
      (
        await request(`scheduled-sends/${sent.messageId}`, 'PATCH', {
          scheduledAt: future(3),
          expectedRevision: 0,
        })
      ).status,
    ).toBe(409);
    const row = await job(sent.messageId);
    if (!row) throw new Error('Missing job');
    const { processOutboundJob } = await import('../../modules/outbound-mail');
    const deferred = await processOutboundJob(row.id, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
    });
    expect(deferred?.delaySeconds).toBeGreaterThan(7100);
  });

  it('cancel is atomic, preserves a draft, and skips old Queue messages', async () => {
    const sent = await schedule();
    const path = `scheduled-sends/${sent.messageId}/cancel`;
    const responses = await Promise.all([
      request(path, 'POST', { expectedRevision: 0 }),
      request(path, 'POST', { expectedRevision: 0 }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const row = await job(sent.messageId);
    if (!row) throw new Error('Missing job');
    expect(row.status).toBe('failed');
    expect(
      await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(sent.messageId).first(),
    ).toEqual({ status: 'draft' });
    expect(
      await env.DB.prepare('SELECT folder FROM mailbox_messages WHERE message_id=?')
        .bind(sent.messageId)
        .first(),
    ).toEqual({ folder: 'drafts' });
    const { processOutboundJob } = await import('../../modules/outbound-mail');
    const resolveAdapter = vi.fn(() => undefined);
    await processOutboundJob(row.id, { db: env.DB, encryptionKey: ENCRYPTION_KEY, resolveAdapter });
    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(await (await request('scheduled-sends')).text()).not.toContain(sent.messageId);
    expect(await (await request('messages?folder=drafts')).text()).toContain(sent.messageId);
  });

  it('replays concurrent identical cancel requests with exactly one audit entry', async () => {
    const sent = await schedule();
    const key = crypto.randomUUID();
    const path = `scheduled-sends/${sent.messageId}/cancel`;
    const responses = await Promise.all([
      request(path, 'POST', { expectedRevision: 0 }, key),
      request(path, 'POST', { expectedRevision: 0 }, key),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM audit_events WHERE action='message.schedule_cancelled'",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it('cancel loses to a job already atomically claimed for delivery', async () => {
    const sent = await schedule();
    await env.DB.prepare("UPDATE outbound_jobs SET status='sending' WHERE message_id=?")
      .bind(sent.messageId)
      .run();
    expect(
      (await request(`scheduled-sends/${sent.messageId}/cancel`, 'POST', { expectedRevision: 0 }))
        .status,
    ).toBe(409);
    expect(
      await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(sent.messageId).first(),
    ).toEqual({ status: 'queued' });
  });

  it('enforces mailbox authorization for foreign actors and read-only members', async () => {
    const sent = await schedule();
    const foreign = await createUserWithRole('member', 'foreign@example.com');
    const auth = await createSession(foreign);
    expect(
      (await request('scheduled-sends', 'GET', undefined, crypto.randomUUID(), auth)).status,
    ).toBe(403);
    await addMailboxMember(mailbox, foreign, 'viewer');
    expect(
      (await request('scheduled-sends', 'GET', undefined, crypto.randomUUID(), auth)).status,
    ).toBe(200);
    expect(
      (
        await request(
          `scheduled-sends/${sent.messageId}/cancel`,
          'POST',
          { expectedRevision: 0 },
          crypto.randomUUID(),
          auth,
        )
      ).status,
    ).toBe(403);
  });

  it('rejects past, invalid and over-one-year times before writing or enqueueing', async () => {
    for (const scheduledAt of [
      'bad',
      new Date(Date.now() - 60_000).toISOString(),
      future(365 * 24 + 1),
    ]) {
      const response = await request('messages/send', 'POST', {
        to: [{ address: 'to@example.com' }],
        scheduledAt,
      });
      expect(response.status).toBe(400);
    }
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT count(*) AS count FROM outbound_jobs').first()).toEqual({
      count: 0,
    });
  });
  it('paginates scheduled snapshots with signed cursors without disclosing Bcc', async () => {
    const first = await schedule(future(48));
    const original = await job(first.messageId);
    if (!original) throw new Error('Missing job');
    for (let i = 0; i < 51; i++) {
      const messageId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO messages(id,from_address,from_name,subject,html_body,text_body,status,created_at,updated_at) SELECT ?,from_address,from_name,subject,html_body,text_body,status,created_at,updated_at FROM messages WHERE id=?`,
        ).bind(messageId, first.messageId),
        env.DB.prepare(
          `INSERT INTO mailbox_messages(id,mailbox_id,message_id,is_read,is_starred,folder,created_at) VALUES(?,?,?,1,0,'scheduled',datetime('now'))`,
        ).bind(crypto.randomUUID(), mailbox, messageId),
        env.DB.prepare(
          `INSERT INTO outbound_jobs(id,message_id,provider_connection_id,status,scheduled_at,mailbox_id,created_at,updated_at) SELECT ?,?,provider_connection_id,'queued',scheduled_at,mailbox_id,created_at,updated_at FROM outbound_jobs WHERE id=?`,
        ).bind(crypto.randomUUID(), messageId, original.id),
      ]);
    }
    const page = await (
      await request('scheduled-sends')
    ).json<{ data: { items: { id: string }[]; nextCursor: string } }>();
    expect(page.data.items).toHaveLength(50);
    expect(page.data.nextCursor).toBeTruthy();
    const next = await (
      await request(`scheduled-sends?cursor=${encodeURIComponent(page.data.nextCursor)}`)
    ).json<{ data: { items: { id: string }[]; nextCursor: string | null } }>();
    expect(next.data.items).toHaveLength(2);
    expect(next.data.nextCursor).toBeNull();
    expect(new Set([...page.data.items, ...next.data.items].map((item) => item.id)).size).toBe(52);
    expect((await request('scheduled-sends?cursor=invalid')).status).toBe(400);
  });

  it('pins editor file bytes in R2 for a far-future scheduled snapshot', async () => {
    const upload = await SELF.fetch(`https://localhost/api/v1/mailboxes/${mailbox}/editor-assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID(),
        'X-Filename': 'scheduled.pdf',
        'X-Asset-Kind': 'file',
        'X-File-Size': '3',
        'Content-Type': 'application/pdf',
      },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status).toBe(201);
    const asset = await upload.json<{ data: { id: string; url: string } }>();
    const response = await request('messages/send', 'POST', {
      to: [{ address: 'to@example.com' }],
      subject: 'Scheduled attachment',
      htmlBody: `<p>Hello</p><a href="${asset.data.url}">scheduled.pdf</a>`,
      textBody: 'Hello',
      scheduledAt: future(48),
    });
    expect(response.status).toBe(202);
    expect(sendSpy).not.toHaveBeenCalled();
    await env.DB.prepare("UPDATE editor_assets SET expires_at=datetime('now','-1 day') WHERE id=?")
      .bind(asset.data.id)
      .run();
    const { expireEditorAssets } = await import('../../modules/editor-assets');
    await expireEditorAssets(env.DB, env.ATTACHMENTS);
    const download = await SELF.fetch(asset.data.url);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
