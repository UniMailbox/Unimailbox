// admin-role-policies.worker.test.ts — D-CAP-021 / CAP-035.
//
// Worker-pool tests for the /api/v1/admin/roles/:id/policy endpoints. Covers
// GET (read policy) and PUT (replace policy).
//
// R-INBOUND-006: per-role banEmail + availDomain JSON arrays. PUT replaces
// both arrays atomically (INSERT OR REPLACE).
//
// R-AUTHZ-001: requires role.manage. The PermissionKey enum is closed.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';

// ---------------------------------------------------------------------------
// Helpers
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
    // Administrator: role.manage + settings.manage.
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'role.manage', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'settings.manage', datetime('now'))`,
    ),
    // Member: read-only — no role.manage.
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

const ROLE_ID = 'administrator';

// ---------------------------------------------------------------------------
// GET /api/v1/admin/roles/:id/policy
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/roles/:id/policy', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  it('returns 200 with empty arrays when no policy row exists', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({
      roleId: ROLE_ID,
      banEmail: [],
      availDomain: [],
      updatedBy: null,
      updatedAt: '',
    });
  });

  it('returns 200 with stored arrays after PUT', async () => {
    // Set a policy first.
    await SELF.fetch(`http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`, {
      method: 'PUT',
      body: JSON.stringify({
        banEmail: ['spammer@example.com', '@evil.com'],
        availDomain: ['@allowed.com'],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'role-policy-get-pre-' + crypto.randomUUID(),
      },
    });

    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.roleId).toBe(ROLE_ID);
    expect(body.data.banEmail).toEqual(['spammer@example.com', '@evil.com']);
    expect(body.data.availDomain).toEqual(['@allowed.com']);
    expect(body.data.updatedBy).toEqual(expect.any(String));
    expect(body.data.updatedAt).toEqual(expect.any(String));
  });

  it('returns 401 without authentication', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
    );
    expect(response.status).toBe(401);
  });

  it('returns 403 for member user (no role.manage)', async () => {
    await createMemberUser();
    const memberToken = await memberAccessToken();

    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      { headers: { Authorization: `Bearer ${memberToken}` } },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// PUT /api/v1/admin/roles/:id/policy
// ---------------------------------------------------------------------------

describe('PUT /api/v1/admin/roles/:id/policy', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  it('returns 200 with the stored policy on first PUT', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({
          banEmail: ['spammer@example.com'],
          availDomain: ['@allowed.com'],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'role-policy-put-first-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.roleId).toBe(ROLE_ID);
    expect(body.data.banEmail).toEqual(['spammer@example.com']);
    expect(body.data.availDomain).toEqual(['@allowed.com']);
    expect(body.data.updatedBy).toEqual(expect.any(String));
    expect(body.data.updatedAt).toEqual(expect.any(String));

    // Storage row exists with JSON columns populated.
    const row = await env.DB
      .prepare(
        'SELECT ban_email_patterns_json, avail_domain_patterns_json FROM role_policies WHERE role_id = ?',
      )
      .bind(ROLE_ID)
      .first<{ ban_email_patterns_json: string; avail_domain_patterns_json: string }>();
    expect(row).toBeDefined();
    if (!row) throw new Error('expected role_policies row');
    expect(JSON.parse(row.ban_email_patterns_json)).toEqual(['spammer@example.com']);
    expect(JSON.parse(row.avail_domain_patterns_json)).toEqual(['@allowed.com']);
  });

  it('replaces both arrays on subsequent PUT (full-replace semantics)', async () => {
    // First PUT: ban list populated.
    await SELF.fetch(`http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`, {
      method: 'PUT',
      body: JSON.stringify({
        banEmail: ['old@example.com'],
        availDomain: ['@old.com'],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'role-policy-put-1-' + crypto.randomUUID(),
      },
    });

    // Second PUT: completely different arrays.
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({
          banEmail: ['new@example.com', '*'],
          availDomain: ['@new.com', '@another.com'],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'role-policy-put-2-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.banEmail).toEqual(['new@example.com', '*']);
    expect(body.data.availDomain).toEqual(['@new.com', '@another.com']);
  });

  it('accepts empty arrays (clears existing policy)', async () => {
    // Seed an existing policy.
    await SELF.fetch(`http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`, {
      method: 'PUT',
      body: JSON.stringify({
        banEmail: ['something@example.com'],
        availDomain: ['@somewhere.com'],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'role-policy-seed-' + crypto.randomUUID(),
      },
    });

    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({ banEmail: [], availDomain: [] }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'role-policy-empty-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.banEmail).toEqual([]);
    expect(body.data.availDomain).toEqual([]);
  });

  it('returns 400 VALIDATION_ERROR for banEmail entry without @ or *', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({
          banEmail: ['not-a-valid-pattern'],
          availDomain: [],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'role-policy-badban-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR for availDomain without leading @', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({
          banEmail: [],
          availDomain: ['allowed.com'], // missing @
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'role-policy-badavail-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 IDEMPOTENCY_KEY_REQUIRED when header missing', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({ banEmail: [], availDomain: [] }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 401 without authentication', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({ banEmail: [], availDomain: [] }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'role-policy-noauth-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 for member user', async () => {
    await createMemberUser();
    const memberToken = await memberAccessToken();

    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({ banEmail: [], availDomain: [] }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${memberToken}`,
          'Idempotency-Key': 'role-policy-forbid-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(403);
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------

  it('replays response when same key and body', async () => {
    const idempotencyKey = 'role-policy-replay-' + crypto.randomUUID();
    const body = {
      banEmail: ['spammer@example.com'],
      availDomain: ['@allowed.com'],
    };

    const firstResponse = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(firstResponse.status).toBe(200);
    const firstJson = await firstResponse.json();

    const secondResponse = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(secondResponse.status).toBe(200);
    const secondJson = await secondResponse.json();
    expect(secondJson).toEqual(firstJson);
  });

  it('returns 409 IDEMPOTENCY_KEY_REUSED when same key different body', async () => {
    const idempotencyKey = 'role-policy-reuse-' + crypto.randomUUID();

    await SELF.fetch(`http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`, {
      method: 'PUT',
      body: JSON.stringify({ banEmail: [], availDomain: [] }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({ banEmail: ['new@example.com'], availDomain: [] }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  // -----------------------------------------------------------------------
  // CAP-035 H1: per-role operation namespace.
  // The Idempotency-Key alone is NOT unique across role ids; the operation
  // string includes the role id. PUT against role A and PUT against role B
  // with the same Idempotency-Key must each get their own fresh record.
  // -----------------------------------------------------------------------
  it('does not collide when same Idempotency-Key is used against two different roles', async () => {
    const idempotencyKey = 'role-policy-crossrole-' + crypto.randomUUID();

    // PUT against the administrator role.
    const first = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/administrator/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({
          banEmail: ['adminban@example.com'],
          availDomain: ['@admin.example.com'],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    // PUT against the member role with the SAME Idempotency-Key but a
    // DIFFERENT body — must NOT return 409 IDEMPOTENCY_KEY_REUSED, because
    // the operation string (`PUT /api/v1/admin/roles/member/policy`) is
    // different from the first request's. Each role owns its idempotency
    // namespace.
    const second = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/member/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({
          banEmail: ['memberban@example.com'],
          availDomain: ['@member.example.com'],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );

    expect(second.status).toBe(200);
    const secondBody = await second.json();

    // Each request wrote its own policy row.
    expect(firstBody.data.banEmail).toEqual(['adminban@example.com']);
    expect(secondBody.data.banEmail).toEqual(['memberban@example.com']);

    // Both rows exist with distinct content.
    const adminRow = await env.DB
      .prepare(
        'SELECT ban_email_patterns_json FROM role_policies WHERE role_id = ?',
      )
      .bind('administrator')
      .first<{ ban_email_patterns_json: string }>();
    const memberRow = await env.DB
      .prepare(
        'SELECT ban_email_patterns_json FROM role_policies WHERE role_id = ?',
      )
      .bind('member')
      .first<{ ban_email_patterns_json: string }>();
    expect(JSON.parse(adminRow?.ban_email_patterns_json ?? '[]')).toEqual([
      'adminban@example.com',
    ]);
    expect(JSON.parse(memberRow?.ban_email_patterns_json ?? '[]')).toEqual([
      'memberban@example.com',
    ]);

    // Two separate idempotency records exist — keyed by (actor, operation,
    // idempotency_key). Same key, different operation strings.
    const records = await env.DB
      .prepare(
        `SELECT operation FROM idempotency_records
         WHERE actor_id = (SELECT id FROM users WHERE email = 'admin@example.com')
           AND idempotency_key = ?
           AND operation LIKE 'PUT /api/v1/admin/roles/%/policy'`,
      )
      .bind(idempotencyKey)
      .all<{ operation: string }>();
    expect(records.results?.length).toBe(2);
    const ops = new Set((records.results ?? []).map((r) => r.operation));
    expect(ops.has('PUT /api/v1/admin/roles/administrator/policy')).toBe(true);
    expect(ops.has('PUT /api/v1/admin/roles/member/policy')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // CAP-035 B1: business PUT + audit row + idempotency record all land
  // in one D1 batch (R-AUDIT-001 + ADR-004).
  // -----------------------------------------------------------------------
  it('writes the audit row in the same D1 batch as the business PUT', async () => {
    const before = await env.DB
      .prepare(
        `SELECT COUNT(*) as n FROM audit_events WHERE action = 'role_policy.set'`,
      )
      .first<{ n: number }>();
    const auditBefore = before?.n ?? 0;

    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({
          banEmail: ['audit-batch@example.com'],
          availDomain: ['@audit-batch.example.com'],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'role-policy-audit-batch-' + crypto.randomUUID(),
        },
      },
    );
    expect(response.status).toBe(200);

    // The audit row exists with action=role_policy.set and resource_id
    // equal to the roleId.
    const audit = await env.DB
      .prepare(
        `SELECT id, action, resource_type, resource_id
         FROM audit_events
         WHERE action = 'role_policy.set' AND resource_id = ?`,
      )
      .bind(ROLE_ID)
      .first<{ id: string; action: string; resource_type: string; resource_id: string }>();
    expect(audit).toBeDefined();
    expect(audit?.action).toBe('role_policy.set');
    expect(audit?.resource_type).toBe('role_policy');

    // Exactly one new audit row was inserted.
    const after = await env.DB
      .prepare(
        `SELECT COUNT(*) as n FROM audit_events WHERE action = 'role_policy.set'`,
      )
      .first<{ n: number }>();
    expect(after?.n).toBe(auditBefore + 1);

    // The idempotency record exists with the per-role operation string.
    const idem = await env.DB
      .prepare(
        `SELECT response_status, operation FROM idempotency_records
         WHERE actor_id = (SELECT id FROM users WHERE email = 'admin@example.com')
           AND operation = ?`,
      )
      .bind(`PUT /api/v1/admin/roles/${ROLE_ID}/policy`)
      .first<{ response_status: number; operation: string }>();
    expect(idem?.response_status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // CAP-035 Security M1: malformed JSON must surface INVALID_JSON (400),
  // not a raw SyntaxError.
  // -----------------------------------------------------------------------
  it('returns 400 INVALID_JSON when request body is not valid JSON', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: '{not valid json',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'role-policy-invalid-json-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });

  // -----------------------------------------------------------------------
  // CAP-035 Code M4: banEmail `*` wildcard semantics — must persist and
  // be readable as a literal `*` entry (matchesBanEmail unit tests cover
  // the matching; this test verifies storage round-trip).
  // -----------------------------------------------------------------------
  it('accepts and persists a banEmail wildcard `*` entry', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/roles/${ROLE_ID}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify({
          banEmail: ['*'],
          availDomain: [],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'role-policy-wildcard-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.banEmail).toEqual(['*']);

    const row = await env.DB
      .prepare(
        'SELECT ban_email_patterns_json FROM role_policies WHERE role_id = ?',
      )
      .bind(ROLE_ID)
      .first<{ ban_email_patterns_json: string }>();
    expect(JSON.parse(row?.ban_email_patterns_json ?? '[]')).toEqual(['*']);
  });
});