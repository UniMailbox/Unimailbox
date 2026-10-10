// CAP-068 — signature administration Worker-pool tests.
// D1, KV, auth, permissions, audit, idempotency, and migration behavior are
// exercised through the real Worker pool. No storage bindings are mocked.

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';

const BASE = 'http://localhost/api/v1/admin/signatures';
const DOMAIN_A = '00000000-0000-4000-8000-000000000001';
const DOMAIN_B = '00000000-0000-4000-8000-000000000002';

async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('signature.read', 'signature.read', 'Read signatures', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('signature.manage', 'signature.manage', 'Manage signatures', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'signature.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'signature.manage', datetime('now'))`,
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

async function setup(role: 'administrator' | 'member' = 'administrator'): Promise<string> {
  await resetAndMigrate();
  await completeSetup();
  return createToken(await createUser(role, `${role}-${crypto.randomUUID()}@example.com`));
}

async function seedDomain(id: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO managed_domains (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(id, name, '2026-09-01 00:00:00', '2026-09-01 00:00:00')
    .run();
}

function headers(token: string, idempotencyKey?: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
  };
}

function jsonHeaders(token: string, idempotencyKey: string): HeadersInit {
  return { ...headers(token, idempotencyKey), 'Content-Type': 'application/json' };
}

describe('GET /api/v1/admin/signatures', () => {
  it('returns the safe projection and requires signature.read', async () => {
    const token = await setup();
    await seedDomain(DOMAIN_A, 'example.com');
    await env.DB.prepare(
      `INSERT INTO domain_signatures (id, domain_id, html_content, text_content, is_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        '00000000-0000-4000-8000-000000000003',
        DOMAIN_A,
        '<p>Regards</p>',
        'Regards',
        '2026-09-01 00:00:00',
        '2026-09-01 00:00:00',
      )
      .run();

    const response = await SELF.fetch(BASE, { headers: headers(token) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        items: [
          {
            id: '00000000-0000-4000-8000-000000000003',
            domainId: DOMAIN_A,
            domainName: 'example.com',
            htmlContent: '<p>Regards</p>',
            textContent: 'Regards',
            isEnabled: true,
            createdAt: '2026-09-01 00:00:00',
            updatedAt: '2026-09-01 00:00:00',
          },
        ],
      },
    });
    expect(
      JSON.stringify(await (await SELF.fetch(BASE, { headers: headers(token) })).json()),
    ).not.toContain('outbound_connection_id');
  });

  it('returns 401 anonymously and 403 to a member', async () => {
    await setup();
    expect((await SELF.fetch(BASE)).status).toBe(401);
    const memberToken = await setup('member');
    const response = await SELF.fetch(BASE, { headers: headers(memberToken) });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('PERMISSION_DENIED');
  });

  it('denies every signature mutation to a member before target resolution', async () => {
    const token = await setup('member');
    const body = JSON.stringify({
      domainId: DOMAIN_A,
      htmlContent: '<p>Member</p>',
      textContent: 'Member',
      isEnabled: true,
    });
    expect(
      (
        await SELF.fetch(BASE, {
          method: 'POST',
          body,
          headers: jsonHeaders(token, 'member-create'),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await SELF.fetch(`${BASE}/00000000-0000-4000-8000-000000000099`, {
          method: 'PATCH',
          body: JSON.stringify({
            htmlContent: '<p>Member</p>',
            textContent: 'Member',
            isEnabled: true,
          }),
          headers: jsonHeaders(token, 'member-update'),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await SELF.fetch(`${BASE}/00000000-0000-4000-8000-000000000099`, {
          method: 'DELETE',
          headers: headers(token, 'member-delete'),
        })
      ).status,
    ).toBe(403);
  });
});

describe('POST /api/v1/admin/signatures', () => {
  beforeEach(async () => {
    await setup();
  });

  it('sanitizes HTML, stores an enabled signature, audits, and replays byte-for-byte', async () => {
    const user = await env.DB.prepare(
      `SELECT id FROM users WHERE email LIKE 'administrator-%' LIMIT 1`,
    ).first<{ id: string }>();
    const token = await createToken(user?.id ?? '');
    await seedDomain(DOMAIN_A, 'example.com');
    const key = `signature-create-${crypto.randomUUID()}`;
    const request: RequestInit = {
      method: 'POST',
      body: JSON.stringify({
        domainId: DOMAIN_A,
        htmlContent:
          '<p onclick="alert(1)"><strong>Regards</strong></p><script>alert(2)</script><a href="javascript:alert(3)" onmouseover="x">bad</a><a href="https://example.com">good</a>',
        textContent: 'Regards',
        isEnabled: true,
      }),
      headers: jsonHeaders(token, key),
    };
    const first = await SELF.fetch(BASE, request);
    expect(first.status).toBe(201);
    const firstText = await first.text();
    expect(JSON.parse(firstText).data).toMatchObject({
      domainId: DOMAIN_A,
      htmlContent:
        '<p><strong>Regards</strong></p><a>bad</a><a href="https://example.com">good</a>',
    });
    const replay = await SELF.fetch(BASE, request);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'signature.created'`,
      ).first(),
    ).toEqual({ count: 1 });
  });

  it('rejects a duplicate domain, foreign domain, malformed body, and reused key', async () => {
    const user = await env.DB.prepare(
      `SELECT id FROM users WHERE email LIKE 'administrator-%' LIMIT 1`,
    ).first<{ id: string }>();
    const token = await createToken(user?.id ?? '');
    await seedDomain(DOMAIN_A, 'example.com');
    await seedDomain(DOMAIN_B, 'other.example.com');
    const body = {
      domainId: DOMAIN_A,
      htmlContent: '<p>One</p>',
      textContent: 'One',
      isEnabled: true,
    };
    expect(
      (
        await SELF.fetch(BASE, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: jsonHeaders(token, 'create-one'),
        })
      ).status,
    ).toBe(201);
    const duplicate = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ ...body, domainId: DOMAIN_B }),
      headers: jsonHeaders(token, 'create-one'),
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const duplicateDomain = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: jsonHeaders(token, 'create-two'),
    });
    expect(duplicateDomain.status).toBe(409);
    expect((await duplicateDomain.json()).error.code).toBe('SIGNATURE_ALREADY_EXISTS');

    const malformed = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ ...body, unexpected: true }),
      headers: jsonHeaders(token, 'create-three'),
    });
    expect(malformed.status).toBe(400);

    const unusable = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({
        ...body,
        domainId: DOMAIN_B,
        htmlContent: '<script>alert(1)</script>',
        textContent: '',
      }),
      headers: jsonHeaders(token, 'create-unusable'),
    });
    expect(unusable.status).toBe(400);
    expect((await unusable.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH and DELETE /api/v1/admin/signatures/:id', () => {
  it('updates and deletes only the addressed signature with atomic evidence', async () => {
    const token = await setup();
    await seedDomain(DOMAIN_A, 'example.com');
    const created = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({
        domainId: DOMAIN_A,
        htmlContent: '<p>One</p>',
        textContent: 'One',
        isEnabled: true,
      }),
      headers: jsonHeaders(token, 'create-for-update'),
    });
    const createdData = (await created.json()).data as { id: string; updatedAt: string };
    const signatureId = createdData.id;
    const update = await SELF.fetch(`${BASE}/${signatureId}`, {
      method: 'PATCH',
      body: JSON.stringify({ htmlContent: '<p>Two</p>', textContent: 'Two', isEnabled: false }),
      headers: { ...jsonHeaders(token, 'update-one'), 'If-Match': createdData.updatedAt },
    });
    expect(update.status).toBe(200);
    expect((await update.json()).data).toMatchObject({
      id: signatureId,
      isEnabled: false,
      textContent: 'Two',
    });
    const deleted = await SELF.fetch(`${BASE}/${signatureId}`, {
      method: 'DELETE',
      headers: headers(token, 'delete-one'),
    });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data).toEqual({ id: signatureId, deleted: true });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action IN ('signature.updated', 'signature.deleted')`,
      ).first(),
    ).toEqual({ count: 2 });
  });

  it('collapses unknown or malformed ids to a safe 404/400 and requires idempotency', async () => {
    const token = await setup();
    const missing = await SELF.fetch(`${BASE}/00000000-0000-4000-8000-000000000099`, {
      method: 'DELETE',
      headers: headers(token, 'delete-missing'),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('SIGNATURE_NOT_FOUND');
    const malformed = await SELF.fetch(`${BASE}/not-a-uuid`, {
      method: 'DELETE',
      headers: headers(token, 'delete-malformed'),
    });
    expect(malformed.status).toBe(400);
    const missingKey = await SELF.fetch(`${BASE}/00000000-0000-4000-8000-000000000099`, {
      method: 'DELETE',
      headers: headers(token),
    });
    expect(missingKey.status).toBe(400);
  });

  it('requires a matching If-Match value and rejects stale concurrent updates', async () => {
    const token = await setup();
    await seedDomain(DOMAIN_A, 'example.com');
    const created = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({
        domainId: DOMAIN_A,
        htmlContent: '<p>One</p>',
        textContent: 'One',
        isEnabled: true,
      }),
      headers: jsonHeaders(token, 'create-for-if-match'),
    });
    const createdData = (await created.json()).data as { id: string; updatedAt: string };
    const missing = await SELF.fetch(`${BASE}/${createdData.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ htmlContent: '<p>Two</p>', textContent: 'Two', isEnabled: true }),
      headers: jsonHeaders(token, 'update-missing-if-match'),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('IF_MATCH_REQUIRED');

    const stale = await SELF.fetch(`${BASE}/${createdData.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ htmlContent: '<p>Two</p>', textContent: 'Two', isEnabled: true }),
      headers: {
        ...jsonHeaders(token, 'update-stale-if-match'),
        'If-Match': '2020-01-01 00:00:00',
      },
    });
    expect(stale.status).toBe(412);
    expect((await stale.json()).error.code).toBe('STALE_IF_MATCH');
  });
});

describe('domain_signatures migration (CAP-068)', () => {
  it('enforces one signature per domain and cascades when a domain is deleted', async () => {
    await setup();
    await seedDomain(DOMAIN_A, 'example.com');
    await env.DB.prepare(
      `INSERT INTO domain_signatures (id, domain_id, html_content, text_content, is_enabled, created_at, updated_at) VALUES (?, ?, '<p>One</p>', 'One', 1, ?, ?)`,
    )
      .bind(
        '00000000-0000-4000-8000-000000000010',
        DOMAIN_A,
        '2026-09-01 00:00:00',
        '2026-09-01 00:00:00',
      )
      .run();
    await expect(
      env.DB.prepare(
        `INSERT INTO domain_signatures (id, domain_id, html_content, text_content, is_enabled, created_at, updated_at) VALUES (?, ?, '<p>Two</p>', 'Two', 1, ?, ?)`,
      )
        .bind(
          '00000000-0000-4000-8000-000000000011',
          DOMAIN_A,
          '2026-09-01 00:00:00',
          '2026-09-01 00:00:00',
        )
        .run(),
    ).rejects.toThrow();
    await env.DB.prepare(`DELETE FROM managed_domains WHERE id = ?`).bind(DOMAIN_A).run();
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS count FROM domain_signatures WHERE domain_id = ?`)
        .bind(DOMAIN_A)
        .first(),
    ).toEqual({ count: 0 });
  });
});
