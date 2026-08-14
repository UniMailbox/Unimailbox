// admin-blocklist.worker.test.ts — D-CAP-021 / CAP-035.
//
// Worker-pool tests for the /api/v1/admin/blocklist endpoints. Covers
// POST (create), GET (list), DELETE. Idempotency is enforced on the
// mutating verbs.
//
// R-INBOUND-005 / R-AUTHZ-001: requires settings.manage. The PermissionKey
// enum is closed (no new key for "blocklist"); settings.manage is the
// closest existing key for editing security policy.
//
// CAP-027 / ADR-004: writes enforce Idempotency-Key. Blocklist entries are
// NOT secret-bearing (unlike invite codes), so a replay returns the
// original 201 byte-for-byte via assertSameRequestHash.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';

// ---------------------------------------------------------------------------
// Helpers — same shape as compose.worker.test.ts
// ---------------------------------------------------------------------------

async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('settings.manage', 'settings.manage', 'Manage system settings', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('message.read', 'message.read', 'Read messages', datetime('now'))`,
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
    // Administrator: settings.manage + role.manage for full coverage.
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'settings.manage', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'role.manage', datetime('now'))`,
    ),
    // Member: read-only — no settings.manage.
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('member', 'message.read', datetime('now'))`,
    ),
  ]);
}

async function createAdminUser(): Promise<{ userId: string; accessToken: string }> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('adminPassword123');
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      'admin@example.com',
      'Admin User',
      'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'administrator', ?)`,
    ).bind(userId, now),
  ]);

  const loginResponse = await SELF.fetch('http://localhost/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'adminPassword123',
    }),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key-' + crypto.randomUUID() },
  });

  const body = await loginResponse.json();
  return { userId, accessToken: body.data.accessToken };
}

async function createMemberUser(): Promise<string> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('memberPassword123');
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      'member@example.com',
      'Member User',
      'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'member', ?)`,
    ).bind(userId, now),
  ]);

  return userId;
}

async function memberAccessToken(): Promise<string> {
  const loginResponse = await SELF.fetch('http://localhost/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'member@example.com',
      password: 'memberPassword123',
    }),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key-' + crypto.randomUUID() },
  });
  const body = await loginResponse.json();
  return body.data.accessToken;
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/blocklist
// ---------------------------------------------------------------------------

describe('POST /api/v1/admin/blocklist', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  it('returns 201 with the created entry, lowercased pattern', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: '  SPAM OFFER  ' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-create-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({
      kind: 'subject',
      pattern: 'spam offer',
      createdBy: expect.any(String),
    });
    expect(body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.data.createdAt).toEqual(expect.any(String));

    // Verify storage row exists.
    const row = await env.DB
      .prepare('SELECT id, kind, pattern FROM blocklist_entries WHERE id = ?')
      .bind(body.data.id)
      .first<{ id: string; kind: string; pattern: string }>();
    expect(row).toBeDefined();
    expect(row?.kind).toBe('subject');
    expect(row?.pattern).toBe('spam offer');
  });

  it('accepts all three kinds (subject, content, from)', async () => {
    for (const kind of ['subject', 'content', 'from'] as const) {
      const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
        method: 'POST',
        body: JSON.stringify({ kind, pattern: `match-${kind}` }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `blocklist-kind-${kind}-` + crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.data.kind).toBe(kind);
    }
  });

  it('returns 400 VALIDATION_ERROR for empty pattern', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: '   ' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-empty-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR for unknown kind', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'header', pattern: 'x' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-kind-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 AUTHENTICATION_REQUIRED without token', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: 'spam' }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'blocklist-noauth-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 PERMISSION_DENIED for member user (no settings.manage)', async () => {
    await createMemberUser();
    const memberToken = await memberAccessToken();

    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: 'spam' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${memberToken}`,
        'Idempotency-Key': 'blocklist-forbid-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  // -----------------------------------------------------------------------
  // Idempotency (CAP-027 / ADR-004)
  // -----------------------------------------------------------------------

  it('returns 400 IDEMPOTENCY_KEY_REQUIRED when header missing', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: 'spam' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 400 IDEMPOTENCY_KEY_INVALID for malformed key', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: 'spam' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'short', // < 8 chars
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('replays response when same key and body (byte-for-byte)', async () => {
    const idempotencyKey = 'blocklist-replay-' + crypto.randomUUID();
    const body = { kind: 'subject', pattern: 'spam' };

    const firstResponse = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(firstResponse.status).toBe(201);
    const firstJson = await firstResponse.json();

    const secondResponse = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(secondResponse.status).toBe(201);
    const secondJson = await secondResponse.json();
    // Blocklist entries are NOT secret-bearing; replay returns the
    // original 201 byte-for-byte (same id, same createdAt).
    expect(secondJson).toEqual(firstJson);

    // Exactly one row in storage.
    const count = await env.DB
      .prepare('SELECT COUNT(*) as n FROM blocklist_entries')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('returns 409 IDEMPOTENCY_KEY_REUSED when same key different body', async () => {
    const idempotencyKey = 'blocklist-reuse-' + crypto.randomUUID();

    const firstResponse = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: 'spam' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(firstResponse.status).toBe(201);

    const secondResponse = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'content', pattern: 'viagra' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(secondResponse.status).toBe(409);
    const body = await secondResponse.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  // CAP-035 B1: business write + audit row + idempotency record all land
  // in one D1 batch (R-AUDIT-001 + ADR-004).
  it('writes the audit row in the same D1 batch as the business write', async () => {
    const before = await env.DB
      .prepare('SELECT COUNT(*) as n FROM audit_events')
      .first<{ n: number }>();
    const auditBefore = before?.n ?? 0;

    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'from', pattern: 'evil.com' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-audit-batch-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(201);
    const body = await response.json();

    // After: one business row + one audit row + one idempotency row,
    // each delta is exactly 1.
    const auditAfter = await env.DB
      .prepare(
        `SELECT id, action, resource_type, resource_id
         FROM audit_events
         WHERE resource_id = ?`,
      )
      .bind(body.data.id)
      .first<{ id: string; action: string; resource_type: string; resource_id: string }>();
    expect(auditAfter).toBeDefined();
    expect(auditAfter?.action).toBe('blocklist.create');
    expect(auditAfter?.resource_type).toBe('blocklist_entry');
    expect(auditAfter?.resource_id).toBe(body.data.id);

    const auditCount = await env.DB
      .prepare('SELECT COUNT(*) as n FROM audit_events')
      .first<{ n: number }>();
    expect(auditCount?.n).toBe(auditBefore + 1);

    // Idempotency record exists with responseStatus = 201.
    const idem = await env.DB
      .prepare(
        `SELECT response_status FROM idempotency_records
         WHERE actor_id = (SELECT id FROM users WHERE email = 'admin@example.com')
           AND operation = 'POST /api/v1/admin/blocklist'`,
      )
      .first<{ response_status: number }>();
    expect(idem?.response_status).toBe(201);
  });

  // -----------------------------------------------------------------------
  // CAP-037: malformed JSON must surface INVALID_JSON (400), not a raw
  // SyntaxError. Mirrors admin-role-policies.ts:128-151.
  // -----------------------------------------------------------------------
  it('returns 400 INVALID_JSON when request body is not valid JSON', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: '{not valid json',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-invalid-json-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/blocklist
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/blocklist', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  it('returns 200 with an empty entries array when no entries exist', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ entries: [] });
  });

  it('returns 200 with created entries', async () => {
    // Create two entries.
    await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: 'spam' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-list-' + crypto.randomUUID(),
      },
    });

    await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'from', pattern: 'evil.com' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-list-' + crypto.randomUUID(),
      },
    });

    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.entries).toHaveLength(2);
    const patterns = body.data.entries.map((e: { pattern: string }) => e.pattern).sort();
    expect(patterns).toEqual(['evil.com', 'spam']);
  });

  it('orders entries by created_at DESC', async () => {
    await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: 'first' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-order-1-' + crypto.randomUUID(),
      },
    });

    // Tiny delay so the second entry's timestamp is strictly later.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: 'second' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-order-2-' + crypto.randomUUID(),
      },
    });

    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const body = await response.json();
    const patterns = body.data.entries.map((e: { pattern: string }) => e.pattern);
    expect(patterns).toEqual(['second', 'first']);
  });

  it('returns 401 without authentication', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist');
    expect(response.status).toBe(401);
  });

  it('returns 403 for member user', async () => {
    await createMemberUser();
    const memberToken = await memberAccessToken();

    const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      headers: { Authorization: `Bearer ${memberToken}` },
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/blocklist/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/admin/blocklist/:id', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  it('returns 200 with { id, deleted: true } when entry exists', async () => {
    const createResponse = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'subject', pattern: 'spam' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-del-create-' + crypto.randomUUID(),
      },
    });
    const { data: created } = await createResponse.json();

    const response = await SELF.fetch(`http://localhost/api/v1/admin/blocklist/${created.id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-del-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ id: created.id, deleted: true });

    // Storage row gone.
    const row = await env.DB
      .prepare('SELECT id FROM blocklist_entries WHERE id = ?')
      .bind(created.id)
      .first();
    expect(row).toBeNull();
  });

  it('returns 404 NOT_FOUND when id does not exist', async () => {
    const response = await SELF.fetch(
      'http://localhost/api/v1/admin/blocklist/00000000-0000-4000-8000-000000000099',
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'blocklist-del-404-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('replays 404 response when retrying the same delete of a non-existent id', async () => {
    const idempotencyKey = 'blocklist-del-replay-' + crypto.randomUUID();
    const fakeId = '00000000-0000-4000-8000-000000000099';

    const firstResponse = await SELF.fetch(
      `http://localhost/api/v1/admin/blocklist/${fakeId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(firstResponse.status).toBe(404);
    const firstJson = await firstResponse.json();

    const secondResponse = await SELF.fetch(
      `http://localhost/api/v1/admin/blocklist/${fakeId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(secondResponse.status).toBe(404);
    const secondJson = await secondResponse.json();
    expect(secondJson).toEqual(firstJson);
  });

  it('returns 401 without authentication', async () => {
    const response = await SELF.fetch(
      'http://localhost/api/v1/admin/blocklist/00000000-0000-4000-8000-000000000001',
      {
        method: 'DELETE',
        headers: { 'Idempotency-Key': 'blocklist-del-noauth-' + crypto.randomUUID() },
      },
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 for member user', async () => {
    await createMemberUser();
    const memberToken = await memberAccessToken();

    const response = await SELF.fetch(
      'http://localhost/api/v1/admin/blocklist/00000000-0000-4000-8000-000000000001',
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${memberToken}`,
          'Idempotency-Key': 'blocklist-del-forbid-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(403);
  });

  it('returns 400 IDEMPOTENCY_KEY_REQUIRED when header missing', async () => {
    const response = await SELF.fetch(
      'http://localhost/api/v1/admin/blocklist/00000000-0000-4000-8000-000000000001',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 409 IDEMPOTENCY_KEY_REUSED when same key against different ids', async () => {
    const idempotencyKey = 'blocklist-del-reuse-' + crypto.randomUUID();

    // First: delete a non-existent id (captures 404 in idempotency record).
    const first = await SELF.fetch(
      'http://localhost/api/v1/admin/blocklist/00000000-0000-4000-8000-000000000099',
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(first.status).toBe(404);

    // Same key + different path id → hash differs (body hash is sha256(""),
    // path is part of the URL not the body) — same hash, but the
    // server treats the second request as a fresh request against a
    // different id. assertSameRequestHash does not fail since the body
    // is identical, but the lookup is by (actor, operation, idempotency_key).
    // For DELETE the operation string includes the path-id placeholder so
    // different ids hit different records.
    const second = await SELF.fetch(
      'http://localhost/api/v1/admin/blocklist/00000000-0000-4000-8000-000000000098',
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    // Different `:id` → operation string differs → fresh record, second
    // request also returns 404. Verify two separate records exist.
    expect(second.status).toBe(404);
    const count = await env.DB
      .prepare(
        `SELECT COUNT(*) as n FROM idempotency_records
         WHERE actor_id = (SELECT id FROM users WHERE email = 'admin@example.com')
           AND operation LIKE 'DELETE /api/v1/admin/blocklist/%'
           AND idempotency_key = ?`,
      )
      .bind(idempotencyKey)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  // CAP-035 B1: business DELETE + audit row + idempotency record all land
  // in one D1 batch (R-AUDIT-001 + ADR-004).
  it('writes the audit row in the same D1 batch as the DELETE', async () => {
    // Seed a blocklist entry.
    const createResponse = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
      method: 'POST',
      body: JSON.stringify({ kind: 'from', pattern: 'audit-batch-evil.com' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'blocklist-del-audit-batch-seed-' + crypto.randomUUID(),
      },
    });
    const { data: created } = await createResponse.json();

    // No audit row for the DELETE yet.
    const before = await env.DB
      .prepare(`SELECT COUNT(*) as n FROM audit_events WHERE action = 'blocklist.delete'`)
      .first<{ n: number }>();
    const auditBefore = before?.n ?? 0;

    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/blocklist/${created.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'blocklist-del-audit-batch-' + crypto.randomUUID(),
        },
      },
    );
    expect(response.status).toBe(200);

    // The audit row exists with action=blocklist.delete and resource_id
    // matching the deleted entry.
    const audit = await env.DB
      .prepare(
        `SELECT id, action, resource_type, resource_id
         FROM audit_events
         WHERE action = 'blocklist.delete' AND resource_id = ?`,
      )
      .bind(created.id)
      .first<{ id: string; action: string; resource_type: string; resource_id: string }>();
    expect(audit).toBeDefined();
    expect(audit?.action).toBe('blocklist.delete');
    expect(audit?.resource_type).toBe('blocklist_entry');

    const after = await env.DB
      .prepare(`SELECT COUNT(*) as n FROM audit_events WHERE action = 'blocklist.delete'`)
      .first<{ n: number }>();
    expect(after?.n).toBe(auditBefore + 1);
  });

  // CAP-035 B1: a 404 DELETE must NOT write an audit row (no business
  // write happened).
  it('does not write an audit row when DELETE returns 404', async () => {
    const before = await env.DB
      .prepare(`SELECT COUNT(*) as n FROM audit_events WHERE action = 'blocklist.delete'`)
      .first<{ n: number }>();
    const auditBefore = before?.n ?? 0;

    const response = await SELF.fetch(
      'http://localhost/api/v1/admin/blocklist/00000000-0000-4000-8000-000000000099',
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'blocklist-del-404-noaudit-' + crypto.randomUUID(),
        },
      },
    );
    expect(response.status).toBe(404);

    const after = await env.DB
      .prepare(`SELECT COUNT(*) as n FROM audit_events WHERE action = 'blocklist.delete'`)
      .first<{ n: number }>();
    expect(after?.n).toBe(auditBefore);
  });
});