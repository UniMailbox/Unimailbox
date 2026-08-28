// apps/worker/test/drafts.worker.test.ts — CAP-047 server draft slice.
//
// Worker-pool tests for the CAP-047 draft routes. Uses SELF.fetch to
// exercise the full request pipeline: router → authn → requirePermission
// → assertCan → D1 batch insert (POST) or D1 SELECT (GET) → envelope.
// Provider / queue is intentionally NOT exercised — a draft does not
// enqueue a job, and the tests assert that no outbound_jobs row is
// created.
//
// The fixtures mirror compose.worker.test.ts: same role/permission seed,
// same session helper, same domain + mailbox helpers. The only
// divergence is no `createActiveProviderConnection()` call — drafts do
// not touch the outbound pipeline.
//
// Slice: GET /api/v1/drafts/:draftId extends the existing POST coverage.
// POST tests are unchanged; the GET block lives in its own describe
// below.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../src/platform/crypto';
import { systemIds } from '../src/platform/ids';

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

  await env.CACHE.put(`auth:${accessToken}`, JSON.stringify({ userId }), {
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

    // Foreign actor: not the owner, no membership, not a global admin.
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

  // -------- global administrator (role.manage, no mailbox_members) -----

  it("lets a global administrator (role.manage, no mailbox_members row) read another user's draft", async () => {
    // The owner creates the draft in their own mailbox. The administrator
    // is a separate user with NO mailbox_members entry — but they hold the
    // 'administrator' role which carries role.manage, so the
    // assertCan(c.env.DB, adminId, mailboxId, 'read', isAdmin=true) bypass
    // authorises them. This exercises the multi-association iteration
    // path indirectly (single association, admin bypass) and pins that a
    // 200 is returned, not a 403 / 404.
    const ownerId = await createUserWithRole('member', 'owner-admin@example.com');
    const ownerToken = await createSession(ownerId);
    const adminId = await createUserWithRole('administrator', 'admin@example.com');
    const adminToken = await createSession(adminId);

    const domainId = await createDomain();
    const mailboxId = await createMailbox(domainId, ownerId, 'admin-shared');

    // Confirm the admin has NO mailbox_members row — the assertion relies
    // on the role.manage bypass, not on membership.
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
        subject: 'Admin can read',
        body_text: 'body',
        to: ['to-admin-read@example.com'],
      },
      'drafts-read-admin-001',
    );

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
    expect(body.data.subject).toBe('Admin can read');
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
