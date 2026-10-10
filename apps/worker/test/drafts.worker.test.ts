// apps/worker/test/drafts.worker.test.ts — CAP-047 server draft slice.
//
// Worker-pool tests for the CAP-047 draft routes. Uses SELF.fetch to
// exercise the full request pipeline: router → authn → requirePermission
// → assertCan → D1 batch insert (POST/PATCH/send) or D1 SELECT (GET) → envelope.
// The send block also verifies the post-commit queue handoff and provider
// job shape; create/read/PATCH remain provider-free.
//
// The fixtures mirror compose.worker.test.ts: same role/permission seed,
// same session helper, same domain + mailbox helpers. Only the send block
// creates an active provider connection and touches the outbound queue.
//
// Slice: POST + GET cover the original server create / read slices. The
// PATCH block at the bottom covers the optimistic-concurrency update
// slice (`If-Match`, atomic conditional batch, replay, authz, atomicity).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { encrypt, hashPassword, importEncryptionKey } from '../src/platform/crypto';
import { systemIds } from '../src/platform/ids';

const ENCRYPTION_KEY = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Seeding helpers (mirrors compose.worker.test.ts / messages.worker.test.ts).
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
    // administrator: read + send + mailbox.create + role.manage.
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
    // member: read + send + mailbox.create. No role.manage.
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

const DRAFTS_PATH = (mailboxId: string) => `http://localhost/api/v1/mailboxes/${mailboxId}/drafts`;

const IDEMPOTENCY_KEY = 'drafts-test-key-001';

// ---------------------------------------------------------------------------
// POST /api/v1/mailboxes/:mailboxId/drafts
// ---------------------------------------------------------------------------

describe('POST /api/v1/mailboxes/:mailboxId/drafts — CAP-047 server draft-create slice', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  // -------- happy path + DB row shape ------------------------------------

  it('owner creates a draft: 201 + Location + DB rows land atomically', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'me');

    const requestBody = JSON.stringify({
      subject: 'Quarterly review',
      body_text: 'Drafting the Q2 numbers…',
      body_html: '<p>Drafting the Q2 numbers…</p>',
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
    });

    const response = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
    });

    expect(response.status).toBe(201);
    const location = response.headers.get('Location');
    expect(location).toMatch(/^\/api\/v1\/drafts\/[0-9a-f-]{36}$/);

    const body = (await response.json()) as {
      data: { messageId: string; status: string; updatedAt: string };
    };
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.status).toBe('draft');
    expect(body.data.messageId).toBe(location?.split('/').pop());
    expect(body.data.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Message row: status 'draft', from the mailbox address, created_by set.
    const msg = await env.DB.prepare(
      `SELECT from_address, subject, status, created_by_user_id,
              html_body, text_body
         FROM messages WHERE id = ?`,
    )
      .bind(body.data.messageId)
      .first<{
        from_address: string;
        subject: string;
        status: string;
        created_by_user_id: string;
        html_body: string;
        text_body: string;
      }>();
    expect(msg?.from_address).toBe('me@example.com');
    expect(msg?.subject).toBe('Quarterly review');
    expect(msg?.status).toBe('draft');
    expect(msg?.created_by_user_id).toBe(ownerId);
    expect(msg?.html_body).toBe('<p>Drafting the Q2 numbers…</p>');
    expect(msg?.text_body).toBe('Drafting the Q2 numbers…');

    // Recipients: one 'to', one 'cc', one 'bcc'.
    const recipients = await env.DB.prepare(
      `SELECT type, address FROM message_recipients
         WHERE message_id = ?
         ORDER BY type, address`,
    )
      .bind(body.data.messageId)
      .all<{ type: string; address: string }>();
    const typed = (recipients.results ?? []).map((r) => `${r.type}:${r.address}`);
    expect(typed).toEqual(['bcc:bcc@example.com', 'cc:cc@example.com', 'to:to@example.com']);

    // Mailbox association: folder 'drafts', is_read true (the author saw it).
    const mailboxMessage = await env.DB.prepare(
      `SELECT folder, is_read FROM mailbox_messages
         WHERE mailbox_id = ? AND message_id = ?`,
    )
      .bind(mailboxId, body.data.messageId)
      .first<{ folder: string; is_read: number }>();
    expect(mailboxMessage?.folder).toBe('drafts');
    expect(mailboxMessage?.is_read).toBe(1);

    // Audit row: action=draft.created, resourceType=message, resourceId =
    // the new message id, requestId stamped by middleware, no body /
    // recipient metadata (no metadata column or null).
    const auditRow = await env.DB.prepare(
      `SELECT actor_user_id, action, resource_type, resource_id,
              request_id, metadata
         FROM audit_events
         WHERE resource_id = ?`,
    )
      .bind(body.data.messageId)
      .first<{
        actor_user_id: string;
        action: string;
        resource_type: string;
        resource_id: string;
        request_id: string | null;
        metadata: string | null;
      }>();
    expect(auditRow).toBeTruthy();
    expect(auditRow?.actor_user_id).toBe(ownerId);
    expect(auditRow?.action).toBe('draft.created');
    expect(auditRow?.resource_type).toBe('message');
    expect(auditRow?.resource_id).toBe(body.data.messageId);
    expect(auditRow?.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(auditRow?.metadata).toBeNull();

    // Idempotency row exists with the stored 201 body.
    const idem = await env.DB.prepare(
      `SELECT response_status, response_json, request_hash
         FROM idempotency_records
         WHERE actor_id = ? AND operation = ?
           AND idempotency_key = ?`,
    )
      .bind(ownerId, 'POST /api/v1/mailboxes/:mailboxId/drafts', IDEMPOTENCY_KEY)
      .first<{
        response_status: number;
        response_json: string;
        request_hash: string;
      }>();
    expect(idem?.response_status).toBe(201);
    const parsedStored = JSON.parse(idem?.response_json ?? '{}') as {
      data?: { messageId?: string; status?: string; updatedAt?: string };
    };
    expect(parsedStored.data?.messageId).toBe(body.data.messageId);
    expect(parsedStored.data?.status).toBe('draft');

    // Draft creation must not create an outbound job.
    const outboundJobs = await env.DB.prepare('SELECT COUNT(*) AS n FROM outbound_jobs').first<{
      n: number;
    }>();
    expect(outboundJobs?.n).toBe(0);
  });

  // -------- schema validation: empty `to` is allowed --------------------

  it('accepts an empty `to` array (drafts can be authored before any recipient)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const response = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: JSON.stringify({
        subject: 'Early draft',
        body_text: 'No recipients yet.',
        to: [],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'drafts-empty-to-001',
      },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: { messageId: string; status: string };
    };
    expect(body.data.status).toBe('draft');

    const recipientCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?',
    )
      .bind(body.data.messageId)
      .first<{ n: number }>();
    expect(recipientCount?.n).toBe(0);
  });

  // -------- schema validation: malformed / over-limit body --------------

  it('returns 400 for malformed JSON', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const response = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: '{not valid json',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'drafts-malformed-001',
      },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_JSON');
  });

  it('returns 400 VALIDATION_ERROR when body_text exceeds 65,536 chars', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const response = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: JSON.stringify({
        subject: 'too long',
        body_text: 'x'.repeat(65_537),
        to: [],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'drafts-oversize-001',
      },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');

    // No draft or idempotency row landed — the malformed request is
    // rejected at the validation boundary before the D1 batch.
    const draftCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE created_by_user_id = ?',
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(draftCount?.n).toBe(0);
    const idemCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?',
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(idemCount?.n).toBe(0);
  });

  // -------- idempotency replay -----------------------------------------

  it('replays the stored 201 response when same key + same body (R-API-004)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const idempotencyKey = 'drafts-replay-key-001';
    const requestBody = JSON.stringify({
      subject: 'Replay me',
      body_text: 'body',
      to: ['to@example.com'],
    });

    const first = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey,
      },
    });
    expect(first.status).toBe(201);
    const firstText = await first.text();
    const firstBody = JSON.parse(firstText) as { data: { messageId: string } };
    const firstMessageId = firstBody.data.messageId;

    const second = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey,
      },
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('Location')).toBe(`/api/v1/drafts/${firstMessageId}`);
    const secondText = await second.text();
    const secondBody = JSON.parse(secondText) as {
      data: { messageId: string; status: string };
    };
    expect(secondBody.data.messageId).toBe(firstMessageId);
    expect(secondBody.data.status).toBe('draft');

    // Bodies are byte-identical (R-API-004 — same Idempotency-Key replays
    // the stored body verbatim).
    expect(secondText).toBe(firstText);

    // No duplicate rows landed — the replay short-circuited before the
    // D1 batch.
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE created_by_user_id = ?',
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(messageCount?.n).toBe(1);

    const auditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events
         WHERE action = 'draft.created' AND actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(auditCount?.n).toBe(1);

    const idemCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM idempotency_records WHERE idempotency_key = ?',
    )
      .bind(idempotencyKey)
      .first<{ n: number }>();
    expect(idemCount?.n).toBe(1);
  });

  // -------- idempotency conflict ---------------------------------------

  it('returns 409 IDEMPOTENCY_KEY_REUSED when same key + different body', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const idempotencyKey = 'drafts-reuse-key-001';

    const first = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: JSON.stringify({
        subject: 'First',
        body_text: 'first body',
        to: ['first@example.com'],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey,
      },
    });
    expect(first.status).toBe(201);

    const second = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: JSON.stringify({
        subject: 'Second',
        body_text: 'different body',
        to: ['second@example.com'],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey,
      },
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { error: { code: string } };
    expect(secondBody.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Only the first body landed.
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE created_by_user_id = ?',
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(messageCount?.n).toBe(1);
  });

  // -------- authz --------------------------------------------------------

  it('returns 401 without authentication', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/00000000-0000-4000-8000-000000000001/drafts`,
      {
        method: 'POST',
        body: JSON.stringify({ subject: 'x', body_text: 'x', to: [] }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'drafts-noauth-001',
        },
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 MAILBOX_ACCESS_DENIED when a non-member tries to draft in another mailbox (IDOR, R-AUTHZ-004)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const intruderId = await createUserWithRole('member', 'intruder@example.com');
    const intruderToken = await createSession(intruderId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'private');

    const response = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: JSON.stringify({
        subject: 'IDOR attempt',
        body_text: 'should be denied',
        to: [],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${intruderToken}`,
        'Idempotency-Key': 'drafts-idor-001',
      },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  });

  it('returns 403 MAILBOX_ACCESS_DENIED when a viewer-role member tries to draft', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const viewerId = await createUserWithRole('member', 'viewer@example.com');
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'shared');
    await addMailboxMember(mailboxId, viewerId, 'viewer');

    const response = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: JSON.stringify({
        subject: 'viewer attempt',
        body_text: 'should be denied',
        to: [],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`,
        'Idempotency-Key': 'drafts-viewer-001',
      },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  });

  it('lets a sender-role member create a draft (allowed by the permission matrix)', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const senderId = await createUserWithRole('member', 'sender@example.com');
    const senderToken = await createSession(senderId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'shared');
    await addMailboxMember(mailboxId, senderId, 'sender');

    const response = await SELF.fetch(DRAFTS_PATH(mailboxId), {
      method: 'POST',
      body: JSON.stringify({
        subject: 'Sender draft',
        body_text: 'allowed',
        to: ['recipient@example.com'],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${senderToken}`,
        'Idempotency-Key': 'drafts-sender-001',
      },
    });

    expect(response.status).toBe(201);
  });

  // -------- atomicity: failing business statement rolls the batch back ---

  it('a failing business statement in the batch leaves no partial rows', async () => {
    const ownerId = await createUserWithRole('member', 'owner@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const idempotencyKey = 'drafts-atomic-rollback-001';
    const requestBody = JSON.stringify({
      subject: 'Atomic rollback',
      body_text: 'body',
      to: ['to@example.com'],
    });

    // Make the later audit INSERT collide after the message, recipient,
    // and mailbox association statements have succeeded. This exercises
    // the actual business-batch rollback rather than the idempotency-race
    // branch.
    const auditId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO audit_events
         (id, actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at)
       VALUES (?, ?, 'setup.claim', 'rollback-fixture', NULL, NULL, NULL, datetime('now'))`,
    )
      .bind(auditId, ownerId)
      .run();

    const messageId = crypto.randomUUID();
    const uuidSpy = vi.spyOn(systemIds, 'uuid');
    let uuidCalls = 0;
    uuidSpy.mockImplementation(() => {
      uuidCalls += 1;
      // The request-id middleware consumes the first generated UUID. The
      // route then asks for messageId and auditEventId respectively.
      if (uuidCalls === 2) return messageId;
      if (uuidCalls === 3) return auditId;
      return crypto.randomUUID();
    });

    try {
      const response = await SELF.fetch(DRAFTS_PATH(mailboxId), {
        method: 'POST',
        body: requestBody,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      // The audit UNIQUE violation is an internal batch failure. The
      // important contract here is that none of the earlier statements
      // leaked through the failed D1 batch.
      expect(response.status).toBe(500);
    } finally {
      uuidSpy.mockRestore();
    }

    const messageCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?')
      .bind(messageId)
      .first<{ n: number }>();
    expect(messageCount?.n).toBe(0);

    const recipientCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?',
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(recipientCount?.n).toBe(0);

    const mmCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM mailbox_messages WHERE message_id = ?',
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(mmCount?.n).toBe(0);

    const draftAuditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events
         WHERE actor_user_id = ? AND action = 'draft.created'`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(draftAuditCount?.n).toBe(0);

    const idemCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM idempotency_records WHERE idempotency_key = ?',
    )
      .bind(idempotencyKey)
      .first<{ n: number }>();
    expect(idemCount?.n).toBe(0);

    const fixtureAudit = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE id = ?')
      .bind(auditId)
      .first<{ n: number }>();
    expect(fixtureAudit?.n).toBe(1);

    // No outbound job is created when the batch fails.
    const outboundJobs = await env.DB.prepare('SELECT COUNT(*) AS n FROM outbound_jobs').first<{
      n: number;
    }>();
    expect(outboundJobs?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/drafts/:draftId
//
// CAP-047 read slice: every helper exists in the file above, so this
// describe focuses on:
//   - owner envelope shape (snake_case bodies / snake_case timestamps,
//     status='draft', three recipient arrays, no write-side leaks);
//   - empty recipient arrays are serialised as `[]`;
//   - foreign actor reading another mailbox's draft → 404 MESSAGE_NOT_FOUND;
//   - viewer member is allowed to read; unauthenticated GET → 401;
//   - non-draft existing message and unknown draft ID both → 404;
//   - response has no extraneous body/header fields.
//
// `createDraftViaPost` reuses the live POST route so this block exercises
// the same pipeline a real client would (no test-private INSERT path that
// could drift from the production writer). The direct INSERTs are reserved
// for the negative paths the create route does not produce.
// ---------------------------------------------------------------------------

const DRAFT_PATH = (draftId: string) => `http://localhost/api/v1/drafts/${draftId}`;

async function createDraftViaPost(
  mailboxId: string,
  token: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<string> {
  const response = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/drafts`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
  });
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { data: { messageId: string } };
  return payload.data.messageId;
}

describe('GET /api/v1/drafts/:draftId — CAP-047 server draft-read slice', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  // -------- happy path: owner reads the full envelope ---------------------

  it('owner reads the full envelope: snake_case wire keys, RFC-3339 timestamps, status=draft, three recipient arrays; no writes', async () => {
    const ownerId = await createUserWithRole('member', 'owner-read@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'owner-mailbox');

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Read me back',
        body_text: 'text body content',
        body_html: '<p>html body content</p>',
        to: ['to-read@example.com'],
        cc: ['cc-read@example.com'],
        bcc: ['bcc-read@example.com'],
      },
      'drafts-read-001',
    );

    // Snapshot write-side counts before the GET — the GET must be a pure
    // read with no idempotency / audit / outbound / recipient mutation.
    const auditBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const idemBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const recipientsBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    const messagesBefore = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ n: number }>();
    const mailboxMessagesBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM mailbox_messages WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    const outboundBefore = await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbound_jobs`).first<{
      n: number;
    }>();

    const response = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = (await response.json()) as {
      data: {
        id: string;
        mailboxId: string;
        subject: string;
        body_text: string;
        body_html: string;
        to: string[];
        cc: string[];
        bcc: string[];
        status: string;
        created_at: string;
        updated_at: string;
      };
    };

    // Envelope shape is EXACTLY the CAP-047 contract — sorted key order
    // and no extras (assertion `Object.keys(body).sort() === [...]
    // .sort()` is implicit because `toEqual` is a deep equality on the
    // data object itself; we additionally pin the data-object keys).
    expect(Object.keys(body)).toEqual(['data']);
    expect(Object.keys(body.data).sort()).toEqual(
      [
        'bcc',
        'body_html',
        'body_text',
        'cc',
        'created_at',
        'id',
        'mailboxId',
        'status',
        'subject',
        'to',
        'updated_at',
      ].sort(),
    );
    expect(body.data.id).toBe(messageId);
    expect(body.data.mailboxId).toBe(mailboxId);
    expect(body.data.subject).toBe('Read me back');
    expect(body.data.body_text).toBe('text body content');
    expect(body.data.body_html).toBe('<p>html body content</p>');
    expect(body.data.status).toBe('draft');
    expect(body.data.to).toEqual(['to-read@example.com']);
    expect(body.data.cc).toEqual(['cc-read@example.com']);
    expect(body.data.bcc).toEqual(['bcc-read@example.com']);

    // RFC-3339 wire timestamps — pinned format includes milliseconds and
    // the literal `Z` suffix (UTC). This is the same shape the create
    // response used (Date#toISOString()), so the surface stays stable
    // across create and read.
    expect(body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // The SQL storage is `YYYY-MM-DD HH:MM:SS`; the wire conversion is
    // one instant expressed two ways. Round-trip the wire back to a
    // comparable form and verify it sits on the same day as the stored
    // row — a regression here means the read route is leaking a
    // different instant than the create wrote, not just a mis-formatted
    // string.
    const storedRow = await env.DB.prepare(
      `SELECT created_at, updated_at FROM messages WHERE id = ?`,
    )
      .bind(messageId)
      .first<{ created_at: string; updated_at: string }>();
    expect(storedRow).toBeTruthy();
    expect(body.data.created_at.slice(0, 19).replace('T', ' ')).toBe(storedRow?.created_at);
    expect(body.data.updated_at.slice(0, 19).replace('T', ' ')).toBe(storedRow?.updated_at);

    // Read-only: every write-side counter is unchanged.
    const auditAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(auditAfter?.n).toBe(auditBefore?.n);

    const idemAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(idemAfter?.n).toBe(idemBefore?.n);

    const recipientsAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(recipientsAfter?.n).toBe(recipientsBefore?.n);

    const messagesAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ n: number }>();
    expect(messagesAfter?.n).toBe(messagesBefore?.n);

    const mailboxMessagesAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM mailbox_messages WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(mailboxMessagesAfter?.n).toBe(mailboxMessagesBefore?.n);

    const outboundAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbound_jobs`).first<{
      n: number;
    }>();
    expect(outboundAfter?.n).toBe(outboundBefore?.n);
  });

  it('binds a mailbox-scoped read when a draft has multiple mailbox associations (CAP-062)', async () => {
    const ownerId = await createUserWithRole('member', 'owner-multi-mailbox@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain('multi-mailbox.example.com');
    const firstMailboxId = await createMailbox(domainId, ownerId, 'first');
    const secondMailboxId = await createMailbox(domainId, ownerId, 'second');
    const messageId = await createDraftViaPost(
      firstMailboxId,
      ownerToken,
      { subject: 'Shared draft', body_text: 'body', to: [] },
      'drafts-read-multi-mailbox-001',
    );

    // The current create route writes one association. Add a second one to
    // model a shared message without changing the production writer.
    await env.DB.prepare(
      `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
       VALUES (?, ?, ?, 0, 0, 'drafts', ?)`,
    )
      .bind(crypto.randomUUID(), secondMailboxId, messageId, new Date().toISOString())
      .run();

    const response = await SELF.fetch(
      `${DRAFT_PATH(messageId)}?mailboxId=${encodeURIComponent(secondMailboxId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string; mailboxId: string } };
    expect(body.data.id).toBe(messageId);
    expect(body.data.mailboxId).toBe(secondMailboxId);
  });

  // -------- empty recipient arrays --------------------------------------

  it('returns empty `to` / `cc` / `bcc` arrays (serialised as []) when the draft has no recipients', async () => {
    const ownerId = await createUserWithRole('member', 'owner-empty@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'No recipients',
        body_text: 'Solo draft',
        to: [],
      },
      'drafts-read-empty-001',
    );

    const response = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    expect(response.status).toBe(200);
    // Read the body once so we can both parse and assert on the raw
    // string — multiple readers on the same Response is not supported.
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      data: { to: string[]; cc: string[]; bcc: string[] };
    };
    expect(body.data.to).toEqual([]);
    expect(body.data.cc).toEqual([]);
    expect(body.data.bcc).toEqual([]);
    // Empty arrays must be JSON-array serialised, not `null` / `undefined`
    // / missing — a regression here would break the wire contract's
    // required-field list.
    expect(raw).toContain('"to":[]');
    expect(raw).toContain('"cc":[]');
    expect(raw).toContain('"bcc":[]');
  });

  // -------- no leak: foreign actor receives 404 MESSAGE_NOT_FOUND ------

  it("returns 404 MESSAGE_NOT_FOUND (NOT 403) when a foreign actor reads another mailbox's draft", async () => {
    const ownerId = await createUserWithRole('member', 'owner-leak@example.com');
    const ownerToken = await createSession(ownerId);
    const foreignId = await createUserWithRole('member', 'foreign@example.com');
    const foreignToken = await createSession(foreignId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'private');

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Private draft',
        body_text: 'should not leak',
        to: ['to-leak@example.com'],
      },
      'drafts-read-leak-001',
    );

    // Foreign actor: not the owner and has no mailbox membership.
    const response = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${foreignToken}` },
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MESSAGE_NOT_FOUND');

    // The response must NOT be 403 — the existence leak posture is that
    // a foreign actor receives the SAME envelope a non-existent ID would.
    const ownerResponse = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerBody = (await ownerResponse.json()) as { error?: { code?: string } };
    expect(ownerResponse.status).toBe(200);
    expect(ownerBody.error).toBeUndefined();
  });

  // -------- viewer member can read --------------------------------------

  it('lets a viewer-role member read a draft (read op is allowed for viewer per R-MAILBOX-003 matrix)', async () => {
    const ownerId = await createUserWithRole('member', 'owner-viewer@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerId = await createUserWithRole('member', 'viewer-read@example.com');
    const viewerToken = await createSession(viewerId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'shared');
    await addMailboxMember(mailboxId, viewerId, 'viewer');

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Viewer can see',
        body_text: 'body',
        to: ['to-viewer@example.com'],
      },
      'drafts-read-viewer-001',
    );

    const response = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${viewerToken}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string; subject: string } };
    expect(body.data.id).toBe(messageId);
    expect(body.data.subject).toBe('Viewer can see');
  });

  // -------- sender member can read --------------------------------------

  it('lets a sender-role member read a draft (read op is allowed for sender per R-MAILBOX-003 matrix)', async () => {
    const ownerId = await createUserWithRole('member', 'owner-sender@example.com');
    const ownerToken = await createSession(ownerId);
    const senderId = await createUserWithRole('member', 'sender-read@example.com');
    const senderToken = await createSession(senderId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'shared');
    await addMailboxMember(mailboxId, senderId, 'sender');

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Sender can read',
        body_text: 'body',
        body_html: '<p>body</p>',
        to: ['to-sender-read@example.com'],
        cc: ['cc-sender-read@example.com'],
        bcc: ['bcc-sender-read@example.com'],
      },
      'drafts-read-sender-001',
    );

    const response = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${senderToken}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        id: string;
        mailboxId: string;
        subject: string;
        body_text: string;
        body_html: string;
        to: string[];
        cc: string[];
        bcc: string[];
        status: string;
        created_at: string;
        updated_at: string;
      };
    };
    expect(body.data.id).toBe(messageId);
    expect(body.data.mailboxId).toBe(mailboxId);
    expect(body.data.subject).toBe('Sender can read');
    expect(body.data.body_text).toBe('body');
    expect(body.data.body_html).toBe('<p>body</p>');
    expect(body.data.to).toEqual(['to-sender-read@example.com']);
    expect(body.data.cc).toEqual(['cc-sender-read@example.com']);
    expect(body.data.bcc).toEqual(['bcc-sender-read@example.com']);
    expect(body.data.status).toBe('draft');
    expect(body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // -------- administrator role does not grant mailbox content access -----

  it("requires explicit mailbox membership before an administrator can read another user's draft", async () => {
    const ownerId = await createUserWithRole('member', 'owner-admin@example.com');
    const ownerToken = await createSession(ownerId);
    const adminId = await createUserWithRole('administrator', 'admin@example.com');
    const adminToken = await createSession(adminId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'admin-shared');

    // Global role.manage must not reveal mailbox content without a grant.
    const memberRow = await env.DB.prepare(
      `SELECT role FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?`,
    )
      .bind(mailboxId, adminId)
      .first<{ role: string }>();
    expect(memberRow).toBeNull();

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Private draft',
        body_text: 'body',
        to: ['to-admin-read@example.com'],
      },
      'drafts-read-admin-001',
    );

    const denied = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(denied.status).toBe(404);
    expect((await denied.json()).error.code).toBe('MESSAGE_NOT_FOUND');

    await addMailboxMember(mailboxId, adminId, 'viewer');
    const response = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        id: string;
        mailboxId: string;
        subject: string;
        body_text: string;
        body_html: string;
        to: string[];
        cc: string[];
        bcc: string[];
        status: string;
        created_at: string;
        updated_at: string;
      };
    };
    expect(body.data.id).toBe(messageId);
    expect(body.data.mailboxId).toBe(mailboxId);
    expect(body.data.subject).toBe('Private draft');
    expect(body.data.body_text).toBe('body');
    expect(body.data.to).toEqual(['to-admin-read@example.com']);
    expect(body.data.status).toBe('draft');
    expect(body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('unauthenticated GET returns 401 AUTHENTICATION_REQUIRED', async () => {
    const ownerId = await createUserWithRole('member', 'owner-noauth@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'No auth',
        body_text: 'body',
        to: [],
      },
      'drafts-read-noauth-001',
    );

    const response = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  // -------- no leak: non-draft + unknown ID both 404 --------------------

  it('returns 404 MESSAGE_NOT_FOUND for a non-draft existing message (no status leak)', async () => {
    const ownerId = await createUserWithRole('member', 'owner-nondraft@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // Insert a 'delivered' message directly — the create route only
    // produces 'draft' rows, so we go around it for this single negative
    // path. The mailbox_messages association is identical in shape.
    const deliveredId = crypto.randomUUID();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (
           id, from_address, from_name, subject, html_body, text_body,
           message_id_header, in_reply_to_header, references_header,
           status, created_by_user_id, created_at, updated_at
         ) VALUES (?, 'delivered@example.com', '', 'Not a draft', '', 'body', '<old@host>', NULL, '', 'delivered', ?, ?, ?)`,
      ).bind(deliveredId, ownerId, now, now),
      env.DB.prepare(
        `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
         VALUES (?, ?, ?, 0, 0, 'inbox', ?)`,
      ).bind(crypto.randomUUID(), mailboxId, deliveredId, now),
    ]);

    const response = await SELF.fetch(DRAFT_PATH(deliveredId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('returns 404 MESSAGE_NOT_FOUND for an unknown draft ID (envelope identical to a non-draft ID)', async () => {
    const ownerId = await createUserWithRole('member', 'owner-unknown@example.com');
    const ownerToken = await createSession(ownerId);
    const unknownId = crypto.randomUUID();

    // Also create a real draft so the unknown-vs-known contrast is honest
    // and the route has at least one row on disk to test against.
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);
    await createDraftViaPost(
      mailboxId,
      ownerToken,
      { subject: 'real', body_text: 'body', to: [] },
      'drafts-read-unknown-001',
    );

    const response = await SELF.fetch(DRAFT_PATH(unknownId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MESSAGE_NOT_FOUND');

    // Cross-check: a non-draft known ID and an unknown ID both 404 with
    // the same envelope — the existence-leak posture.
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const deliveredId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (
           id, from_address, from_name, subject, html_body, text_body,
           message_id_header, in_reply_to_header, references_header,
           status, created_by_user_id, created_at, updated_at
         ) VALUES (?, 'x@example.com', '', '', '', '', NULL, NULL, '', 'queued', ?, ?, ?)`,
      ).bind(deliveredId, ownerId, now, now),
      env.DB.prepare(
        `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
         VALUES (?, ?, ?, 0, 0, 'inbox', ?)`,
      ).bind(crypto.randomUUID(), mailboxId, deliveredId, now),
    ]);
    const nondraftResponse = await SELF.fetch(DRAFT_PATH(deliveredId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const nondraftBody = (await nondraftResponse.json()) as { error: { code: string } };
    expect(nondraftResponse.status).toBe(404);
    expect(nondraftBody.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  // -------- response has no extraneous body / header fields ------------

  it('response has no extraneous body fields (no message_id / in_reply_to / references / audit metadata)', async () => {
    const ownerId = await createUserWithRole('member', 'owner-extraneous@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    // The wire contract must NOT leak message-id / reply / references
    // headers — those live on `messages.message_id_header` etc. and have
    // no place on the draft read surface.
    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Wire surface',
        body_text: 'body',
        body_html: '<p>body</p>',
        to: ['to-wire@example.com'],
      },
      'drafts-read-wire-001',
    );

    // Patch the row to populate header columns that must NOT appear on
    // the wire — this asserts the response is bounded by the contract
    // and does not surface any column as an extra.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE messages SET message_id_header = '<drafted@host>', in_reply_to_header = '<reply@host>', references_header = '<a@host> <b@host>' WHERE id = ?`,
      ).bind(messageId),
    ]);

    const response = await SELF.fetch(DRAFT_PATH(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    expect(response.status).toBe(200);
    // Read once — both the raw-text assertions and the JSON structural
    // assertions ride on this single read (a Response body can only be
    // consumed once).
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      data: Record<string, unknown>;
    };
    expect(raw).not.toContain('message_id_header');
    expect(raw).not.toContain('messageIdHeader');
    expect(raw).not.toContain('in_reply_to_header');
    expect(raw).not.toContain('inReplyToHeader');
    expect(raw).not.toContain('references_header');
    expect(raw).not.toContain('referencesHeader');
    expect(raw).not.toContain('drafted@host');
    expect(raw).not.toContain('reply@host');
    expect(raw).not.toContain('a@host');
    // Audit metadata + from_address + from_name must also stay off the wire.
    expect(raw).not.toContain('from_address');
    expect(raw).not.toContain('fromAddress');
    expect(raw).not.toContain('audit');
    expect(raw).not.toContain('requestId');
    expect(raw).not.toContain('metadata');

    // Pin the data-object keys again here so a future drift in the
    // route surfaces a precise diff (the sorted comparison also catches
    // case / snake-vs-camel accidents).
    expect(Object.keys(body.data).sort()).toEqual(
      [
        'bcc',
        'body_html',
        'body_text',
        'cc',
        'created_at',
        'id',
        'mailboxId',
        'status',
        'subject',
        'to',
        'updated_at',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/drafts/:draftId
//
// CAP-047 / D-CAP-047-PATCH slice: optimistic-concurrency update. The full
// router is exercised — SELF.fetch runs through authn → requirePermission
// → requireIdempotencyKey → mailbox-scoped assertCan → conditional D1
// batch → envelope. No queue is touched; no mocks interfere with
// production D1 writes (testing.md §Mocking).
//
// The describe is intentionally bounded: every assertion in the task
// has a corresponding it(). Existing POST / GET suites are not modified.
// ---------------------------------------------------------------------------

const PATCH_DRAFT_PATH = (draftId: string) => `http://localhost/api/v1/drafts/${draftId}`;

/**
 * Read a draft via the live GET route so the PATCH tests start from the
 * same shape a real client would observe. Returns the parsed body +
 * the wire `updated_at` value (the next round-trip's `If-Match`).
 */
async function getDraftEnvelope(
  draftId: string,
  token: string,
): Promise<{
  status: number;
  body: {
    data: {
      id: string;
      mailboxId: string;
      subject: string;
      body_text: string;
      body_html: string;
      to: string[];
      cc: string[];
      bcc: string[];
      status: string;
      created_at: string;
      updated_at: string;
    };
  } | null;
  updatedAt: string | null;
}> {
  const response = await SELF.fetch(DRAFT_PATH(draftId), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) {
    return { status: response.status, body: null, updatedAt: null };
  }
  const body = (await response.json()) as {
    data: {
      id: string;
      mailboxId: string;
      subject: string;
      body_text: string;
      body_html: string;
      to: string[];
      cc: string[];
      bcc: string[];
      status: string;
      created_at: string;
      updated_at: string;
    };
  };
  return { status: 200, body, updatedAt: body.data.updated_at };
}

function requireUpdatedAt(snapshot: { updatedAt: string | null }): string {
  if (typeof snapshot.updatedAt !== 'string') {
    throw new Error('expected a successful draft response with updated_at');
  }
  return snapshot.updatedAt;
}

function requireDraftBody(snapshot: {
  body: {
    data: {
      created_at: string;
    };
  } | null;
}): { data: { created_at: string } } {
  if (!snapshot.body) {
    throw new Error('expected a successful draft response body');
  }
  return snapshot.body;
}

describe('PATCH /api/v1/drafts/:draftId — CAP-047 server draft-update slice', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  // -------- happy path: owner patch, exact GET envelope, newer ts -------

  it('owner PATCH updates subject/body and returns the exact GET-compatible envelope with a newer updated_at', async () => {
    const ownerId = await createUserWithRole('member', 'owner-patch@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'patch-mailbox');

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Initial subject',
        body_text: 'initial body',
        body_html: '<p>initial body</p>',
        to: ['to-initial@example.com'],
        cc: ['cc-initial@example.com'],
        bcc: ['bcc-initial@example.com'],
      },
      'drafts-patch-001',
    );

    // Pre-validation read so we know the If-Match value + the
    // pre-update audit / idempotency / recipient row counts.
    const before = await getDraftEnvelope(messageId, ownerToken);
    expect(before.status).toBe(200);
    const ifMatch = requireUpdatedAt(before);
    expect(ifMatch).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);

    const auditBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const idemBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const recipientsBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();

    // PATCH subject + body only — leave recipients untouched (the
    // partial-patch path through COALESCE).
    const response = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({
        subject: 'Updated subject',
        body_text: 'updated text body',
        body_html: '<p>updated html body</p>',
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': 'drafts-patch-001-key',
        'If-Match': ifMatch,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const raw = await response.text();
    const body = JSON.parse(raw) as {
      data: {
        id: string;
        mailboxId: string;
        subject: string;
        body_text: string;
        body_html: string;
        to: string[];
        cc: string[];
        bcc: string[];
        status: string;
        created_at: string;
        updated_at: string;
      };
    };

    // Exact GET-compatible envelope: same key set as the GET suite.
    expect(Object.keys(body)).toEqual(['data']);
    expect(Object.keys(body.data).sort()).toEqual(
      [
        'bcc',
        'body_html',
        'body_text',
        'cc',
        'created_at',
        'id',
        'mailboxId',
        'status',
        'subject',
        'to',
        'updated_at',
      ].sort(),
    );
    expect(body.data.id).toBe(messageId);
    expect(body.data.mailboxId).toBe(mailboxId);
    expect(body.data.status).toBe('draft');
    expect(body.data.subject).toBe('Updated subject');
    expect(body.data.body_text).toBe('updated text body');
    expect(body.data.body_html).toBe('<p>updated html body</p>');
    // Omitted recipient categories are preserved verbatim.
    expect(body.data.to).toEqual(['to-initial@example.com']);
    expect(body.data.cc).toEqual(['cc-initial@example.com']);
    expect(body.data.bcc).toEqual(['bcc-initial@example.com']);

    // created_at survives untouched (PATCH does not advance it).
    expect(body.data.created_at).toBe(requireDraftBody(before).data.created_at);

    // updated_at is strictly newer than the If-Match sent in. Both are
    // second-precision RFC-3339 with `.000Z`, so lexicographic compare
    // is the same as chronological compare.
    expect(body.data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(body.data.updated_at > ifMatch).toBe(true);

    // The next round-trip's If-Match is the value the response just
    // handed back — round-trip the wire timestamp directly into a
    // second PATCH so the bug fix is observed end-to-end. To force
    // a same-second collision deterministically, do this in two
    // awaits with no delay; the worker-pool wall clock advances
    // between the two awaits which exercises the candidate > stored
    // branch. The assertion below also pins the strictly-greater
    // contract without forcing an artificial second boundary.
    const second = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'Second subject' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': 'drafts-patch-001-key-2',
        'If-Match': body.data.updated_at,
      },
    });
    expect(second.status).toBe(200);

    // Message row in D1 reflects both PATCHes. The two PATCHes land
    // in arbitrary order at second precision, but the second one is
    // strictly newer than the first so it wins the lex compare.
    const msg = await env.DB.prepare(
      `SELECT subject, text_body, html_body, status FROM messages WHERE id = ?`,
    )
      .bind(messageId)
      .first<{
        subject: string;
        text_body: string;
        html_body: string;
        status: string;
      }>();
    expect(msg?.status).toBe('draft');
    expect(msg?.subject).toBe('Second subject');
    expect(msg?.text_body).toBe('updated text body');
    expect(msg?.html_body).toBe('<p>updated html body</p>');

    // The first PATCH advanced recipients/audit/idempotency by the
    // expected counts. Recipients are preserved (none supplied) so
    // they are unchanged; audit + idempotency each gained one row.
    const auditAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(auditAfter?.n).toBe((auditBefore?.n ?? 0) + 2);
    const idemAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(idemAfter?.n).toBe((idemBefore?.n ?? 0) + 2);
    const recipientsAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(recipientsAfter?.n).toBe(recipientsBefore?.n);

    // The two PATCH audit rows are `draft.updated`.
    const updatedAuditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ? AND action = 'draft.updated'`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(updatedAuditCount?.n).toBe(2);

    // No outbound job was created by the patch path.
    const outboundJobs = await env.DB.prepare('SELECT COUNT(*) AS n FROM outbound_jobs').first<{
      n: number;
    }>();
    expect(outboundJobs?.n).toBe(0);
  });

  // -------- partial patch preserves omitted fields / recipient replace ----

  it('partial PATCH preserves omitted fields and replaces / clears each supplied recipient category', async () => {
    const ownerId = await createUserWithRole('member', 'owner-partial@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Partial seed',
        body_text: 'seed text',
        body_html: '<p>seed html</p>',
        to: ['seed-to-1@example.com', 'seed-to-2@example.com'],
        cc: ['seed-cc@example.com'],
        bcc: ['seed-bcc-1@example.com', 'seed-bcc-2@example.com'],
      },
      'drafts-partial-seed-001',
    );

    const before = await getDraftEnvelope(messageId, ownerToken);
    expect(before.status).toBe(200);

    // Replace `to` with a new array, clear `cc` with `[]`, leave `bcc`
    // and the bodies untouched. The partial-patch contract is observed
    // through the merged envelope + the recipient rows.
    const response = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({
        to: ['replacement-to@example.com'],
        cc: [],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': 'drafts-partial-001',
        'If-Match': requireUpdatedAt(before),
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        subject: string;
        body_text: string;
        body_html: string;
        to: string[];
        cc: string[];
        bcc: string[];
      };
    };

    // Omitted fields preserved.
    expect(body.data.subject).toBe('Partial seed');
    expect(body.data.body_text).toBe('seed text');
    expect(body.data.body_html).toBe('<p>seed html</p>');
    expect(body.data.bcc).toEqual(['seed-bcc-1@example.com', 'seed-bcc-2@example.com']);
    // Replaced `to` and cleared `cc`.
    expect(body.data.to).toEqual(['replacement-to@example.com']);
    expect(body.data.cc).toEqual([]);

    // Recipient rows in D1 reflect the merge. `to` is fully replaced
    // (one row); `cc` is empty (zero rows); `bcc` is preserved.
    const recipients = await env.DB.prepare(
      `SELECT type, address FROM message_recipients
         WHERE message_id = ?
       ORDER BY type, address`,
    )
      .bind(messageId)
      .all<{ type: string; address: string }>();
    const typed = (recipients.results ?? []).map((r) => `${r.type}:${r.address}`);
    expect(typed).toEqual([
      'bcc:seed-bcc-1@example.com',
      'bcc:seed-bcc-2@example.com',
      'to:replacement-to@example.com',
    ]);

    // Replace bcc with a fresh single-element array in a follow-up
    // PATCH to also pin the bcc-replacement branch.
    const before2 = await getDraftEnvelope(messageId, ownerToken);
    expect(before2.status).toBe(200);
    const second = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ bcc: ['fresh-bcc@example.com'] }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': 'drafts-partial-002',
        'If-Match': requireUpdatedAt(before2),
      },
    });
    expect(second.status).toBe(200);
    const recipients2 = await env.DB.prepare(
      `SELECT type, address FROM message_recipients
         WHERE message_id = ? AND type = 'bcc'
       ORDER BY address`,
    )
      .bind(messageId)
      .all<{ type: string; address: string }>();
    const bccRows = (recipients2.results ?? []).map((r) => r.address);
    expect(bccRows).toEqual(['fresh-bcc@example.com']);
  });

  // -------- If-Match header validation: 400 cases ------------------------

  it('returns 400 IF_MATCH_REQUIRED when If-Match is missing', async () => {
    const ownerId = await createUserWithRole('member', 'owner-noifmatch@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      { subject: 'seed', body_text: 'seed', to: [] },
      'drafts-noifmatch-001',
    );

    const response = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'updated' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': 'drafts-noifmatch-001-key',
        // Intentionally NO If-Match header.
      },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('IF_MATCH_REQUIRED');
  });

  it('returns 400 IF_MATCH_INVALID for malformed / weak / quoted If-Match headers', async () => {
    const ownerId = await createUserWithRole('member', 'owner-badifmatch@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      { subject: 'seed', body_text: 'seed', to: [] },
      'drafts-badifmatch-001',
    );

    // Each entry is (label, header-value, expected code). The four
    // malformed shapes the spec calls out:
    //   1. malformed: not an RFC-3339 instant
    //   2. weak:      'W/"..."' (RFC 7232 §2.3)
    //   3. quoted:    '"..."'  (RFC 7232 §2.3)
    //   4. canonical-violation: '.000Z' replaced by '+00:00'
    const cases: Array<{ label: string; header: string; code: string }> = [
      {
        label: 'malformed',
        header: 'not-an-rfc-3339-instant',
        code: 'IF_MATCH_INVALID',
      },
      {
        label: 'weak-validator',
        header: 'W/"2026-01-01T00:00:00.000Z"',
        code: 'IF_MATCH_INVALID',
      },
      {
        label: 'quoted-validator',
        header: '"2026-01-01T00:00:00.000Z"',
        code: 'IF_MATCH_INVALID',
      },
      {
        label: 'non-canonical-zone',
        header: '2026-01-01T00:00:00+00:00',
        code: 'IF_MATCH_INVALID',
      },
    ];

    let i = 0;
    for (const { label, header, code } of cases) {
      i += 1;
      const response = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
        method: 'PATCH',
        body: JSON.stringify({ subject: `attempt-${i}` }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
          'Idempotency-Key': `drafts-badifmatch-001-key-${i}`,
          'If-Match': header,
        },
      });
      expect(response.status, label).toBe(400);
      const errBody = (await response.json()) as { error: { code: string } };
      expect(errBody.error.code, label).toBe(code);
    }

    // None of the four attempts leaked a write through the route.
    const msg = await env.DB.prepare(`SELECT subject FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ subject: string }>();
    expect(msg?.subject).toBe('seed');
    const auditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'draft.updated'`,
    ).first<{ n: number }>();
    expect(auditCount?.n).toBe(0);
  });

  // -------- stale If-Match returns 412, no DB writes ---------------------

  it('returns 412 STALE_IF_MATCH for a stale If-Match and leaves message / recipients / audit / idempotency counts unchanged', async () => {
    const ownerId = await createUserWithRole('member', 'owner-stale@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Stale seed',
        body_text: 'stale body',
        to: ['stale-to@example.com'],
        cc: ['stale-cc@example.com'],
        bcc: ['stale-bcc@example.com'],
      },
      'drafts-stale-001',
    );

    // Take a successful PATCH to advance updated_at; the second
    // PATCH then sends the OLD value as If-Match to land the stale
    // path. This is also the cleanest way to test the stale contract
    // without faking the DB column directly.
    const before = await getDraftEnvelope(messageId, ownerToken);
    expect(before.status).toBe(200);
    const liveResponse = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'Live subject' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': 'drafts-stale-live-001',
        'If-Match': requireUpdatedAt(before),
      },
    });
    expect(liveResponse.status).toBe(200);

    const auditBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const idemBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const recipientsBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();

    // Stale PATCH: send the original If-Match (now behind the live
    // PATCH).
    const staleResponse = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'Should not stick' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': 'drafts-stale-attempt-001',
        'If-Match': requireUpdatedAt(before),
      },
    });

    expect(staleResponse.status).toBe(412);
    const errBody = (await staleResponse.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe('STALE_IF_MATCH');

    // The message row keeps the live subject, not the stale one.
    const msg = await env.DB.prepare(`SELECT subject, text_body FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ subject: string; text_body: string }>();
    expect(msg?.subject).toBe('Live subject');
    expect(msg?.text_body).toBe('stale body');

    // No row counts changed: the stale PATCH short-circuited before
    // the D1 batch.
    const auditAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(auditAfter?.n).toBe(auditBefore?.n);
    const idemAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(idemAfter?.n).toBe(idemBefore?.n);
    const recipientsAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(recipientsAfter?.n).toBe(recipientsBefore?.n);

    // The stale PATCH did not create an idempotency record (a replay
    // with the same key would otherwise succeed).
    const staleKeyRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE idempotency_key = ?`,
    )
      .bind('drafts-stale-attempt-001')
      .first<{ n: number }>();
    expect(staleKeyRow?.n).toBe(0);
  });

  // -------- authz: sender allowed, viewer/foreign denied -----------------

  it('lets a sender-role member patch a draft (allowed by R-MAILBOX-003 matrix)', async () => {
    const ownerId = await createUserWithRole('member', 'owner-sender-patch@example.com');
    const ownerToken = await createSession(ownerId);
    const senderId = await createUserWithRole('member', 'sender-patch@example.com');
    const senderToken = await createSession(senderId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'shared');
    await addMailboxMember(mailboxId, senderId, 'sender');

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      { subject: 'Sender can patch', body_text: 'seed', to: [] },
      'drafts-sender-patch-001',
    );

    const before = await getDraftEnvelope(messageId, ownerToken);
    expect(before.status).toBe(200);

    const response = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'Sender updated subject' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${senderToken}`,
        'Idempotency-Key': 'drafts-sender-patch-001-key',
        'If-Match': requireUpdatedAt(before),
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { subject: string } };
    expect(body.data.subject).toBe('Sender updated subject');
  });

  it('returns 404 MESSAGE_NOT_FOUND (not 403) when a viewer or a foreign actor attempts to PATCH — no write lands', async () => {
    const ownerId = await createUserWithRole('member', 'owner-authz-patch@example.com');
    const ownerToken = await createSession(ownerId);
    const viewerId = await createUserWithRole('member', 'viewer-patch@example.com');
    const viewerToken = await createSession(viewerId);
    const foreignId = await createUserWithRole('member', 'foreign-patch@example.com');
    const foreignToken = await createSession(foreignId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'private');
    await addMailboxMember(mailboxId, viewerId, 'viewer');

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Authz seed',
        body_text: 'seed body',
        to: ['seed@example.com'],
      },
      'drafts-authz-patch-001',
    );

    const before = await getDraftEnvelope(messageId, ownerToken);
    expect(before.status).toBe(200);

    const auditBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id IN (?, ?, ?)`,
    )
      .bind(viewerId, foreignId, ownerId)
      .first<{ n: number }>();
    const idemBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id IN (?, ?, ?)`,
    )
      .bind(viewerId, foreignId, ownerId)
      .first<{ n: number }>();

    // Viewer attempt — viewer may `read` but not `send`.
    const viewerResponse = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'Viewer attempt' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`,
        'Idempotency-Key': 'drafts-authz-viewer-001',
        'If-Match': requireUpdatedAt(before),
      },
    });
    expect(viewerResponse.status).toBe(404);
    const viewerErr = (await viewerResponse.json()) as { error: { code: string } };
    expect(viewerErr.error.code).toBe('MESSAGE_NOT_FOUND');

    // Foreign actor — no membership, not the owner, not an admin.
    const foreignResponse = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'Foreign attempt' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foreignToken}`,
        'Idempotency-Key': 'drafts-authz-foreign-001',
        'If-Match': requireUpdatedAt(before),
      },
    });
    expect(foreignResponse.status).toBe(404);
    const foreignErr = (await foreignResponse.json()) as { error: { code: string } };
    expect(foreignErr.error.code).toBe('MESSAGE_NOT_FOUND');

    // No write leaked through either attempt: the message row is
    // untouched, no new audit row, no idempotency row.
    const msg = await env.DB.prepare(`SELECT subject FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ subject: string }>();
    expect(msg?.subject).toBe('Authz seed');

    const auditAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id IN (?, ?, ?)`,
    )
      .bind(viewerId, foreignId, ownerId)
      .first<{ n: number }>();
    expect(auditAfter?.n).toBe(auditBefore?.n);
    const idemAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id IN (?, ?, ?)`,
    )
      .bind(viewerId, foreignId, ownerId)
      .first<{ n: number }>();
    expect(idemAfter?.n).toBe(idemBefore?.n);

    // No idempotency record under either rejected key.
    for (const key of ['drafts-authz-viewer-001', 'drafts-authz-foreign-001']) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM idempotency_records WHERE idempotency_key = ?`,
      )
        .bind(key)
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    }
  });

  // -------- idempotency replay -------------------------------------------

  it('same Idempotency-Key + identical raw body replays the stored 200 byte-identically; changed body returns 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const ownerId = await createUserWithRole('member', 'owner-replay@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      { subject: 'Replay seed', body_text: 'seed body', to: [] },
      'drafts-replay-patch-seed-001',
    );

    const before = await getDraftEnvelope(messageId, ownerToken);
    expect(before.status).toBe(200);

    const idempotencyKey = 'drafts-patch-replay-001';
    const requestBody = JSON.stringify({ subject: 'Replayed subject' });

    const first = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': idempotencyKey,
        'If-Match': requireUpdatedAt(before),
      },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Type')).toBe('application/json');
    const firstRaw = await first.text();

    // Replay with the SAME raw bytes — must be byte-identical and
    // not touch the DB.
    const auditBeforeReplay = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const idemBeforeReplay = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();

    const second = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': idempotencyKey,
        'If-Match': requireUpdatedAt(before),
      },
    });
    expect(second.status).toBe(200);
    const secondRaw = await second.text();
    expect(secondRaw).toBe(firstRaw);

    // Replay did not re-execute: no additional audit / idempotency
    // rows.
    const auditAfterReplay = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(auditAfterReplay?.n).toBe(auditBeforeReplay?.n);
    const idemAfterReplay = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(idemAfterReplay?.n).toBe(idemBeforeReplay?.n);

    // Same key + DIFFERENT body → 409 IDEMPOTENCY_KEY_REUSED, no
    // additional writes.
    const auditBeforeConflict = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const idemBeforeConflict = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();

    const conflict = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'Different subject' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': idempotencyKey,
        'If-Match': requireUpdatedAt(before),
      },
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error: { code: string } };
    expect(conflictBody.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const auditAfterConflict = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(auditAfterConflict?.n).toBe(auditBeforeConflict?.n);
    const idemAfterConflict = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(idemAfterConflict?.n).toBe(idemBeforeConflict?.n);
  });

  // -------- atomicity: failing business statement rolls the batch back ---

  it('a deterministic batch failure after the conditional UPDATE rolls back message / recipient / audit / idempotency writes (no queue row)', async () => {
    const ownerId = await createUserWithRole('member', 'owner-atomic@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Atomic seed',
        body_text: 'atomic body',
        to: ['atomic-to@example.com'],
        cc: ['atomic-cc@example.com'],
        bcc: ['atomic-bcc@example.com'],
      },
      'drafts-atomic-patch-seed-001',
    );

    const before = await getDraftEnvelope(messageId, ownerToken);
    expect(before.status).toBe(200);

    // Force the audit INSERT to collide with a pre-inserted fixture
    // row by making the route generate the same UUID for the audit
    // event. The request-id middleware consumes the FIRST generated
    // UUID. The PATCH route then asks for the audit event ID and the
    // idempotency record ID, in that order.
    const fixtureAuditId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO audit_events
         (id, actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at)
       VALUES (?, ?, 'setup.claim', 'rollback-fixture', NULL, NULL, NULL, datetime('now'))`,
    )
      .bind(fixtureAuditId, ownerId)
      .run();

    const uuidSpy = vi.spyOn(systemIds, 'uuid');
    let uuidCalls = 0;
    uuidSpy.mockImplementation(() => {
      uuidCalls += 1;
      // request-id middleware: 1st call (consumed before the handler)
      // PATCH handler: 2nd call = auditEventId, 3rd = idempotencyRecordId
      if (uuidCalls === 2) return fixtureAuditId;
      return crypto.randomUUID();
    });

    // Snapshot write-side counts BEFORE the failing PATCH so we can
    // assert nothing leaked.
    const msgBefore = await env.DB.prepare(
      `SELECT subject, text_body, html_body FROM messages WHERE id = ?`,
    )
      .bind(messageId)
      .first<{ subject: string; text_body: string; html_body: string }>();
    const auditBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const idemBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const recipientsBefore = await env.DB.prepare(
      `SELECT type, address FROM message_recipients WHERE message_id = ? ORDER BY type, address`,
    )
      .bind(messageId)
      .all<{ type: string; address: string }>();
    const outboundBefore = await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbound_jobs`).first<{
      n: number;
    }>();

    try {
      const response = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
        method: 'PATCH',
        body: JSON.stringify({
          subject: 'Should rollback',
          to: ['new-to@example.com'],
          cc: [],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
          'Idempotency-Key': 'drafts-atomic-patch-001',
          'If-Match': requireUpdatedAt(before),
        },
      });

      // The audit UNIQUE violation is an internal batch failure.
      expect(response.status).toBe(500);
    } finally {
      uuidSpy.mockRestore();
    }

    // message row is byte-identical to the pre-PATCH snapshot
    // (rollback rolled the UPDATE back).
    const msgAfter = await env.DB.prepare(
      `SELECT subject, text_body, html_body FROM messages WHERE id = ?`,
    )
      .bind(messageId)
      .first<{ subject: string; text_body: string; html_body: string }>();
    expect(msgAfter).toEqual(msgBefore);

    // recipients are unchanged — both the conditional DELETE and the
    // new INSERTs were guarded by `WHERE EXISTS (...)` keyed on the
    // new updated_at, and the batch rolled back atomically.
    const recipientsAfter = await env.DB.prepare(
      `SELECT type, address FROM message_recipients WHERE message_id = ? ORDER BY type, address`,
    )
      .bind(messageId)
      .all<{ type: string; address: string }>();
    expect(recipientsAfter.results ?? []).toEqual(recipientsBefore.results ?? []);

    // No draft.updated audit row landed.
    const updatedAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ? AND action = 'draft.updated'`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(updatedAudit?.n).toBe(0);
    // Total audit rows unchanged (only the pre-existing fixture row).
    const auditAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(auditAfter?.n).toBe(auditBefore?.n);

    // No idempotency record under the failing key.
    const idemAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE idempotency_key = ?`,
    )
      .bind('drafts-atomic-patch-001')
      .first<{ n: number }>();
    expect(idemAfter?.n).toBe(0);
    const idemTotalAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(idemTotalAfter?.n).toBe(idemBefore?.n);

    // No outbound job was created.
    const outboundAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbound_jobs`).first<{
      n: number;
    }>();
    expect(outboundAfter?.n).toBe(outboundBefore?.n);

    // Fixture row survives (the audit INSERT collided against it; the
    // row itself was never deleted by the rollback).
    const fixtureRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE id = ?`)
      .bind(fixtureAuditId)
      .first<{ n: number }>();
    expect(fixtureRow?.n).toBe(1);
  });

  // -------- parallel-batch race: same-key concurrent replay (MEDIUM bug)
  //
  // Two concurrent PATCHes with the SAME Idempotency-Key + SAME body +
  // SAME If-Match header must each return 200 with a byte-identical
  // body, and the DB must contain exactly ONE `draft.updated` audit
  // row, ONE idempotency record, and ONE set of recipient rows for
  // the replacement. The losing request's batch is gated by the
  // `changes() > 0` marker guard (statement 2) and the per-request
  // idempotency-row marker guard (statements 3-5); without them, the
  // loser's UPDATE could fail (changes=0) while the loser's guarded
  // side-effect statements still ran against the winner's `newSqlite`,
  // mutating recipients / audit / idempotency before the 412
  // surfaced.
  //
  // We don't mock D1 (testing.md §Mocking) — the worker-pool exercises
  // the full pipeline and D1's natural serialisation at the storage
  // layer. The assertion is the contract: one idempotency row, one
  // audit row, byte-identical responses.

  it('parallel same-key + same-body PATCHes return byte-identical 200s and write exactly one audit + one idempotency row', async () => {
    const ownerId = await createUserWithRole('member', 'owner-parallel@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId);

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      { subject: 'Parallel seed', body_text: 'seed', to: [] },
      'drafts-parallel-seed-001',
    );

    const before = await getDraftEnvelope(messageId, ownerToken);
    expect(before.status).toBe(200);

    const idempotencyKey = 'drafts-parallel-same-key-001';
    const requestBody = JSON.stringify({
      subject: 'Parallel subject',
      to: ['parallel-to@example.com'],
      cc: [],
    });

    // Fire two PATCHes concurrently — same key, same body, same
    // If-Match. The worker-pool handler runs each request through
    // the full pipeline, and D1's batch layer serialises the two
    // batches on the storage engine. The `changes() > 0` marker
    // guard makes the losing batch a no-op; the post-batch lookup
    // of the idempotency record returns the winner's response.
    const [first, second] = await Promise.all([
      SELF.fetch(PATCH_DRAFT_PATH(messageId), {
        method: 'PATCH',
        body: requestBody,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
          'Idempotency-Key': idempotencyKey,
          'If-Match': requireUpdatedAt(before),
        },
      }),
      SELF.fetch(PATCH_DRAFT_PATH(messageId), {
        method: 'PATCH',
        body: requestBody,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
          'Idempotency-Key': idempotencyKey,
          'If-Match': requireUpdatedAt(before),
        },
      }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Bodies are byte-identical — both responses are the same wire
    // shape (R-API-004: replays restore the exact stored body). Read
    // once per response since `Response#text()` consumes the body.
    const firstRaw = await first.text();
    const secondRaw = await second.text();
    expect(secondRaw).toBe(firstRaw);

    // Exactly ONE idempotency record under this key — the loser's
    // batch gated statement 2 on `changes() > 0`, so the loser's
    // idempotency INSERT was a no-op.
    const idemCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE idempotency_key = ?`,
    )
      .bind(idempotencyKey)
      .first<{ n: number }>();
    expect(idemCount?.n).toBe(1);

    // Exactly ONE `draft.updated` audit row for this draft — the
    // loser's batch gated the audit INSERT on the per-request
    // idempotency marker, which never landed for the loser.
    const updatedAuditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events
         WHERE actor_user_id = ? AND action = 'draft.updated'`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(updatedAuditCount?.n).toBe(1);

    // Recipient rows reflect exactly one replacement — the loser's
    // DELETE + INSERTs were also gated on the marker row, so the
    // recipient state is the winner's, not double-replaced.
    const recipients = await env.DB.prepare(
      `SELECT type, address FROM message_recipients
         WHERE message_id = ?
       ORDER BY type, address`,
    )
      .bind(messageId)
      .all<{ type: string; address: string }>();
    const typed = (recipients.results ?? []).map((r) => `${r.type}:${r.address}`);
    expect(typed).toEqual(['to:parallel-to@example.com']);

    // The message row's `updated_at` is the canonical second-
    // precision shape and is strictly greater than the If-Match
    // sent in. The lex compare on the canonical forms is the same
    // rule the conditional UPDATE predicate uses.
    const storedRow = await env.DB.prepare(`SELECT subject, updated_at FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ subject: string; updated_at: string }>();
    expect(storedRow?.subject).toBe('Parallel subject');
    const storedWire = `${storedRow?.updated_at?.slice(0, 19).replace(' ', 'T')}.000Z`;
    expect(storedWire > requireUpdatedAt(before)).toBe(true);
  });

  // -------- HIGH response_json size (migration 0020) ---------------------
  //
  // The PATCH envelope (id + mailboxId + subject + body_text + body_html
  // + to + cc + bcc + status + created_at + updated_at) can legally
  // exceed the legacy 65,536-char `idempotency_records.response_json`
  // CHECK when `body_html` is at or near its 131,072-char schema ceiling.
  // Without migration 0020 the route would land a `response_json` past
  // 65,536 chars, the CHECK constraint would fire, and the entire
  // atomic D1 batch (conditional UPDATE + recipient replacements +
  // audit row + idempotency record) would roll back — leaving the
  // caller with a 500 and no draft update. Migration 0020 raises the
  // ceiling to 524,288; this test pins the contract: a schema-legal
  // large body round-trips through PATCH successfully, the
  // `response_json` stored on the idempotency row is past the legacy
  // ceiling (proving the migration took effect), and the same-key
  // replay returns byte-identical bytes (proving no CHECK rollback
  // occurred on the live path).
  //
  // The worker-pool loader at packages/test-kit/src/migrationsDb.ts now
  // applies 0020 via resetAndMigrate(), so the large-body test relies on
  // the loader rather than carrying a parallel apply path.

  it('a schema-legal large body PATCHes successfully and replays byte-identically (no CHECK rollback under 524,288)', async () => {
    // resetAndMigrate() in the describe-level beforeEach already applied
    // 0020 — the idempotency_records.response_json CHECK is the raised
    // 524,288 ceiling. Under the legacy 65,536 ceiling the route's
    // atomic batch would CHECK-rollback the message UPDATE + idempotency
    // record together, and the PATCH would surface as a 500.
    const ownerId = await createUserWithRole('member', 'owner-largebody@example.com');
    const ownerToken = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'large-body');

    const messageId = await createDraftViaPost(
      mailboxId,
      ownerToken,
      {
        subject: 'Large-body seed',
        body_text: 'small seed',
        to: [],
      },
      'drafts-large-body-seed-001',
    );

    // body_html at the 131,072-char schema ceiling — the largest a
    // schema-legal PATCH can carry. The wire envelope wraps this with
    // ~500 chars of overhead (id, mailboxId, subject, body_text,
    // created_at, updated_at, JSON keys), so the stored
    // response_json lands well past 131,072 chars and clearly past
    // the legacy 65,536-char CHECK.
    const largeBodyHtml = 'x'.repeat(131_072);

    const before = await getDraftEnvelope(messageId, ownerToken);
    expect(before.status).toBe(200);
    const ifMatch = requireUpdatedAt(before);

    const idempotencyKey = 'drafts-large-body-patch-001';
    const requestBody = JSON.stringify({ body_html: largeBodyHtml });

    const first = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': idempotencyKey,
        'If-Match': ifMatch,
      },
    });

    // 200 with the merged envelope. The D1 batch landed; the
    // response_json is past the legacy CHECK; the migration is in
    // effect.
    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Type')).toBe('application/json');
    const firstRaw = await first.text();

    // The wire envelope's body_html round-tripped verbatim. The
    // 131,072-char field is present in the raw response — proving
    // the JSON serialised past the legacy 65,536-byte CHECK.
    expect(firstRaw).toContain(largeBodyHtml.slice(0, 64));
    expect(firstRaw.length).toBeGreaterThan(131_072);

    // Idempotency record was stored. `response_json` length exceeds
    // the LEGACY 65,536-char ceiling — proof the migration raised it
    // (under the legacy ceiling the INSERT would have been CHECK-
    // rejected and the entire batch rolled back, leaving the
    // idempotency row absent).
    const idemRow = await env.DB.prepare(
      `SELECT response_status, response_json, request_hash
         FROM idempotency_records
        WHERE actor_id = ? AND operation = ?
          AND idempotency_key = ?`,
    )
      .bind(ownerId, 'PATCH /api/v1/drafts/:draftId', idempotencyKey)
      .first<{
        response_status: number;
        response_json: string;
        request_hash: string;
      }>();
    expect(idemRow).toBeTruthy();
    expect(idemRow?.response_status).toBe(200);
    // Past the legacy 65,536-char CHECK — proving the migration
    // raised the ceiling. The new ceiling is 524,288, well above
    // this 131k+ envelope.
    expect(idemRow?.response_json.length ?? 0).toBeGreaterThan(65_536);
    // Strictly under the new ceiling — the row exists because the
    // CHECK at 524288 let the INSERT through. A regression that
    // re-tightened the ceiling below this envelope would CHECK-
    // reject and the row would be absent.
    expect(idemRow?.response_json.length ?? 0).toBeLessThanOrEqual(524_288);

    // Stored body matches the live response byte-for-byte. A
    // CHECK-rollback would have left response_json absent — the
    // stored value being non-empty AND equal to the live body is
    // the post-migration guarantee.
    expect(idemRow?.response_json).toBe(firstRaw);

    // Same key + same raw bytes → byte-identical 200 replay.
    // Snapshot write-side counts to prove the replay did NOT
    // re-execute the batch.
    const auditBeforeReplay = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    const idemBeforeReplay = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();

    const second = await SELF.fetch(PATCH_DRAFT_PATH(messageId), {
      method: 'PATCH',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': idempotencyKey,
        'If-Match': ifMatch,
      },
    });

    expect(second.status).toBe(200);
    const secondRaw = await second.text();
    // Byte-identical replay (R-API-004). The 131k+ payload round-
    // trips byte-for-byte; no truncation, no re-encoding.
    expect(secondRaw).toBe(firstRaw);

    // No write-side growth — the replay short-circuited before the
    // D1 batch. A CHECK rollback would have aborted the batch (no
    // idempotency row, no audit row); the replay working proves the
    // batch DID land.
    const auditAfterReplay = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(auditAfterReplay?.n).toBe(auditBeforeReplay?.n);
    const idemAfterReplay = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ?`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(idemAfterReplay?.n).toBe(idemBeforeReplay?.n);

    // Stored message row reflects the large body_html (no CHECK
    // rollback on the message UPDATE either).
    const msg = await env.DB.prepare(`SELECT html_body FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ html_body: string }>();
    expect(msg?.html_body).toBe(largeBodyHtml);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/drafts/:draftId/send
//
// The send slice is deliberately isolated from the create/read/PATCH suites:
// it owns the draft -> queued transition, the atomic outbox write, and the
// post-commit queue handoff. Provider HTTP is never called by this route.
// ---------------------------------------------------------------------------

const SEND_DRAFT_PATH = (draftId: string) => `http://localhost/api/v1/drafts/${draftId}/send`;
const SEND_OPERATION = 'POST /api/v1/drafts/:draftId/send';

describe('POST /api/v1/drafts/:draftId/send — CAP-047 draft-send slice', () => {
  let queueSendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    queueSendSpy = vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);
  });

  afterEach(() => {
    queueSendSpy.mockRestore();
  });

  async function seedDraft(ownerEmail: string): Promise<{
    ownerId: string;
    token: string;
    mailboxId: string;
    messageId: string;
  }> {
    const ownerId = await createUserWithRole('member', ownerEmail);
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'send-mailbox');
    const messageId = await createDraftViaPost(
      mailboxId,
      token,
      { subject: 'Send me', body_text: 'queued body', to: ['recipient@example.com'] },
      `draft-send-seed-${crypto.randomUUID().slice(0, 8)}`,
    );
    return { ownerId, token, mailboxId, messageId };
  }

  it('queues the draft atomically and enqueues exactly one job after commit', async () => {
    const { ownerId, token, mailboxId, messageId } = await seedDraft('send-owner@example.com');
    const providerConnectionId = await createActiveProviderConnection();
    const response = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'draft-send-happy-001' },
    });

    expect(response.status).toBe(202);
    expect(response.headers.get('Location')).toBe(`/api/v1/messages/${messageId}`);
    expect(await response.json()).toEqual({ data: { messageId, status: 'queued' } });

    const message = await env.DB.prepare(
      `SELECT status, sent_at, provider_event_time FROM messages WHERE id = ?`,
    )
      .bind(messageId)
      .first<{ status: string; sent_at: string | null; provider_event_time: number | null }>();
    expect(message).toEqual({ status: 'queued', sent_at: null, provider_event_time: null });

    const folder = await env.DB.prepare(
      `SELECT folder FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ?`,
    )
      .bind(mailboxId, messageId)
      .first<{ folder: string }>();
    expect(folder?.folder).toBe('sent');

    const jobs = await env.DB.prepare(
      `SELECT id, message_id, provider_connection_id, status FROM outbound_jobs WHERE message_id = ?`,
    )
      .bind(messageId)
      .all<{ id: string; message_id: string; provider_connection_id: string; status: string }>();
    expect(jobs.results).toHaveLength(1);
    expect(jobs.results?.[0]).toMatchObject({
      message_id: messageId,
      provider_connection_id: providerConnectionId,
      status: 'queued',
    });

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, action, resource_type, resource_id FROM audit_events
       WHERE actor_user_id = ? AND action = 'draft.sent' AND resource_id = ?`,
    )
      .bind(ownerId, messageId)
      .first<{
        actor_user_id: string;
        action: string;
        resource_type: string;
        resource_id: string;
      }>();
    expect(audit).toEqual({
      actor_user_id: ownerId,
      action: 'draft.sent',
      resource_type: 'message',
      resource_id: messageId,
    });

    expect(queueSendSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(queueSendSpy.mock.calls[0]?.[0]))).toEqual({
      jobId: jobs.results?.[0]?.id,
    });

    const idem = await env.DB.prepare(
      `SELECT response_status, response_json FROM idempotency_records
       WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
    )
      .bind(ownerId, SEND_OPERATION, 'draft-send-happy-001')
      .first<{ response_status: number; response_json: string }>();
    expect(idem?.response_status).toBe(202);
    expect(idem?.response_json).toBe(
      '{"data":{"messageId":"' + messageId + '","status":"queued"}}',
    );
  });

  it('replays the same raw request byte-identically without a second job or queue send', async () => {
    const { ownerId, token, messageId } = await seedDraft('send-replay@example.com');
    await createActiveProviderConnection();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'draft-send-replay-001',
    };
    const first = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      headers,
      body: '{}',
    });
    const firstRaw = await first.text();
    const second = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      headers,
      body: '{}',
    });
    const secondRaw = await second.text();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(secondRaw).toBe(firstRaw);
    expect(second.headers.get('Location')).toBe(`/api/v1/messages/${messageId}`);
    expect(queueSendSpy).toHaveBeenCalledTimes(1);
    const message = await env.DB.prepare(`SELECT status FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ status: string }>();
    expect(message?.status).toBe('queued');
    const folder = await env.DB.prepare(`SELECT folder FROM mailbox_messages WHERE message_id = ?`)
      .bind(messageId)
      .first<{ folder: string }>();
    expect(folder?.folder).toBe('sent');
    const jobCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbound_jobs WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(jobCount?.n).toBe(1);
    const auditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'draft.sent'`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(auditCount?.n).toBe(1);
    const idemCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ? AND operation = ?`,
    )
      .bind(ownerId, SEND_OPERATION)
      .first<{ n: number }>();
    expect(idemCount?.n).toBe(1);
  });

  it('same-key concurrent sends return one stored response and create one job/audit', async () => {
    const { ownerId, token, messageId } = await seedDraft('send-concurrent@example.com');
    await createActiveProviderConnection();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'draft-send-concurrent-001',
    };
    const [first, second] = await Promise.all([
      SELF.fetch(SEND_DRAFT_PATH(messageId), { method: 'POST', headers }),
      SELF.fetch(SEND_DRAFT_PATH(messageId), { method: 'POST', headers }),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await first.text()).toBe(await second.text());
    expect(queueSendSpy).toHaveBeenCalledTimes(1);

    const jobCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbound_jobs WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(jobCount?.n).toBe(1);
    const auditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ? AND action = 'draft.sent'`,
    )
      .bind(ownerId)
      .first<{ n: number }>();
    expect(auditCount?.n).toBe(1);
  });

  it('does not replay a key/body pair across two different drafts', async () => {
    const ownerId = await createUserWithRole('member', 'send-cross-draft@example.com');
    const token = await createSession(ownerId);
    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'cross-draft');
    const firstDraftId = await createDraftViaPost(
      mailboxId,
      token,
      { subject: 'First', body_text: 'first', to: [] },
      'draft-send-cross-seed-001',
    );
    const secondDraftId = await createDraftViaPost(
      mailboxId,
      token,
      { subject: 'Second', body_text: 'second', to: [] },
      'draft-send-cross-seed-002',
    );
    await createActiveProviderConnection();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'draft-send-cross-resource-001',
    };

    const first = await SELF.fetch(SEND_DRAFT_PATH(firstDraftId), {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(first.status).toBe(202);
    const second = await SELF.fetch(SEND_DRAFT_PATH(secondDraftId), {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(queueSendSpy).toHaveBeenCalledTimes(1);
    const secondState = await env.DB.prepare(`SELECT status FROM messages WHERE id = ?`)
      .bind(secondDraftId)
      .first<{ status: string }>();
    expect(secondState?.status).toBe('draft');
  });

  it('returns IDEMPOTENCY_KEY_REUSED for the same key with different bytes', async () => {
    const { token, messageId } = await seedDraft('send-conflict@example.com');
    await createActiveProviderConnection();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'draft-send-conflict-001',
    };
    const first = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(first.status).toBe(202);
    const second = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      headers,
      body: '{"unexpected":true}',
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(queueSendSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a present whitespace body instead of treating it as an empty request', async () => {
    const { token, messageId } = await seedDraft('send-whitespace@example.com');
    await createActiveProviderConnection();
    const response = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      body: '   ',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'draft-send-whitespace-001',
        'Content-Type': 'application/json',
      },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_JSON',
    );
    expect(queueSendSpy).not.toHaveBeenCalled();
  });

  it('returns PROVIDER_CONNECTION_NOT_FOUND without mutating the draft', async () => {
    const { ownerId, token, mailboxId, messageId } = await seedDraft(
      'send-no-provider@example.com',
    );
    const response = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'draft-send-no-provider-001',
      },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'PROVIDER_CONNECTION_NOT_FOUND',
    );
    expect(queueSendSpy).not.toHaveBeenCalled();
    const message = await env.DB.prepare(`SELECT status FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ status: string }>();
    expect(message?.status).toBe('draft');
    const folder = await env.DB.prepare(
      `SELECT folder FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ?`,
    )
      .bind(mailboxId, messageId)
      .first<{ folder: string }>();
    expect(folder?.folder).toBe('drafts');
    const idem = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ? AND operation = ?`,
    )
      .bind(ownerId, SEND_OPERATION)
      .first<{ n: number }>();
    expect(idem?.n).toBe(0);
    const noProviderJobs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbound_jobs WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(noProviderJobs?.n).toBe(0);
    const noProviderAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'draft.sent'`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(noProviderAudit?.n).toBe(0);
  });

  it('collapses a foreign actor and a non-draft row to MESSAGE_NOT_FOUND', async () => {
    const {
      ownerId,
      token: ownerToken,
      messageId,
    } = await seedDraft('send-owner-no-leak@example.com');
    const foreignId = await createUserWithRole('member', 'send-foreign@example.com');
    const foreignToken = await createSession(foreignId);
    await createActiveProviderConnection();

    const foreign = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${foreignToken}`,
        'Idempotency-Key': 'draft-send-foreign-001',
      },
    });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe(
      'MESSAGE_NOT_FOUND',
    );
    expect(queueSendSpy).not.toHaveBeenCalled();
    const foreignJobs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbound_jobs WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(foreignJobs?.n).toBe(0);
    const foreignAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'draft.sent'`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(foreignAudit?.n).toBe(0);
    const foreignIdem = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ? AND operation = ?`,
    )
      .bind(foreignId, SEND_OPERATION)
      .first<{ n: number }>();
    expect(foreignIdem?.n).toBe(0);
    const foreignState = await env.DB.prepare(
      `SELECT m.status, mm.folder FROM messages m JOIN mailbox_messages mm ON mm.message_id = m.id WHERE m.id = ?`,
    )
      .bind(messageId)
      .first<{ status: string; folder: string }>();
    expect(foreignState).toEqual({ status: 'draft', folder: 'drafts' });

    await env.DB.prepare(`UPDATE messages SET status = 'queued' WHERE id = ?`)
      .bind(messageId)
      .run();
    const nondraft = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': 'draft-send-nondraft-001',
      },
    });
    expect(nondraft.status).toBe(404);
    expect(((await nondraft.json()) as { error: { code: string } }).error.code).toBe(
      'MESSAGE_NOT_FOUND',
    );
    expect(queueSendSpy).not.toHaveBeenCalled();
    const nondraftState = await env.DB.prepare(
      `SELECT m.status, mm.folder FROM messages m
       JOIN mailbox_messages mm ON mm.message_id = m.id
       WHERE m.id = ?`,
    )
      .bind(messageId)
      .first<{ status: string; folder: string }>();
    expect(nondraftState).toEqual({ status: 'queued', folder: 'drafts' });
    const nondraftJobs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbound_jobs WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(nondraftJobs?.n).toBe(0);
    const nondraftAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'draft.sent'`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(nondraftAudit?.n).toBe(0);
    const nondraftIdem = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ? AND operation = ?`,
    )
      .bind(ownerId, SEND_OPERATION)
      .first<{ n: number }>();
    expect(nondraftIdem?.n).toBe(0);
  });

  it('returns the same no-leak 404 to a viewer member and leaves the draft untouched', async () => {
    const { mailboxId, messageId } = await seedDraft('send-viewer-owner@example.com');
    const viewerId = await createUserWithRole('member', 'send-viewer@example.com');
    const viewerToken = await createSession(viewerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    await createActiveProviderConnection();

    const response = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${viewerToken}`,
        'Idempotency-Key': 'draft-send-viewer-001',
      },
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'MESSAGE_NOT_FOUND',
    );
    expect(queueSendSpy).not.toHaveBeenCalled();
    const state = await env.DB.prepare(
      `SELECT m.status, mm.folder FROM messages m
       JOIN mailbox_messages mm ON mm.message_id = m.id
       WHERE m.id = ? AND mm.mailbox_id = ?`,
    )
      .bind(messageId, mailboxId)
      .first<{ status: string; folder: string }>();
    expect(state).toEqual({ status: 'draft', folder: 'drafts' });
    const viewerJobs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbound_jobs WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(viewerJobs?.n).toBe(0);
    const viewerAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'draft.sent'`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(viewerAudit?.n).toBe(0);
    const viewerIdem = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ? AND operation = ?`,
    )
      .bind(viewerId, SEND_OPERATION)
      .first<{ n: number }>();
    expect(viewerIdem?.n).toBe(0);
  });

  it('rolls back every send-side write when the audit insert collides', async () => {
    const { ownerId, token, mailboxId, messageId } = await seedDraft('send-rollback@example.com');
    await createActiveProviderConnection();
    const fixtureAuditId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO audit_events
         (id, actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at)
       VALUES (?, ?, 'setup.claim', 'rollback-fixture', NULL, NULL, NULL, datetime('now'))`,
    )
      .bind(fixtureAuditId, ownerId)
      .run();

    const uuidSpy = vi.spyOn(systemIds, 'uuid');
    let uuidCalls = 0;
    uuidSpy.mockImplementation(() => {
      uuidCalls += 1;
      // request-id middleware is call 1; send allocates job, marker, audit.
      if (uuidCalls === 4) return fixtureAuditId;
      return crypto.randomUUID();
    });

    try {
      const response = await SELF.fetch(SEND_DRAFT_PATH(messageId), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'draft-send-rollback-001',
        },
      });
      expect(response.status).toBe(500);
    } finally {
      uuidSpy.mockRestore();
    }

    expect(queueSendSpy).not.toHaveBeenCalled();
    const state = await env.DB.prepare(
      `SELECT m.status, mm.folder FROM messages m
       JOIN mailbox_messages mm ON mm.message_id = m.id
       WHERE m.id = ? AND mm.mailbox_id = ?`,
    )
      .bind(messageId, mailboxId)
      .first<{ status: string; folder: string }>();
    expect(state).toEqual({ status: 'draft', folder: 'drafts' });
    const jobs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbound_jobs WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(jobs?.n).toBe(0);
    const sendAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'draft.sent'`,
    )
      .bind(messageId)
      .first<{ n: number }>();
    expect(sendAudit?.n).toBe(0);
    const idem = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM idempotency_records WHERE actor_id = ? AND operation = ?`,
    )
      .bind(ownerId, SEND_OPERATION)
      .first<{ n: number }>();
    expect(idem?.n).toBe(0);
  });
});
