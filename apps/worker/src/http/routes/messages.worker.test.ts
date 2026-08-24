// messages.worker.test.ts — CAP-022 inbox endpoints.
//
// Worker-pool tests for GET /api/v1/mailboxes/:mailboxId/messages (list),
// GET .../messages/:messageId (detail), GET .../messages/:messageId/thread
// (CAP-043 Slice 2), PATCH .../messages/:messageId/read,
// PATCH .../messages/:messageId/star and DELETE .../messages/:messageId
// (CAP-043 Slice 3). Uses SELF.fetch to exercise the full request pipeline.
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
  /** RFC 5322 Message-ID, stored verbatim (typically `<id@host>`). */
  readonly messageIdHeader?: string | null;
  /** RFC 5322 In-Reply-To, stored verbatim (typically `<id@host>`). */
  readonly inReplyToHeader?: string | null;
  /** RFC 5322 References, stored verbatim (`<a@x> <b@y>`). */
  readonly referencesHeader?: string;
  /** D-CAP-043-C: when set, the column wins over header-derived roots. */
  readonly threadId?: string | null;
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
         thread_id, message_id_header, in_reply_to_header, references_header, status,
         received_at, created_at, updated_at)
       VALUES (?, ?, 'Sender', ?, '<p>body</p>', 'body',
         ?, ?, ?, ?, 'delivered', ?, ?, ?)`,
    ).bind(
      messageId,
      fromAddress,
      subject,
      opts.threadId ?? null,
      opts.messageIdHeader ?? null,
      opts.inReplyToHeader ?? null,
      opts.referencesHeader ?? '',
      createdAt,
      createdAt,
      createdAt,
    ),
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

  // Slice 2 fix G2 (arch M1 / code M4 / sec L2): before the filter, the
  // detail query 404'd nothing the inbox list hid — a soft-deleted
  // message was still fully readable at its detail URL.
  it('returns 404 MESSAGE_NOT_FOUND for a message soft-deleted for the calling user, 200 for another member (R-MESSAGE-005)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    const { messageId, mailboxMessageId } = await insertMessage(mailboxId, {
      subject: 'soft-deleted detail',
    });

    // Owner soft-deletes (D-CAP-043-B seeding: plain INSERT — post-0017
    // the PK is (mailbox_message_id, user_id) and no row exists yet).
    await env.DB.prepare(
      `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, is_deleted, deleted_at, updated_at)
       VALUES (?, ?, 0, NULL, 1, datetime('now'), datetime('now'))`,
    )
      .bind(mailboxMessageId, ownerId)
      .run();

    const ownerResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(ownerResponse.status).toBe(404);
    const ownerBody = await ownerResponse.json();
    expect(ownerBody.error.code).toBe('MESSAGE_NOT_FOUND');

    // The viewer has no state row — the message is fully readable.
    const viewerResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    expect(viewerResponse.status).toBe(200);
    const viewerBody = await viewerResponse.json();
    expect(viewerBody.data.id).toBe(messageId);
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
    // single 400 INVALID_CURSOR — not 500, not 200. (Fix (d): the payload
    // now names this endpoint's surface, so this test still exercises the
    // SIGNATURE check rather than accidentally relying on shape rejection.)
    const { signCursor } = await import('../../platform/cursor');
    const otherKey = 'attacker-supplied-key-different-from-env';
    const foreignCursor = await signCursor(
      { createdAt: '2026-01-01 00:00:00', id: crypto.randomUUID(), surface: 'messages' },
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

  it('CAP-044 Slice 2 fix (d): rejects a cursor minted for the audit-events surface', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // Signed with the REAL CURSOR_SIGNING_KEY (a plain string var in the
    // worker-pool test) but naming the audit-events API's surface. Both
    // paginated surfaces share the signing key; the surface discriminator
    // is the only thing keeping an audit-events cursor from being replayed
    // as a messages page boundary (and vice versa — the audit test file
    // covers the other direction).
    const { signCursor } = await import('../../platform/cursor');
    const key = env.CURSOR_SIGNING_KEY;
    if (typeof key !== 'string') {
      throw new Error('worker-pool test expects CURSOR_SIGNING_KEY as a plain string var');
    }
    const auditSurfaceCursor = await signCursor(
      { createdAt: '2026-01-01 00:00:00', id: crypto.randomUUID(), surface: 'audit-events' },
      key,
    );

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages?cursor=${encodeURIComponent(auditSurfaceCursor)}`,
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

// ---------------------------------------------------------------------------
// CAP-043 Slice 2 — GET .../messages/:messageId/thread (AC 9 + AC 10).
// D-CAP-043-C: the thread root resolves at read time, priority
// [thread_id, references[0], in_reply_to, message_id_header], with the
// `<…>` token brackets KEPT so a reply's extracted root equals the root
// message's verbatim Message-ID header. R-MESSAGE-005: soft-delete and
// isRead resolve per user inside the thread, same as the inbox list.
// ---------------------------------------------------------------------------

describe('GET /api/v1/mailboxes/:mailboxId/messages/:messageId/thread — CAP-043 Slice 2', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('assembles a 3-message thread from references/in-reply-to, oldest-first, with the resolved rootId', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // Root: own Message-ID only. Replies: references + in-reply-to chain.
    // Bracket-ful ids exactly as email-core stores the verbatim headers.
    const root = await insertMessage(mailboxId, {
      subject: 'Thread root',
      messageIdHeader: '<root@example.com>',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const reply1 = await insertMessage(mailboxId, {
      subject: 'Reply 1',
      messageIdHeader: '<reply-1@example.com>',
      inReplyToHeader: '<root@example.com>',
      referencesHeader: '<root@example.com>',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const reply2 = await insertMessage(mailboxId, {
      subject: 'Reply 2',
      messageIdHeader: '<reply-2@example.com>',
      inReplyToHeader: '<reply-1@example.com>',
      referencesHeader: '<root@example.com> <reply-1@example.com>',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    // Unrelated message — must not join the thread.
    await insertMessage(mailboxId, {
      subject: 'Unrelated',
      messageIdHeader: '<unrelated@example.com>',
      createdAt: '2026-01-04T00:00:00.000Z',
    });

    // Anchor the NEWEST reply — resolution must walk back to the root.
    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${reply2.messageId}/thread`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.rootId).toBe('<root@example.com>');
    expect(body.data.items).toHaveLength(3);
    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual([
      root.messageId,
      reply1.messageId,
      reply2.messageId,
    ]);
  });

  it('D-CAP-043-C: a set thread_id column wins over header-derived roots', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // M1 has BOTH a thread_id and a decoy references root — the column wins.
    const m1 = await insertMessage(mailboxId, {
      subject: 'column root 1',
      threadId: 'T-1',
      referencesHeader: '<decoy@example.com>',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const m2 = await insertMessage(mailboxId, {
      subject: 'column root 2',
      threadId: 'T-1',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    // Same decoy references root but NO thread_id — resolves to the decoy,
    // which is a different root than T-1, so it must NOT join.
    await insertMessage(mailboxId, {
      subject: 'decoy only',
      referencesHeader: '<decoy@example.com>',
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${m1.messageId}/thread`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.rootId).toBe('T-1');
    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual([
      m1.messageId,
      m2.messageId,
    ]);
  });

  it('returns a singleton thread (rootId = own Message-ID) for a message with no references', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const solo = await insertMessage(mailboxId, {
      subject: 'solo',
      messageIdHeader: '<solo@example.com>',
    });

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${solo.messageId}/thread`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.rootId).toBe('<solo@example.com>');
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe(solo.messageId);
  });

  it('a message with no threading headers at all is a singleton and never fuses with other header-less messages', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // Both resolve to a NULL root. NULL-root rows must not match each
    // other — two unrelated header-less messages are separate threads.
    const a = await insertMessage(mailboxId, {
      subject: 'no headers A',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertMessage(mailboxId, {
      subject: 'no headers B',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${a.messageId}/thread`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.rootId).toBeNull();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe(a.messageId);
  });

  it('returns 404 MESSAGE_NOT_FOUND for a non-existent message and for a message in ANOTHER mailbox (no leak)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailbox1 = await createMailbox(domainId, ownerId, 'one');
    const mailbox2 = await createMailbox(domainId, ownerId, 'two');

    // The message lives in mailbox2; the request targets mailbox1.
    const { messageId } = await insertMessage(mailbox2, {
      subject: 'other mailbox',
      messageIdHeader: '<cross@example.com>',
    });

    const crossMailbox = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailbox1}/messages/${messageId}/thread`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const nonExistent = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailbox1}/messages/${crypto.randomUUID()}/thread`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(crossMailbox.status).toBe(404);
    expect(nonExistent.status).toBe(404);
    const crossBody = await crossMailbox.json();
    const missingBody = await nonExistent.json();
    // Identical code + shape: an attacker cannot distinguish "exists
    // elsewhere" from "does not exist" (R-AUTHZ-004 no-leak).
    expect(crossBody.error.code).toBe('MESSAGE_NOT_FOUND');
    expect(missingBody.error.code).toBe('MESSAGE_NOT_FOUND');
    expect(Object.keys(crossBody.error).sort()).toEqual(
      Object.keys(missingBody.error).sort(),
    );
  });

  it('excludes a soft-deleted-for-caller thread member but keeps it for another member (R-MESSAGE-005)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');

    const root = await insertMessage(mailboxId, {
      subject: 'thread root',
      messageIdHeader: '<root@example.com>',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertMessage(mailboxId, {
      subject: 'reply',
      referencesHeader: '<root@example.com>',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const anchor = await insertMessage(mailboxId, {
      subject: 'anchor',
      referencesHeader: '<root@example.com>',
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    // Owner soft-deletes the ROOT message only (D-CAP-043-B seeding:
    // plain INSERT, no row exists yet under the 0017 composite PK).
    await env.DB.prepare(
      `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, is_deleted, deleted_at, updated_at)
       VALUES (?, ?, 0, NULL, 1, datetime('now'), datetime('now'))`,
    )
      .bind(root.mailboxMessageId, ownerId)
      .run();

    // Owner's thread drops the deleted member (2 items)…
    const ownerResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${anchor.messageId}/thread`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(ownerResponse.status).toBe(200);
    const ownerBody = await ownerResponse.json();
    expect(ownerBody.data.items).toHaveLength(2);
    expect(
      ownerBody.data.items.map((item: { id: string }) => item.id),
    ).not.toContain(root.messageId);

    // …the viewer still sees the full thread (3 items).
    const viewerResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${anchor.messageId}/thread`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    expect(viewerResponse.status).toBe(200);
    const viewerBody = await viewerResponse.json();
    expect(viewerBody.data.items).toHaveLength(3);
  });

  it('returns 404 when the ANCHOR itself is soft-deleted for the calling user, 200 for another member', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');

    const anchor = await insertMessage(mailboxId, {
      subject: 'deleted anchor',
      messageIdHeader: '<anchor@example.com>',
    });

    await env.DB.prepare(
      `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, is_deleted, deleted_at, updated_at)
       VALUES (?, ?, 0, NULL, 1, datetime('now'), datetime('now'))`,
    )
      .bind(anchor.mailboxMessageId, ownerId)
      .run();

    const ownerResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${anchor.messageId}/thread`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(ownerResponse.status).toBe(404);
    const ownerBody = await ownerResponse.json();
    expect(ownerBody.error.code).toBe('MESSAGE_NOT_FOUND');

    const viewerResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${anchor.messageId}/thread`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    expect(viewerResponse.status).toBe(200);
  });

  it('resolves per-user isRead inside the thread (R-MESSAGE-005)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');

    const root = await insertMessage(mailboxId, {
      subject: 'thread root',
      messageIdHeader: '<root@example.com>',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const reply = await insertMessage(mailboxId, {
      subject: 'reply',
      referencesHeader: '<root@example.com>',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    // Owner has read the reply; the root is unread for both users.
    await env.DB.prepare(
      `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, is_deleted, deleted_at, updated_at)
       VALUES (?, ?, 1, datetime('now'), 0, NULL, datetime('now'))`,
    )
      .bind(reply.mailboxMessageId, ownerId)
      .run();

    const ownerThread = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${root.messageId}/thread`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(ownerThread.status).toBe(200);
    const ownerBody = await ownerThread.json();
    expect(ownerBody.data.items).toHaveLength(2);
    expect(ownerBody.data.items[0].id).toBe(root.messageId);
    expect(ownerBody.data.items[0].isRead).toBe(0);
    expect(ownerBody.data.items[1].id).toBe(reply.messageId);
    expect(ownerBody.data.items[1].isRead).toBe(1);

    // Viewer has no message_user_state rows — everything reads 0.
    const viewerThread = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${root.messageId}/thread`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    expect(viewerThread.status).toBe(200);
    const viewerBody = await viewerThread.json();
    expect(viewerBody.data.items.map((item: { isRead: number }) => item.isRead)).toEqual([0, 0]);
  });

  // Slice 2 fix G1 (sec M1): D1 rejects statements binding >100
  // parameters. Before the cap, this scenario bound 120 ids in the
  // recipients IN clause and the whole request failed.
  it('caps the thread at the newest 50 members — 120 same-root members return 200 with exactly 50 items (G1)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // Root (member 0) + 119 replies sharing the references root.
    const total = 120;
    const ids: string[] = [];
    const statements: Array<ReturnType<typeof env.DB.prepare>> = [];
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < total; i++) {
      const messageId = crypto.randomUUID();
      ids.push(messageId);
      const createdAt = new Date(base + i * 60_000).toISOString();
      statements.push(
        env.DB.prepare(
          `INSERT INTO messages (id, from_address, from_name, subject, html_body, text_body,
             thread_id, message_id_header, in_reply_to_header, references_header, status,
             received_at, created_at, updated_at)
           VALUES (?, ?, 'Sender', ?, '<p>body</p>', 'body',
             NULL, ?, NULL, ?, 'delivered', ?, ?, ?)`,
        ).bind(
          messageId,
          'sender@example.com',
          `member ${i}`,
          i === 0 ? '<big-thread@example.com>' : `<member-${i}@example.com>`,
          i === 0 ? '' : '<big-thread@example.com>',
          createdAt,
          createdAt,
          createdAt,
        ),
        env.DB.prepare(
          `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
           VALUES (?, ?, ?, 0, 0, 'inbox', ?)`,
        ).bind(crypto.randomUUID(), mailboxId, messageId, createdAt),
        env.DB.prepare(
          `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
           VALUES (?, ?, 'recipient@example.com', 'Recipient', 'to', ?)`,
        ).bind(crypto.randomUUID(), messageId, createdAt),
      );
    }
    // Keep each batch modest; every statement is tiny and binds ≤13 ids.
    for (let i = 0; i < statements.length; i += 120) {
      await env.DB.batch(statements.slice(i, i + 120));
    }

    // Anchor the NEWEST member; the response must be the newest-50
    // window (replies 70..119), presented oldest-first.
    const anchorId = ids[total - 1] as string;
    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${anchorId}/thread`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // rootId stays correct even though the root fell outside the window.
    expect(body.data.rootId).toBe('<big-thread@example.com>');
    const items: Array<{ id: string; recipients: { to: Array<{ address: string }> } }> =
      body.data.items;
    expect(items).toHaveLength(50);
    // Oldest-first window: first item is member 70, last is the anchor.
    expect(items[0].id).toBe(ids[70]);
    expect(items[49].id).toBe(anchorId);
    // The oldest members — including the root — are excluded.
    const itemIds = new Set(items.map((item) => item.id));
    expect(itemIds.has(ids[0] as string)).toBe(false);
    expect(itemIds.has(ids[1] as string)).toBe(false);
    // Every item carries parsed recipients — proof the bounded
    // IN-clause (≤50 ids) actually executed.
    for (const item of items) {
      expect(item.recipients.to).toHaveLength(1);
      expect(item.recipients.to[0]?.address).toBe('recipient@example.com');
    }
  });

  // Slice 2 fix G3 (code L1): an empty-string message_id_header must
  // resolve NULL (singleton), not fuse every header-less message onto
  // the shared root ''.
  it('treats an empty-string message_id_header as header-less — two such messages are separate singleton threads (G3)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const a = await insertMessage(mailboxId, {
      subject: 'empty id A',
      messageIdHeader: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const b = await insertMessage(mailboxId, {
      subject: 'empty id B',
      messageIdHeader: '',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    for (const [message, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const response = await SELF.fetch(
        `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${message.messageId}/thread`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.rootId).toBeNull();
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].id).toBe(message.messageId);
      expect(body.data.items[0].id).not.toBe(other.messageId);
    }
  });

  // Slice 2 fix G4 (code M2): malformed References values must fall
  // through the first-<…>-token tier — no garbage root like '' or a
  // partial — onto the next valid tier.
  it('malformed references_header values fall through to the in_reply_to tier (G4)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const root = await insertMessage(mailboxId, {
      subject: 'G4 fallback root',
      messageIdHeader: '<fallback@example.com>',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const malformedValues = ['no brackets here', '<', '><'];
    const malformed = malformedValues.map(
      (value, index) =>
        insertMessage(mailboxId, {
          subject: `G4 malformed ${index}`,
          referencesHeader: value,
          inReplyToHeader: '<fallback@example.com>',
          messageIdHeader: `<self-${index}@example.com>`,
          createdAt: `2026-01-0${index + 2}T00:00:00.000Z`,
        }),
    );
    const [m0, m1, m2] = await Promise.all(malformed);

    // Each malformed message must resolve root '<fallback@example.com>'
    // via its In-Reply-To and join the full thread.
    for (const message of [m0, m1, m2]) {
      const response = await SELF.fetch(
        `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${message.messageId}/thread`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.rootId).toBe('<fallback@example.com>');
      expect(body.data.items.map((item: { id: string }) => item.id)).toEqual([
        root.messageId,
        m0.messageId,
        m1.messageId,
        m2.messageId,
      ]);
    }
  });

  it('malformed references_header values with no in_reply_to fall through to the own message-id tier as singletons (G4)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // Each message's own Message-ID is its only remaining root source.
    const malformedValues = ['no brackets here', '<', '><'];
    const seeded = await Promise.all(
      malformedValues.map((value, index) =>
        insertMessage(mailboxId, {
          subject: `G4 singleton ${index}`,
          referencesHeader: value,
          messageIdHeader: `<only-root-${index}@example.com>`,
          createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        }),
      ),
    );

    for (const [index, message] of seeded.entries()) {
      const response = await SELF.fetch(
        `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${message.messageId}/thread`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.rootId).toBe(`<only-root-${index}@example.com>`);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].id).toBe(message.messageId);
    }
  });

  // Slice 2 fix G5 (QA L1): pin the in_reply_to-only tier — no
  // References header, but In-Reply-To points at the root's Message-ID.
  it('threads a reply carrying only In-Reply-To with the root holding that Message-ID (G5)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const m1 = await insertMessage(mailboxId, {
      subject: 'G5 root',
      messageIdHeader: '<root@x>',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const m2 = await insertMessage(mailboxId, {
      subject: 'G5 reply',
      inReplyToHeader: '<root@x>',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${m2.messageId}/thread`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.rootId).toBe('<root@x>');
    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual([
      m1.messageId,
      m2.messageId,
    ]);
  });
});

// ---------------------------------------------------------------------------
// CAP-043 Slice 3 — PATCH .../messages/:messageId/star (AC 13 + AC 14).
// D-CAP-043-A: the star is MAILBOX-LEVEL (mailbox_messages.is_starred) —
// one atomic UPDATE ... RETURNING, last-write-wins. Any member's star is
// every member's star (AC 17). D-CAP-043-H: rides the read surface
// (requirePermission('message.read') + assertCan('read')).
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/star — CAP-043 Slice 3', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('AC 14: toggles the star both directions — each response value matches the DB truth', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId, mailboxMessageId } = await insertMessage(mailboxId);

    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/star`;
    const star = async () =>
      SELF.fetch(url, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      });

    // Unstarred → starred.
    const first = await star();
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.id).toBe(messageId);
    expect(firstBody.data.isStarred).toBe(1);
    const dbFirst = await env.DB.prepare('SELECT is_starred FROM mailbox_messages WHERE id = ?')
      .bind(mailboxMessageId)
      .first<{ is_starred: number }>();
    expect(dbFirst?.is_starred).toBe(1);

    // Starred → unstarred.
    const second = await star();
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.isStarred).toBe(0);
    const dbSecond = await env.DB.prepare('SELECT is_starred FROM mailbox_messages WHERE id = ?')
      .bind(mailboxMessageId)
      .first<{ is_starred: number }>();
    expect(dbSecond?.is_starred).toBe(0);
  });

  it('AC 17 / D-CAP-043-A: the star is mailbox-level — another member\'s list shows isStarred = 1', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    const { messageId } = await insertMessage(mailboxId, { subject: 'shared star' });

    // Owner stars it.
    const starResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/star`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    expect(starResponse.status).toBe(200);

    // The viewer never touched the star, but the flag is mailbox-level:
    // their list resolves isStarred = 1 too (AC 17).
    const viewerList = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    expect(viewerList.status).toBe(200);
    const viewerBody = await viewerList.json();
    expect(viewerBody.data.items).toHaveLength(1);
    expect(viewerBody.data.items[0].isStarred).toBe(1);
  });

  it('returns 404 MESSAGE_NOT_FOUND for a non-existent message and for a message in ANOTHER mailbox (identical envelope)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailbox1 = await createMailbox(domainId, ownerId, 'one');
    const mailbox2 = await createMailbox(domainId, ownerId, 'two');

    const { messageId } = await insertMessage(mailbox2, { subject: 'other mailbox' });

    const crossMailbox = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailbox1}/messages/${messageId}/star`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );
    const nonExistent = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailbox1}/messages/${crypto.randomUUID()}/star`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );

    expect(crossMailbox.status).toBe(404);
    expect(nonExistent.status).toBe(404);
    const crossBody = await crossMailbox.json();
    const missingBody = await nonExistent.json();
    expect(crossBody.error.code).toBe('MESSAGE_NOT_FOUND');
    expect(missingBody.error.code).toBe('MESSAGE_NOT_FOUND');
    expect(Object.keys(crossBody.error).sort()).toEqual(Object.keys(missingBody.error).sort());
  });

  it('blocks a non-member from starring (IDOR)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const otherId = await createUserWithRole('member', 'other@example.com');
    const otherToken = await createSession(otherId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/star`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${otherToken}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/star`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays the stored response on same key + body — the star does NOT toggle twice', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId, mailboxMessageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();
    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/star`;
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey };

    const first = await SELF.fetch(url, { method: 'PATCH', headers });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.isStarred).toBe(1);

    // Replay: same key, same (empty) body → the STORED response, not a
    // second toggle. A naive re-execution would have flipped it back to 0.
    const replay = await SELF.fetch(url, { method: 'PATCH', headers });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody).toEqual(firstBody);

    const row = await env.DB.prepare('SELECT is_starred FROM mailbox_messages WHERE id = ?')
      .bind(mailboxMessageId)
      .first<{ is_starred: number }>();
    expect(row?.is_starred).toBe(1);
  });

  it('returns 409 when the same Idempotency-Key is reused with a different body', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();
    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/star`;
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey };

    const first = await SELF.fetch(url, { method: 'PATCH', headers, body: '' });
    expect(first.status).toBe(200);

    const second = await SELF.fetch(url, {
      method: 'PATCH',
      headers,
      body: '{"different": "body"}',
    });
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  // Slice 3 fix H1: the star write, idempotency record, and audit row now run
  // in ONE D1 batch (implicit transaction). Two same-key toggles racing to
  // settle must leave the store exactly as a single toggle would — the
  // invariants below hold under every interleaving, so the test cannot pass
  // by luck of scheduling.
  it('H1: same-key concurrent star toggles settle atomically — identical responses, one record, one audit row, DB matches the response', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId, mailboxMessageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();
    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/star`;
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey };

    const [a, b] = await Promise.all([
      SELF.fetch(url, { method: 'PATCH', headers }),
      SELF.fetch(url, { method: 'PATCH', headers }),
    ]);

    // The loser either lost the INSERT race (batch rolled back → replayed
    // the winner's stored response) or arrived after commit (begin-path
    // replay). Either way: both 200 with byte-identical bodies.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const aBody = await a.json();
    const bBody = await b.json();
    expect(bBody).toEqual(aBody);
    expect([0, 1]).toContain(aBody.data.isStarred);

    // Exactly one record for the key — never two, whatever interleaved.
    const recordCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM idempotency_records WHERE idempotency_key = ?',
    )
      .bind(idempotencyKey)
      .first<{ count: number }>();
    expect(recordCount?.count).toBe(1);

    // The DB matches the response value: the loser's flip rolled back with
    // its failed record INSERT (a double-toggle would leave the DB at the
    // OPPOSITE of the replayed response).
    const row = await env.DB.prepare('SELECT is_starred FROM mailbox_messages WHERE id = ?')
      .bind(mailboxMessageId)
      .first<{ is_starred: number }>();
    expect(row?.is_starred).toBe(aBody.data.isStarred);

    // Exactly one audit row — the loser's audit INSERT rolled back too.
    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM audit_events WHERE resource_id = ? AND action = 'message.star_toggled'",
    )
      .bind(messageId)
      .first<{ count: number }>();
    expect(auditCount?.count).toBe(1);
  });

  // Slice 3 fix H4 / R-AUDIT-001 / D-CAP-043-I: the star transition writes
  // its audit row in the SAME batch as the business write; a replay (which
  // never re-runs the write) must add none.
  it('H4: a star toggle writes exactly one audit row; a replay adds none', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();
    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/star`;
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey };

    const first = await SELF.fetch(url, { method: 'PATCH', headers });
    expect(first.status).toBe(200);

    const auditRow = await env.DB
      .prepare(
        "SELECT actor_user_id, action, resource_type, resource_id, metadata FROM audit_events WHERE resource_id = ? AND action = 'message.star_toggled'",
      )
      .bind(messageId)
      .first<{
        actor_user_id: string;
        action: string;
        resource_type: string;
        resource_id: string;
        metadata: string;
      }>();
    expect(auditRow?.actor_user_id).toBe(ownerId);
    expect(auditRow?.action).toBe('message.star_toggled');
    expect(auditRow?.resource_type).toBe('message');
    expect(auditRow?.resource_id).toBe(messageId);
    expect(JSON.parse(auditRow?.metadata ?? '{}')).toEqual({ mailboxId, isStarred: 1 });

    // Replay the same key: the stored response returns, the batch never
    // runs, no second audit row appears.
    const replay = await SELF.fetch(url, { method: 'PATCH', headers });
    expect(replay.status).toBe(200);

    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM audit_events WHERE resource_id = ? AND action = 'message.star_toggled'",
    )
      .bind(messageId)
      .first<{ count: number }>();
    expect(auditCount?.count).toBe(1);
  });

  // H10: no Authorization header → 401 on BOTH Slice 3 mutating routes
  // (requirePermission runs before the idempotency middleware and before
  // any write, so no key is required to see the 401).
  it('H10: unauthenticated requests are rejected 401 on both routes before any write', async () => {
    const starResponse = await SELF.fetch(
      'http://localhost/api/v1/mailboxes/00000000-0000-4000-8000-000000000001/messages/00000000-0000-4000-8000-000000000002/star',
      {
        method: 'PATCH',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    expect(starResponse.status).toBe(401);
    const starBody = await starResponse.json();
    expect(starBody.error.code).toBe('AUTHENTICATION_REQUIRED');

    const deleteResponse = await SELF.fetch(
      'http://localhost/api/v1/mailboxes/00000000-0000-4000-8000-000000000001/messages/00000000-0000-4000-8000-000000000002',
      {
        method: 'DELETE',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    expect(deleteResponse.status).toBe(401);
    const deleteBody = await deleteResponse.json();
    expect(deleteBody.error.code).toBe('AUTHENTICATION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// CAP-043 Slice 3 — DELETE .../messages/:messageId (AC 15).
// D-CAP-043-B: per-user soft delete — only the calling user's
// message_user_state row flips to is_deleted = 1; the UPSERT conflicts on
// the post-0017 composite PK and preserves is_read / read_at (gate 1).
// D-CAP-043-E: 204 No Content with an empty body; replays return the same
// empty 204 (R-API-004).
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/mailboxes/:mailboxId/messages/:messageId — CAP-043 Slice 3', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('AC 15 + AC 17: returns 204 with an empty body; hides the message from the deleter but not from another member', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    const { messageId } = await insertMessage(mailboxId, { subject: 'soft delete me' });

    const deleteResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Idempotency-Key': crypto.randomUUID() },
      },
    );

    // D-CAP-043-E: 204 with an empty body.
    expect(deleteResponse.status).toBe(204);
    expect(await deleteResponse.text()).toBe('');

    // Owner: gone from the list, 404 at the detail URL.
    const ownerList = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerListBody = await ownerList.json();
    expect(ownerListBody.data.items).toEqual([]);
    const ownerDetail = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(ownerDetail.status).toBe(404);

    // Viewer: still fully present (AC 17 — per-user delete, R-MESSAGE-005).
    const viewerList = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    const viewerListBody = await viewerList.json();
    expect(viewerListBody.data.items).toHaveLength(1);
    expect(viewerListBody.data.items[0].id).toBe(messageId);
    const viewerDetail = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    expect(viewerDetail.status).toBe(200);
  });

  it('gate 1: the delete UPSERT preserves is_read / read_at when the user already has a state row', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId, mailboxMessageId } = await insertMessage(mailboxId);

    // Read first — creates the state row with is_read = 1 and a read_at.
    const readResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    expect(readResponse.status).toBe(200);

    const beforeDelete = await env.DB
      .prepare('SELECT is_read, read_at, is_deleted FROM message_user_state WHERE mailbox_message_id = ? AND user_id = ?')
      .bind(mailboxMessageId, ownerId)
      .first<{ is_read: number; read_at: string; is_deleted: number }>();
    expect(beforeDelete?.is_read).toBe(1);
    expect(beforeDelete?.read_at).not.toBeNull();
    expect(beforeDelete?.is_deleted).toBe(0);

    // Delete second — UPSERT on the composite PK must only flip the
    // delete flags; is_read / read_at ride through untouched.
    const deleteResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    expect(deleteResponse.status).toBe(204);

    const afterDelete = await env.DB
      .prepare('SELECT is_read, read_at, is_deleted, deleted_at FROM message_user_state WHERE mailbox_message_id = ? AND user_id = ?')
      .bind(mailboxMessageId, ownerId)
      .first<{ is_read: number; read_at: string; is_deleted: number; deleted_at: string }>();
    expect(afterDelete?.is_read).toBe(1);
    expect(afterDelete?.read_at).toBe(beforeDelete?.read_at);
    expect(afterDelete?.is_deleted).toBe(1);
    expect(afterDelete?.deleted_at).not.toBeNull();
  });

  it('returns 404 MESSAGE_NOT_FOUND for a non-existent message and for a message in ANOTHER mailbox (identical envelope)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailbox1 = await createMailbox(domainId, ownerId, 'one');
    const mailbox2 = await createMailbox(domainId, ownerId, 'two');

    const { messageId } = await insertMessage(mailbox2, { subject: 'other mailbox' });

    const crossMailbox = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailbox1}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );
    const nonExistent = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailbox1}/messages/${crypto.randomUUID()}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );

    expect(crossMailbox.status).toBe(404);
    expect(nonExistent.status).toBe(404);
    const crossBody = await crossMailbox.json();
    const missingBody = await nonExistent.json();
    expect(crossBody.error.code).toBe('MESSAGE_NOT_FOUND');
    expect(missingBody.error.code).toBe('MESSAGE_NOT_FOUND');
    expect(Object.keys(crossBody.error).sort()).toEqual(Object.keys(missingBody.error).sort());
  });

  it('blocks a non-member from deleting (IDOR)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const otherId = await createUserWithRole('member', 'other@example.com');
    const otherToken = await createSession(otherId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${otherToken}`, 'Idempotency-Key': IDEMPOTENCY_KEY },
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays the stored 204 — same key + body returns the same empty 204, one record, delete not re-run', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId, mailboxMessageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();
    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`;
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey };

    const first = await SELF.fetch(url, { method: 'DELETE', headers });
    expect(first.status).toBe(204);
    expect(await first.text()).toBe('');

    const afterFirst = await env.DB
      .prepare('SELECT deleted_at FROM message_user_state WHERE mailbox_message_id = ? AND user_id = ?')
      .bind(mailboxMessageId, ownerId)
      .first<{ deleted_at: string }>();
    expect(afterFirst?.deleted_at).not.toBeNull();

    // Replay: same key, same (empty) body → the stored empty 204. This is
    // the path that would throw if the replay rebuilt the Response with a
    // non-null body on a null-body status (D-CAP-043-E).
    const replay = await SELF.fetch(url, { method: 'DELETE', headers });
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe('');

    // Exactly one record for the key, and the delete row was untouched by
    // the replay (deleted_at identical — the business write did not re-run).
    const afterReplay = await env.DB
      .prepare('SELECT deleted_at FROM message_user_state WHERE mailbox_message_id = ? AND user_id = ?')
      .bind(mailboxMessageId, ownerId)
      .first<{ deleted_at: string }>();
    expect(afterReplay?.deleted_at).toBe(afterFirst?.deleted_at);

    const recordCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM idempotency_records WHERE idempotency_key = ?',
    )
      .bind(idempotencyKey)
      .first<{ count: number }>();
    expect(recordCount?.count).toBe(1);
  });

  it('returns 409 when the same Idempotency-Key is reused with a different body', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();
    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`;
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey };

    const first = await SELF.fetch(url, { method: 'DELETE', headers, body: '' });
    expect(first.status).toBe(204);

    const second = await SELF.fetch(url, {
      method: 'DELETE',
      headers,
      body: '{"different": "body"}',
    });
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  // Slice 3 fix H9: two same-key DELETEs racing to settle must leave the
  // store exactly as a single delete would — the invariants below hold
  // under every interleaving.
  it('H9: same-key concurrent DELETEs settle atomically — both 204, one record, one audit row, is_deleted = 1', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId, mailboxMessageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();
    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`;
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey };

    const [a, b] = await Promise.all([
      SELF.fetch(url, { method: 'DELETE', headers }),
      SELF.fetch(url, { method: 'DELETE', headers }),
    ]);

    // The loser either lost the INSERT race (batch rolled back → replayed
    // the winner's stored empty 204) or arrived after commit (begin-path
    // replay). Either way: both 204, empty bodies.
    expect(a.status).toBe(204);
    expect(b.status).toBe(204);
    expect(await a.text()).toBe('');
    expect(await b.text()).toBe('');

    // Exactly one record for the key.
    const recordCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM idempotency_records WHERE idempotency_key = ?',
    )
      .bind(idempotencyKey)
      .first<{ count: number }>();
    expect(recordCount?.count).toBe(1);

    // The soft-delete landed for the caller — the loser's duplicate UPSERT
    // rolled back with its failed record INSERT.
    const stateRow = await env.DB
      .prepare(
        'SELECT is_deleted FROM message_user_state WHERE mailbox_message_id = ? AND user_id = ?',
      )
      .bind(mailboxMessageId, ownerId)
      .first<{ is_deleted: number }>();
    expect(stateRow?.is_deleted).toBe(1);

    // Exactly one audit row.
    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM audit_events WHERE resource_id = ? AND action = 'message.soft_deleted'",
    )
      .bind(messageId)
      .first<{ count: number }>();
    expect(auditCount?.count).toBe(1);
  });

  // Slice 3 fix H4 / R-AUDIT-001 / D-CAP-043-I: the soft-delete transition
  // writes its audit row in the SAME batch as the business write; a replay
  // (which never re-runs the write) must add none.
  it('H4: a soft delete writes exactly one audit row; a replay adds none', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const idempotencyKey = crypto.randomUUID();
    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`;
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey };

    const first = await SELF.fetch(url, { method: 'DELETE', headers });
    expect(first.status).toBe(204);

    const auditRow = await env.DB
      .prepare(
        "SELECT actor_user_id, action, resource_type, resource_id, metadata FROM audit_events WHERE resource_id = ? AND action = 'message.soft_deleted'",
      )
      .bind(messageId)
      .first<{
        actor_user_id: string;
        action: string;
        resource_type: string;
        resource_id: string;
        metadata: string;
      }>();
    expect(auditRow?.actor_user_id).toBe(ownerId);
    expect(auditRow?.action).toBe('message.soft_deleted');
    expect(auditRow?.resource_type).toBe('message');
    expect(auditRow?.resource_id).toBe(messageId);
    expect(JSON.parse(auditRow?.metadata ?? '{}')).toEqual({ mailboxId });

    // Replay the same key: the stored empty 204 returns, no second audit row.
    const replay = await SELF.fetch(url, { method: 'DELETE', headers });
    expect(replay.status).toBe(204);

    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM audit_events WHERE resource_id = ? AND action = 'message.soft_deleted'",
    )
      .bind(messageId)
      .first<{ count: number }>();
    expect(auditCount?.count).toBe(1);
  });

  // H10 / R-MESSAGE-005 / gate 1: the whole scenario is seeded through the
  // REAL routes (F4 convention from the review) — no direct state-row
  // inserts. The viewer reads first, the owner deletes; the viewer's read
  // state must survive the owner's delete untouched.
  it('H10: another member\'s read state survives the owner\'s delete — seeded through the real routes (F4)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    const { messageId, mailboxMessageId } = await insertMessage(mailboxId, {
      subject: 'read survives delete',
    });

    // Viewer marks the message read via the real PATCH read route.
    const readResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/read`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${viewerToken}`, 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    expect(readResponse.status).toBe(200);

    // Owner soft-deletes it via the real DELETE route.
    const deleteResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    expect(deleteResponse.status).toBe(204);

    // The viewer's state row kept is_read = 1 and is_deleted = 0 (gate 1:
    // the owner's UPSERT cannot touch another member's row).
    const viewerState = await env.DB
      .prepare(
        'SELECT is_read, read_at, is_deleted FROM message_user_state WHERE mailbox_message_id = ? AND user_id = ?',
      )
      .bind(mailboxMessageId, viewerId)
      .first<{ is_read: number; read_at: string; is_deleted: number }>();
    expect(viewerState?.is_read).toBe(1);
    expect(viewerState?.read_at).not.toBeNull();
    expect(viewerState?.is_deleted).toBe(0);

    // And the message is still fully present in the viewer's list (AC 17).
    const viewerList = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    expect(viewerList.status).toBe(200);
    const viewerListBody = await viewerList.json();
    expect(viewerListBody.data.items).toHaveLength(1);
    expect(viewerListBody.data.items[0].id).toBe(messageId);
    // The list contract resolves isRead as 0/1 (SQLite integer).
    expect(viewerListBody.data.items[0].isRead).toBe(1);
  });

  // H10: deleting an already-soft-deleted message with a FRESH key is an
  // idempotent no-op success (204), not 404 — the mailbox_messages row
  // still exists; only the calling user's state row says deleted.
  it('H10: a second delete with a fresh key returns 204 (idempotent no-op, not 404)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    const { messageId } = await insertMessage(mailboxId);

    const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`;

    const first = await SELF.fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
    });
    expect(first.status).toBe(204);

    const second = await SELF.fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
    });
    expect(second.status).toBe(204);
    expect(await second.text()).toBe('');
  });

  // H10 / D-CAP-043-H: star and soft delete ride the read surface — a
  // VIEWER-role mailbox member (member system role) can do both.
  it('H10 / D-CAP-043-H: a viewer-role member can star and soft-delete on the read surface', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    const { messageId } = await insertMessage(mailboxId, { subject: 'viewer tidies inbox' });

    // Viewer stars the message — 200, and the mailbox-level flag flips.
    const starResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}/star`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${viewerToken}`, 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    expect(starResponse.status).toBe(200);
    const starBody = await starResponse.json();
    expect(starBody.data.isStarred).toBe(1);

    // Viewer soft-deletes it from their own view — 204.
    const deleteResponse = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${viewerToken}`, 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    expect(deleteResponse.status).toBe(204);

    // The viewer's list is empty; the owner still sees the message,
    // starred by the viewer (mailbox-level star, AC 17 / D-CAP-043-A).
    const viewerList = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages`,
      { headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    const viewerListBody = await viewerList.json();
    expect(viewerListBody.data.items).toEqual([]);

    const ownerList = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    const ownerListBody = await ownerList.json();
    expect(ownerListBody.data.items).toHaveLength(1);
    expect(ownerListBody.data.items[0].isStarred).toBe(1);
  });
});
