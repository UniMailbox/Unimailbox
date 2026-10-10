// CAP-066 — managed-domain administration Worker-pool tests.
// These exercise the real router, D1, KV auth, permissions, audit rows, and
// idempotency records. External providers are not involved in this slice.

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';

const BASE = 'http://localhost/api/v1/admin/domains';
const DOMAIN_ID = '00000000-0000-4000-8000-000000000001';

async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('domain.read', 'domain.read', 'Read domains', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('domain.manage', 'domain.manage', 'Manage domains', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'domain.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'domain.manage', datetime('now'))`,
    ),
  ]);
}

async function createUser(role: 'administrator' | 'member', email: string): Promise<string> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('testPassword123');
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      email,
      role,
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(`INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)`).bind(
      userId,
      role,
      now,
    ),
  ]);
  return userId;
}

async function createToken(userId: string): Promise<string> {
  const token = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, userId, crypto.randomUUID(), 2_000_000_000, new Date().toISOString())
    .run();
  await env.CACHE.put(`auth:${token}`, JSON.stringify({ userId, sessionId }), {
    expirationTtl: 900,
  });
  return token;
}

async function setupAdmin(): Promise<string> {
  await resetAndMigrate();
  await completeSetup();
  return createToken(await createUser('administrator', `admin-${crypto.randomUUID()}@example.com`));
}

async function setupMember(): Promise<string> {
  await resetAndMigrate();
  await completeSetup();
  return createToken(await createUser('member', `member-${crypto.randomUUID()}@example.com`));
}

async function seedProviderConnection(
  status: 'active' | 'disabled' | 'invalid' = 'active',
): Promise<string> {
  const connectionId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const now = '2026-08-31 00:00:00';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      credentialId,
      `credential-${connectionId}`,
      new Uint8Array(16),
      new Uint8Array(12),
      new Uint8Array(16),
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, created_at, updated_at)
       VALUES (?, 'brevo', ?, ?, ?, ?, ?)`,
    ).bind(connectionId, `Brevo ${connectionId}`, credentialId, status, now, now),
  ]);
  return connectionId;
}

function authHeaders(token: string, idempotencyKey?: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
  };
}

describe('GET /api/v1/admin/domains', () => {
  it('requires domain.read and returns only the safe projection', async () => {
    const adminToken = await setupAdmin();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)`,
    )
      .bind(
        DOMAIN_ID,
        'example.com',
        'connection-secret-adjacent',
        '2026-08-31 00:00:00',
        '2026-08-31 00:00:00',
      )
      .run();

    const response = await SELF.fetch(BASE, {
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([
      {
        id: DOMAIN_ID,
        name: 'example.com',
        status: 'active',
        outboundConnectionId: 'connection-secret-adjacent',
        createdAt: '2026-08-31 00:00:00',
        updatedAt: '2026-08-31 00:00:00',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('credential');
  });

  it('returns 401 anonymously and 403 to a member', async () => {
    await setupAdmin();
    const anonymous = await SELF.fetch(BASE);
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe('AUTHENTICATION_REQUIRED');

    const memberToken = await setupMember();
    const member = await SELF.fetch(BASE, { headers: authHeaders(memberToken) });
    expect(member.status).toBe(403);
    expect((await member.json()).error.code).toBe('PERMISSION_DENIED');
  });
});

describe('PATCH /api/v1/admin/domains/:id/outbound-connection', () => {
  it('binds an active connection, audits it, and replays the same response', async () => {
    const adminToken = await setupAdmin();
    const connectionId = await seedProviderConnection();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, 'example.com', 'active', NULL, ?, ?)`,
    )
      .bind(DOMAIN_ID, '2026-08-31 00:00:00', '2026-08-31 00:00:00')
      .run();

    const key = `domain-bind-${crypto.randomUUID()}`;
    const request = {
      method: 'PATCH',
      body: JSON.stringify({ connectionId }),
      headers: {
        ...authHeaders(adminToken, key),
        'Content-Type': 'application/json',
        'If-Match': '2026-08-31 00:00:00',
      },
    } as const;
    const first = await SELF.fetch(`${BASE}/${DOMAIN_ID}/outbound-connection`, request);
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(JSON.parse(firstText).data).toMatchObject({
      id: DOMAIN_ID,
      outboundConnectionId: connectionId,
    });
    const replay = await SELF.fetch(`${BASE}/${DOMAIN_ID}/outbound-connection`, request);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstText);
    expect(
      await env.DB.prepare('SELECT outbound_connection_id FROM managed_domains WHERE id = ?')
        .bind(DOMAIN_ID)
        .first(),
    ).toEqual({ outbound_connection_id: connectionId });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'domain.outbound_connection.updated'`,
      ).first(),
    ).toEqual({ count: 1 });
  });

  it('rejects missing, inactive, unknown, stale, and unauthorized assignments', async () => {
    const adminToken = await setupAdmin();
    const memberToken = await createToken(
      await createUser('member', `member-${crypto.randomUUID()}@example.com`),
    );
    const disabledConnectionId = await seedProviderConnection('disabled');
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, 'example.com', 'active', NULL, ?, ?)`,
    )
      .bind(DOMAIN_ID, '2026-08-31 00:00:00', '2026-08-31 00:00:00')
      .run();
    const path = `${BASE}/${DOMAIN_ID}/outbound-connection`;
    const body = JSON.stringify({ connectionId: disabledConnectionId });
    const baseHeaders = {
      ...authHeaders(adminToken, 'domain-bind-invalid'),
      'Content-Type': 'application/json',
    };

    const missingIfMatch = await SELF.fetch(path, {
      method: 'PATCH',
      body,
      headers: baseHeaders,
    });
    expect(missingIfMatch.status).toBe(400);
    expect((await missingIfMatch.json()).error.code).toBe('IF_MATCH_REQUIRED');

    const disabled = await SELF.fetch(path, {
      method: 'PATCH',
      body,
      headers: {
        ...baseHeaders,
        'Idempotency-Key': 'domain-bind-disabled',
        'If-Match': '2026-08-31 00:00:00',
      },
    });
    expect(disabled.status).toBe(409);
    expect((await disabled.json()).error.code).toBe('PROVIDER_CONNECTION_NOT_ACTIVE');

    const stale = await SELF.fetch(path, {
      method: 'PATCH',
      body: JSON.stringify({ connectionId: null }),
      headers: {
        ...baseHeaders,
        'Idempotency-Key': 'domain-bind-stale',
        'If-Match': '2020-01-01 00:00:00',
      },
    });
    expect(stale.status).toBe(412);
    expect((await stale.json()).error.code).toBe('STALE_IF_MATCH');

    const member = await SELF.fetch(path, {
      method: 'PATCH',
      body: JSON.stringify({ connectionId: null }),
      headers: {
        ...authHeaders(memberToken, 'domain-bind-member'),
        'Content-Type': 'application/json',
        'If-Match': '2026-08-31 00:00:00',
      },
    });
    expect(member.status).toBe(403);
    expect((await member.json()).error.code).toBe('PERMISSION_DENIED');
  });
});

describe('POST /api/v1/admin/domains', () => {
  let adminToken: string;

  beforeEach(async () => {
    adminToken = await setupAdmin();
  });

  it('creates a normalized active domain, audits it, and replays byte-for-byte', async () => {
    const key = `domain-create-${crypto.randomUUID()}`;
    const request = {
      method: 'POST',
      body: JSON.stringify({ name: '  EXAMPLE.COM ' }),
      headers: { ...authHeaders(adminToken, key), 'Content-Type': 'application/json' },
    } as const;
    const first = await SELF.fetch(BASE, request);
    expect(first.status).toBe(201);
    const firstText = await first.text();
    expect(JSON.parse(firstText).data).toMatchObject({ name: 'example.com', status: 'active' });

    const replay = await SELF.fetch(BASE, request);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);

    const domainRows = await env.DB.prepare('SELECT id FROM managed_domains').all();
    expect(domainRows.results).toHaveLength(1);
    const auditRows = await env.DB.prepare(
      `SELECT action, resource_type FROM audit_events WHERE action = 'domain.created'`,
    ).all<{ action: string; resource_type: string }>();
    expect(auditRows.results).toEqual([
      { action: 'domain.created', resource_type: 'managed_domain' },
    ]);
  });

  it('replays a same-key concurrent create instead of surfacing a domain duplicate', async () => {
    const key = `domain-create-race-${crypto.randomUUID()}`;
    const request = (): RequestInit => ({
      method: 'POST',
      body: JSON.stringify({ name: 'race.example.com' }),
      headers: { ...authHeaders(adminToken, key), 'Content-Type': 'application/json' },
    });
    const responses = await Promise.all([SELF.fetch(BASE, request()), SELF.fetch(BASE, request())]);
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM managed_domains').first<{
        count: number;
      }>(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'domain.created'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('maps case-insensitive duplicates and strict malformed bodies', async () => {
    const first = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ name: 'example.com' }),
      headers: { ...authHeaders(adminToken, 'domain-first'), 'Content-Type': 'application/json' },
    });
    expect(first.status).toBe(201);

    const duplicate = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ name: 'EXAMPLE.COM' }),
      headers: {
        ...authHeaders(adminToken, 'domain-duplicate'),
        'Content-Type': 'application/json',
      },
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('DOMAIN_ALREADY_MANAGED');

    const unknownField = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ name: 'second.example.com', status: 'active' }),
      headers: {
        ...authHeaders(adminToken, 'domain-unknown-field'),
        'Content-Type': 'application/json',
      },
    });
    expect(unknownField.status).toBe(400);
    expect((await unknownField.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an idempotency key reused with a different body', async () => {
    const key = 'domain-key-reuse';
    const headers = { ...authHeaders(adminToken, key), 'Content-Type': 'application/json' };
    expect(
      (
        await SELF.fetch(BASE, {
          method: 'POST',
          body: JSON.stringify({ name: 'first.example.com' }),
          headers,
        })
      ).status,
    ).toBe(201);
    const response = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ name: 'second.example.com' }),
      headers,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('POST /api/v1/admin/domains/:id/verify', () => {
  it('records operator confirmation for an active domain without claiming a provider check', async () => {
    const adminToken = await setupAdmin();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, created_at, updated_at) VALUES (?, 'example.com', 'active', ?, ?)`,
    )
      .bind(DOMAIN_ID, '2026-08-31 00:00:00', '2026-08-31 00:00:00')
      .run();
    const key = `domain-verify-${crypto.randomUUID()}`;

    const response = await SELF.fetch(`${BASE}/${DOMAIN_ID}/verify`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: authHeaders(adminToken, key),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { verified: true, domain: 'example.com' } });
    const audit = await env.DB.prepare(`SELECT action FROM audit_events WHERE resource_id = ?`)
      .bind(DOMAIN_ID)
      .all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toEqual(['domain.verified']);

    const replay = await SELF.fetch(`${BASE}/${DOMAIN_ID}/verify`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: authHeaders(adminToken, key),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ data: { verified: true, domain: 'example.com' } });
  });

  it('returns stable missing and inactive outcomes', async () => {
    const adminToken = await setupAdmin();
    const invalidId = await SELF.fetch(`${BASE}/not-a-uuid/verify`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: authHeaders(adminToken, 'domain-verify-invalid-id'),
    });
    expect(invalidId.status).toBe(400);
    expect((await invalidId.json()).error.code).toBe('VALIDATION_ERROR');

    const missing = await SELF.fetch(`${BASE}/${DOMAIN_ID}/verify`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: authHeaders(adminToken, 'domain-verify-missing'),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('DOMAIN_NOT_FOUND');

    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, created_at, updated_at) VALUES (?, 'disabled.example.com', 'disabled', ?, ?)`,
    )
      .bind(DOMAIN_ID, '2026-08-31 00:00:00', '2026-08-31 00:00:00')
      .run();
    const inactive = await SELF.fetch(`${BASE}/${DOMAIN_ID}/verify`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: authHeaders(adminToken, 'domain-verify-inactive'),
    });
    expect(inactive.status).toBe(409);
    expect((await inactive.json()).error.code).toBe('DOMAIN_NOT_ACTIVE');
  });
});

describe('DELETE /api/v1/admin/domains/:id', () => {
  it('deletes an unused domain, audits it, and replays the response', async () => {
    const adminToken = await setupAdmin();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, created_at, updated_at) VALUES (?, 'example.com', 'active', ?, ?)`,
    )
      .bind(DOMAIN_ID, '2026-08-31 00:00:00', '2026-08-31 00:00:00')
      .run();
    const key = 'domain-delete-unused';
    const first = await SELF.fetch(`${BASE}/${DOMAIN_ID}`, {
      method: 'DELETE',
      headers: authHeaders(adminToken, key),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ data: { id: DOMAIN_ID, deleted: true } });
    expect(
      await env.DB.prepare('SELECT id FROM managed_domains WHERE id = ?').bind(DOMAIN_ID).first(),
    ).toBeNull();

    const replay = await SELF.fetch(`${BASE}/${DOMAIN_ID}`, {
      method: 'DELETE',
      headers: authHeaders(adminToken, key),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ data: { id: DOMAIN_ID, deleted: true } });
    const audit = await env.DB.prepare(`SELECT action FROM audit_events WHERE resource_id = ?`)
      .bind(DOMAIN_ID)
      .all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toEqual(['domain.deleted']);
  });

  it('replays a same-key concurrent delete without duplicating the audit', async () => {
    const adminToken = await setupAdmin();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, created_at, updated_at) VALUES (?, 'race.example.com', 'active', ?, ?)`,
    )
      .bind(DOMAIN_ID, '2026-08-31 00:00:00', '2026-08-31 00:00:00')
      .run();
    const key = `domain-delete-race-${crypto.randomUUID()}`;
    const request = (): RequestInit => ({
      method: 'DELETE',
      headers: authHeaders(adminToken, key),
    });
    const responses = await Promise.all([
      SELF.fetch(`${BASE}/${DOMAIN_ID}`, request()),
      SELF.fetch(`${BASE}/${DOMAIN_ID}`, request()),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { data: { id: DOMAIN_ID, deleted: true } },
      { data: { id: DOMAIN_ID, deleted: true } },
    ]);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'domain.deleted'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('refuses to delete a domain referenced by a mailbox', async () => {
    const adminToken = await setupAdmin();
    const ownerId = await createUser('administrator', `owner-${crypto.randomUUID()}@example.com`);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO managed_domains (id, name, status, created_at, updated_at) VALUES (?, 'example.com', 'active', ?, ?)`,
      ).bind(DOMAIN_ID, '2026-08-31 00:00:00', '2026-08-31 00:00:00'),
      env.DB.prepare(
        `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'inbox', '', 'active', ?, ?)`,
      ).bind(crypto.randomUUID(), DOMAIN_ID, ownerId, '2026-08-31 00:00:00', '2026-08-31 00:00:00'),
    ]);

    const response = await SELF.fetch(`${BASE}/${DOMAIN_ID}`, {
      method: 'DELETE',
      headers: authHeaders(adminToken, 'domain-delete-in-use'),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('DOMAIN_IN_USE');
    expect(
      await env.DB.prepare('SELECT id FROM managed_domains WHERE id = ?').bind(DOMAIN_ID).first(),
    ).not.toBeNull();
    const audit = await env.DB.prepare(`SELECT action FROM audit_events WHERE resource_id = ?`)
      .bind(DOMAIN_ID)
      .all();
    expect(audit.results).toHaveLength(0);
  });
});
