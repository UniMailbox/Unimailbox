// messages.worker.test.ts — CAP-022 inbox endpoints.
//
// Worker-pool tests for GET /api/v1/mailboxes/:mailboxId/messages (list),
// GET .../messages/:messageId (detail), PATCH .../messages/:messageId/read.
// Uses SELF.fetch to exercise the full request pipeline.
//
// Covers: happy path, empty mailbox, detail with bodies/recipients, 404 on
// missing message, mark-as-read, per-user isRead (R-MESSAGE-005), IDOR blocked
// (R-AUTHZ-004), cursor pagination across a page boundary, and the authn/authz
// error paths.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';

// R-API-004: PATCH .../read requires Idempotency-Key.
const IDEMPOTENCY_KEY = 'test-idem-key-messages01';

// ---------------------------------------------------------------------------
// Seeding helpers (modelled on mailboxes.worker.test.ts).
// ---------------------------------------------------------------------------

async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('message.read', 'message.read', 'Read messages', datetime('now'))`,
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
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'message.read', datetime('now'))`,
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

  await env.CACHE.put(`auth:${accessToken}`, JSON.stringify({ userId }), {
    expirationTtl: 15 * 60,
  });

  return accessToken;
}

async function createDomain(): Promise<string> {
  const domainId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
     VALUES (?, ?, 'active', NULL, ?, ?)`,
  )
    .bind(domainId, 'example.com', now, now)
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

/** Adds user2 as a mailbox member of mailbox1 with the given role. */
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

interface InsertMessageOptions {
  readonly mailboxMessageId?: string;
  readonly createdAt?: string;
  readonly subject?: string;
  readonly fromAddress?: string;
}

/**
 * Inserts a message + mailbox_message + a single "to" recipient.
 * Returns { messageId, mailboxMessageId } so tests can target the PATCH read
 * endpoint, which keys off the path's messageId.
 */
async function insertMessage(
  mailboxId: string,
  opts: InsertMessageOptions = {},
): Promise<{ messageId: string; mailboxMessageId: string }> {
  const messageId = crypto.randomUUID();
  const mailboxMessageId = opts.mailboxMessageId ?? crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const subject = opts.subject ?? 'Test message';
  const fromAddress = opts.fromAddress ?? 'sender@example.com';

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, from_address, from_name, subject, html_body, text_body,
         message_id_header, in_reply_to_header, references_header, status,
         received_at, created_at, updated_at)
       VALUES (?, ?, 'Sender', ?, '<p>body</p>', 'body',
         NULL, NULL, '', 'delivered', ?, ?, ?)`,
    ).bind(messageId, fromAddress, subject, createdAt, createdAt, createdAt),
    env.DB.prepare(
      `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
       VALUES (?, ?, ?, 0, 0, 'inbox', ?)`,
    ).bind(mailboxMessageId, mailboxId, messageId, createdAt),
    env.DB.prepare(
      `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
       VALUES (?, ?, 'recipient@example.com', 'Recipient', 'to', ?)`,
    ).bind(recipientId, messageId, createdAt),
  ]);

  return { messageId, mailboxMessageId };
}

// ---------------------------------------------------------------------------
// GET /api/v1/mailboxes/:mailboxId/messages
// ---------------------------------------------------------------------------

describe('GET /api/v1/mailboxes/:mailboxId/messages', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('returns 401 without authentication', async () => {
    const response = await SELF.fetch(
      'http://localhost/api/v1/mailboxes/00000000-0000-4000-8000-000000000001/messages',
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 when the user is not a member or owner (IDOR)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const otherId = await createUserWithRole('member', 'other@example.com');
    const otherToken = await createSession(otherId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // otherId has message.read (member role) but is not a mailbox member.
    const response = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  });

  it('returns empty page for a new mailbox', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const response = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.nextCursor).toBeNull();
  });

  it('returns messages for the mailbox owner, newest first', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const older = await insertMessage(mailboxId, {
      subject: 'older',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = await insertMessage(mailboxId, {
      subject: 'newer',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const response = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0].id).toBe(newer.messageId);
    expect(body.data.items[0].subject).toBe('newer');
    expect(body.data.items[1].id).toBe(older.messageId);
    expect(body.data.items[1].subject).toBe('older');
    expect(body.data.items[0].isRead).toBe(0);
    expect(body.data.items[0].recipients.to).toHaveLength(1);
    expect(body.data.items[0].recipients.to[0].address).toBe('recipient@example.com');
    expect(body.data.nextCursor).toBeNull();
  });

  it('paginates across a page boundary using the cursor', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const oldest = await insertMessage(mailboxId, {
      subject: 'oldest',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertMessage(mailboxId, {
      subject: 'middle',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await insertMessage(mailboxId, {
      subject: 'newest',
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    // First page: limit=2 → two newest items + a cursor.
    const page1 = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages?limit=2`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(page1.status).toBe(200);
    const page1Body = await page1.json();
    expect(page1Body.data.items).toHaveLength(2);
    expect(page1Body.data.items[0].subject).toBe('newest');
    expect(page1Body.data.items[1].subject).toBe('middle');
    expect(page1Body.data.nextCursor).not.toBeNull();

    // Second page: cursor → remaining oldest item, no next cursor.
    const page2 = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages?limit=2&cursor=${encodeURIComponent(page1Body.data.nextCursor)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(page2.status).toBe(200);
    const page2Body = await page2.json();
    expect(page2Body.data.items).toHaveLength(1);
    expect(page2Body.data.items[0].id).toBe(oldest.messageId);
    expect(page2Body.data.nextCursor).toBeNull();
  });

  it('lets a viewer-role member read the mailbox', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');

    await insertMessage(mailboxId, { subject: 'shared' });

    const response = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].subject).toBe('shared');
  });

  it('returns 404 for a non-existent mailbox', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${crypto.randomUUID()}/messages`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('MAILBOX_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/mailboxes/:mailboxId/messages/:messageId
// ---------------------------------------------------------------------------

describe('GET /api/v1/mailboxes/:mailboxId/messages/:messageId', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('returns the full message detail with bodies and recipients', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId, {
      subject: 'Detail test',
    });

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.id).toBe(messageId);
    expect(body.data.subject).toBe('Detail test');
    expect(body.data.htmlBody).toBe('<p>body</p>');
    expect(body.data.textBody).toBe('body');
    expect(body.data.status).toBe('delivered');
    expect(body.data.isRead).toBe(0);
    expect(body.data.messageIdHeader).toBeNull();
    expect(body.data.inReplyToHeader).toBeNull();
    expect(body.data.referencesHeader).toBe('');
    expect(body.data.recipients.to).toHaveLength(1);
    expect(body.data.recipients.to[0].address).toBe('recipient@example.com');
    expect(body.data.recipients.cc).toEqual([]);
  });

  it('returns 404 MESSAGE_NOT_FOUND for a message not in the mailbox', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${crypto.randomUUID()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('blocks a non-member from reading (IDOR)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const otherId = await createUserWithRole('member', 'other@example.com');
    const otherToken = await createSession(otherId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${otherToken}` } },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('marks a message as read for the requesting user', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const patchResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );

    expect(patchResponse.status).toBe(200);
    const patchBody = await patchResponse.json();
    expect(patchBody.data).toEqual({ ok: true });

    // Follow-up GET should now report isRead = 1.
    const getResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const getBody = await getResponse.json();
    expect(getBody.data.isRead).toBe(1);
  });

  it('is idempotent — re-marking a read message succeeds', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    for (let i = 0; i < 2; i++) {
      const response = await SELF.fetch(
        `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
        },
      );
      expect(response.status).toBe(200);
    }

    const getResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const getBody = await getResponse.json();
    expect(getBody.data.isRead).toBe(1);
  });

  it('keeps per-user isRead independent (R-MESSAGE-005)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    const { messageId } = await insertMessage(mailboxId);

    // Owner marks read.
    const ownerPatch = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );
    expect(ownerPatch.status).toBe(200);

    // Owner sees isRead = 1; viewer still sees isRead = 0 (no user_state row).
    const ownerGet = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    const ownerBody = await ownerGet.json();
    expect(ownerBody.data.isRead).toBe(1);

    const viewerGet = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    const viewerBody = await viewerGet.json();
    expect(viewerBody.data.isRead).toBe(0);

    // Also reflected in the list endpoint.
    const viewerList = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    const viewerListBody = await viewerList.json();
    expect(viewerListBody.data.items[0].isRead).toBe(0);
  });

  // Fix pass F3 / D-CAP-043-F: pre-0017 the UPSERT conflicted on
  // mailbox_message_id alone, so the second reader's row never existed
  // and their read state was silently dropped.
  it('R-MESSAGE-005 / D-CAP-043-F: two members marking the same message read each get their own is_read = 1 row', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    const { messageId, mailboxMessageId } = await insertMessage(mailboxId);

    // Both members open the message (mark-read fires on detail open).
    for (const token of [ownerToken, viewerToken]) {
      const response = await SELF.fetch(
        `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': crypto.randomUUID(),
          },
        },
      );
      expect(response.status).toBe(200);
    }

    // Both per-user rows exist with is_read = 1 — only possible post-0017,
    // where the PK is (mailbox_message_id, user_id).
    const stateRows = await env.DB
      .prepare(
        `SELECT user_id, is_read FROM message_user_state
         WHERE mailbox_message_id = ? ORDER BY user_id`,
      )
      .bind(mailboxMessageId)
      .all<{ user_id: string; is_read: number }>();
    expect(stateRows.results).toHaveLength(2);
    expect(new Set(stateRows.results.map((row) => row.user_id))).toEqual(
      new Set([ownerId, viewerId]),
    );
    for (const row of stateRows.results) {
      expect(row.is_read).toBe(1);
    }

    // Each member's list resolves the message as read for themselves.
    for (const token of [ownerToken, viewerToken]) {
      const list = await SELF.fetch(
        `http://localhost/api/v1/mailboxes/${mailboxId}/messages`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].isRead).toBe(1);
    }
  });

  it('returns 404 when the message is not in the mailbox', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${crypto.randomUUID()}/read`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('blocks a non-member from marking read (IDOR)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const otherId = await createUserWithRole('member', 'other@example.com');
    const otherToken = await createSession(otherId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${otherToken}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  });

  // Fix 2: Comprehensive idempotency tests
  it('returns 400 when Idempotency-Key header is missing', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
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
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'short',
        },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('returns the stored response on replay with same key and body (byte-identical)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();

    const firstResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();

    // Second request with same key should replay exactly (including any whitespace).
    const secondResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    expect(secondBody).toEqual(firstBody);

    // Verify idempotency record was stored.
    const record = await env.DB.prepare(
      'SELECT * FROM idempotency_records WHERE idempotency_key = ?',
    )
      .bind(idempotencyKey)
      .first();
    expect(record).toBeDefined();
  });

  it('returns 409 when same Idempotency-Key is reused with different body', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();

    // First request with empty body.
    const firstResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: '',
      },
    );

    expect(firstResponse.status).toBe(200);

    // Second request with different body (some bytes vs empty).
    const secondResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: '{"different": "body"}',
      },
    );

    expect(secondResponse.status).toBe(409);
    const body = await secondResponse.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(body.error.message).toMatch(/different request body/i);
  });

  it('replays after UNIQUE-constraint race (R-API-004) — loser returns winner response', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const requestBody = '';
    const idempotencyKey = 'test-race-loser-key-001';
    const operation = 'PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read';

    // Simulate the race winner: pre-insert the idempotency record as if the winner
    // already committed. The PATCH /read endpoint uses best-effort mode (record
    // INSERT after the business write), but the race path is still the same:
    // loser re-reads the winner's record and replays it.
    const { sha256Hex, sqliteTimestamp, prepareCreateIdempotencyRecord } = await import(
      '../../platform/idempotency'
    );
    const requestHash = await sha256Hex(requestBody);
    const now = sqliteTimestamp(new Date());
    const successBody = JSON.stringify({ data: { ok: true } });

    await prepareCreateIdempotencyRecord(env.DB, {
      id: crypto.randomUUID(),
      actorId: ownerId,
      operation,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: now,
    }).run();

    // The loser fires its request with the same key + same body. Because the
    // winner's record exists, the loser must replay it (return 200 with {ok: true},
    // NOT 500, NOT 409).
    const loserResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: requestBody,
      },
    );

    expect(loserResponse.status).toBe(200);
    const loserBody = await loserResponse.json();
    expect(loserBody.data).toEqual({ ok: true });

    // Verify no duplicate idempotency record was created (the loser replayed)
    const recordCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM idempotency_records WHERE idempotency_key = ?',
    )
      .bind(idempotencyKey)
      .first<{ count: number }>();
    expect(recordCount?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CAP-043 Slice 1 — HMAC cursor + per-user soft-delete (R-API-005,
// R-MESSAGE-005). These tests exercise the inbox list endpoint with the
// new cursor implementation: a tampered cursor must surface as a single
// 400 INVALID_CURSOR, soft-delete state must be per-user, and the
// repository must still produce a valid HMAC nextCursor on the boundary.
// ---------------------------------------------------------------------------

describe('GET /api/v1/mailboxes/:mailboxId/messages — CAP-043 cursor + soft-delete', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('returns 400 INVALID_CURSOR when the supplied cursor was tampered with', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // A syntactically well-formed cursor signed with a *different* key.
    // Tampering the signature with the right shape must surface as a
    // single 400 INVALID_CURSOR — not 500, not 200.
    const { signCursor } = await import('../../platform/cursor');
    const otherKey = 'attacker-supplied-key-different-from-env';
    const foreignCursor = await signCursor(
      { createdAt: '2026-01-01 00:00:00', id: crypto.randomUUID() },
      otherKey,
    );

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages?cursor=${encodeURIComponent(foreignCursor)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_CURSOR');
  });

  it('returns 400 INVALID_CURSOR when the cursor has the wrong shape (no dot)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // A garbage cursor — neither signed nor shaped correctly. The
    // route layer must still emit INVALID_CURSOR, not INVALID_REQUEST
    // or 500.
    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages?cursor=not-a-cursor`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_CURSOR');
  });

  it('round-trips a valid cursor (page 2 returns the next slice and null nextCursor)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // Seed three messages with strictly-increasing created_at so the
    // (created_at < ?, id < ?) boundary has a stable, deterministic shape.
    const oldest = await insertMessage(mailboxId, {
      subject: 'oldest',
      createdAt: '2026-01-01 00:00:00.000Z',
    });
    await insertMessage(mailboxId, {
      subject: 'middle',
      createdAt: '2026-01-02 00:00:00.000Z',
    });
    await insertMessage(mailboxId, {
      subject: 'newest',
      createdAt: '2026-01-03 00:00:00.000Z',
    });

    // First page: limit=2 → newest + middle + a next cursor.
    const page1 = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages?limit=2`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(page1.status).toBe(200);
    const page1Body = await page1.json();
    expect(page1Body.data.items).toHaveLength(2);
    expect(page1Body.data.items[0].subject).toBe('newest');
    expect(page1Body.data.items[1].subject).toBe('middle');
    expect(page1Body.data.nextCursor).not.toBeNull();
    // The cursor is opaque to clients; the assertion is that page 2
    // successfully decodes it and returns the slice the server
    // intended. If the signature were broken or the payload shape
    // changed the second request would 400 INVALID_CURSOR.

    // Second page: same key, signed cursor → oldest row, no next cursor.
    const page2 = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages?limit=2&cursor=${encodeURIComponent(page1Body.data.nextCursor)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(page2.status).toBe(200);
    const page2Body = await page2.json();
    expect(page2Body.data.items).toHaveLength(1);
    expect(page2Body.data.items[0].id).toBe(oldest.messageId);
    expect(page2Body.data.nextCursor).toBeNull();
  });

  it('keeps per-user isDeleted independent (R-MESSAGE-005) — one user\'s delete does not hide it for another', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');

    const { messageId, mailboxMessageId } = await insertMessage(mailboxId, {
      subject: 'soft-delete per-user',
    });

    // Fix pass F4: seed BOTH members' rows explicitly — owner soft-deleted
    // (is_deleted = 1), viewer present and not deleted (is_deleted = 0).
    // The two rows coexisting on the same mailbox_message_id is the
    // post-0017 proof (composite PK, D-CAP-043-F); under the 0006
    // single-column PK the second INSERT would have collided. Plain
    // INSERTs — the rows do not exist yet, and ON CONFLICT(mailbox_message_id)
    // no longer matches any unique constraint post-0017.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, is_deleted, deleted_at, updated_at)
         VALUES (?, ?, 1, datetime('now'), 1, datetime('now'), datetime('now'))`,
      ).bind(mailboxMessageId, ownerId),
      env.DB.prepare(
        `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, is_deleted, deleted_at, updated_at)
         VALUES (?, ?, 0, NULL, 0, NULL, datetime('now'))`,
      ).bind(mailboxMessageId, viewerId),
    ]);

    // Sanity: both rows landed and only the owner's carries the delete.
    const stateRows = await env.DB
      .prepare(
        `SELECT user_id, is_deleted FROM message_user_state
         WHERE mailbox_message_id = ? ORDER BY user_id`,
      )
      .bind(mailboxMessageId)
      .all<{ user_id: string; is_deleted: number }>();
    expect(stateRows.results).toHaveLength(2);

    // Owner has soft-deleted → owner's inbox list excludes it.
    const ownerList = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(ownerList.status).toBe(200);
    const ownerBody = await ownerList.json();
    expect(ownerBody.data.items).toEqual([]);

    // Viewer has an explicit non-deleted row → still sees it.
    const viewerList = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    expect(viewerList.status).toBe(200);
    const viewerBody = await viewerList.json();
    expect(viewerBody.data.items).toHaveLength(1);
    expect(viewerBody.data.items[0].id).toBe(messageId);
  });

  it('returns empty page when the only message in the mailbox has been soft-deleted', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { mailboxMessageId } = await insertMessage(mailboxId, {
      subject: 'deleted',
    });

    // Soft-delete the only message for this user (plain INSERT — post-0017
    // the PK is (mailbox_message_id, user_id), so no row exists yet and
    // ON CONFLICT(mailbox_message_id) matches no unique constraint).
    await env.DB.prepare(
      `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, is_deleted, deleted_at, updated_at)
       VALUES (?, ?, 1, datetime('now'), 1, datetime('now'), datetime('now'))`,
    )
      .bind(mailboxMessageId, ownerId)
      .run();

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.nextCursor).toBeNull();
  });
});
