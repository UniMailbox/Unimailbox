// CAP-069 — general settings administration Worker-pool tests.
// The route is exercised through real auth, D1, permissions, idempotency,
// and audit tables. No storage or provider mocks are used.

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { DEFAULT_SYSTEM_SETTINGS } from '@unimailbox/contracts';
import { hashPassword } from '../../platform/crypto';

const BASE = 'http://localhost/api/v1/admin/settings';

async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('settings.read', 'settings.read', 'Read settings', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('settings.manage', 'settings.manage', 'Manage settings', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'settings.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'settings.manage', datetime('now'))`,
    ),
  ]);
}

async function createUser(
  role: 'administrator' | 'member',
  email = `${role}-${crypto.randomUUID()}@example.com`,
): Promise<string> {
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
  return createToken(await createUser(role));
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

describe('GET /api/v1/admin/settings', () => {
  it('R-SETTINGS-001 R-SETTINGS-002 R-SETTINGS-008 returns typed defaults and runtime metadata only', async () => {
    const token = await setup();
    await env.DB.prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('brevo_api_key', 'secret-value', '2026-09-01 00:00:00')`,
    ).run();

    const response = await SELF.fetch(BASE, { headers: headers(token) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        settings: DEFAULT_SYSTEM_SETTINGS,
        environment: 'local',
        canManage: true,
        updatedAt: '1970-01-01 00:00:00',
      },
    });
    expect(
      JSON.stringify(await (await SELF.fetch(BASE, { headers: headers(token) })).json()),
    ).not.toContain('secret-value');
  });

  it('R-SETTINGS-003 separates read and manage permission checks', async () => {
    const token = await setup('member');
    const readPermission = await env.DB.prepare(
      `SELECT id FROM permissions WHERE key = 'settings.read' LIMIT 1`,
    ).first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES ('member', ?, datetime('now'))`,
    )
      .bind(readPermission?.id)
      .run();

    const read = await SELF.fetch(BASE, { headers: headers(token) });
    expect(read.status).toBe(200);
    expect((await read.json()).data.canManage).toBe(false);

    const update = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify(DEFAULT_SYSTEM_SETTINGS),
      headers: jsonHeaders(token, 'member-settings-update'),
    });
    expect(update.status).toBe(403);
    expect((await update.json()).error.code).toBe('PERMISSION_DENIED');
  });

  it('R-SETTINGS-003 denies anonymous and ordinary members', async () => {
    await setup();
    expect((await SELF.fetch(BASE)).status).toBe(401);
    const memberToken = await setup('member');
    const response = await SELF.fetch(BASE, { headers: headers(memberToken) });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('PERMISSION_DENIED');
  });

  it('R-SETTINGS-002 fails closed on malformed persisted values', async () => {
    const token = await setup();
    await env.DB.prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('inbound_enabled', 'yes', '2026-09-01 00:00:00')`,
    ).run();
    const response = await SELF.fetch(BASE, { headers: headers(token) });
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe('INTERNAL');
  });
});

describe('PATCH /api/v1/admin/settings', () => {
  beforeEach(async () => {
    await setup();
  });

  it('R-SETTINGS-004 R-SETTINGS-005 updates, audits, and replays byte-for-byte', async () => {
    const user = await env.DB.prepare(
      `SELECT id FROM users WHERE email LIKE 'administrator-%' LIMIT 1`,
    ).first<{ id: string }>();
    const token = await createToken(user?.id ?? '');
    const requestBody = JSON.stringify({
      ...DEFAULT_SYSTEM_SETTINGS,
      siteTitle: 'Operations Mail',
      maxMailboxesPerUser: 20,
      auditRetentionDays: 180,
    });
    const request: RequestInit = {
      method: 'PATCH',
      body: requestBody,
      headers: {
        ...jsonHeaders(token, 'settings-update-one'),
        'If-Match': '1970-01-01 00:00:00',
      },
    };

    const first = await SELF.fetch(BASE, request);
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(JSON.parse(firstText).data.settings).toMatchObject({
      siteTitle: 'Operations Mail',
      maxMailboxesPerUser: 20,
      auditRetentionDays: 180,
    });
    const replay = await SELF.fetch(BASE, request);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstText);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'settings.updated'`,
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(`SELECT key, value FROM system_settings ORDER BY key`).all(),
    ).toMatchObject({
      results: expect.arrayContaining([
        { key: 'site_title', value: 'Operations Mail' },
        { key: 'max_mailboxes_per_user', value: '20' },
      ]),
    });
  });

  it('keeps public registration disabled even when a legacy client sends true', async () => {
    const token = await setup();
    const response = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify({ ...DEFAULT_SYSTEM_SETTINGS, registrationEnabled: true }),
      headers: {
        ...jsonHeaders(token, 'settings-registration-closed'),
        'If-Match': '1970-01-01 00:00:00',
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.settings.registrationEnabled).toBe(false);
    expect(
      await env.DB.prepare(
        `SELECT value FROM system_settings WHERE key = 'registration_enabled' LIMIT 1`,
      ).first(),
    ).toEqual({ value: 'false' });
  });

  it('R-SETTINGS-004 rejects a reused key with a different request body', async () => {
    const token = await setup();
    const first = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify(DEFAULT_SYSTEM_SETTINGS),
      headers: {
        ...jsonHeaders(token, 'settings-reused-key'),
        'If-Match': '1970-01-01 00:00:00',
      },
    });
    expect(first.status).toBe(200);
    const conflict = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify({ ...DEFAULT_SYSTEM_SETTINGS, siteTitle: 'Different' }),
      headers: {
        ...jsonHeaders(token, 'settings-reused-key'),
        'If-Match': '1970-01-01 00:00:00',
      },
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('R-SETTINGS-004 replays a same-key concurrent update', async () => {
    const token = await setup();
    const body = JSON.stringify({ ...DEFAULT_SYSTEM_SETTINGS, siteTitle: 'Concurrent' });
    const key = `settings-race-${crypto.randomUUID()}`;
    const request = (): RequestInit => ({
      method: 'PATCH',
      body,
      headers: {
        ...jsonHeaders(token, key),
        'If-Match': '1970-01-01 00:00:00',
      },
    });
    const responses = await Promise.all([SELF.fetch(BASE, request()), SELF.fetch(BASE, request())]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'settings.updated'`,
      ).first(),
    ).toEqual({ count: 1 });
  });

  it('R-SETTINGS-006 rejects unknown fields, bounds, and a missing idempotency key', async () => {
    const token = await setup();
    const unknown = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify({ ...DEFAULT_SYSTEM_SETTINGS, brevoApiKey: 'secret' }),
      headers: jsonHeaders(token, 'settings-unknown'),
    });
    expect(unknown.status).toBe(400);
    const bounds = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify({ ...DEFAULT_SYSTEM_SETTINGS, maxAttachmentBytes: 0 }),
      headers: jsonHeaders(token, 'settings-bounds'),
    });
    expect(bounds.status).toBe(400);
    const missingKey = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify(DEFAULT_SYSTEM_SETTINGS),
      headers: headers(token),
    });
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('R-SETTINGS-005 rolls back settings and idempotency when the audit write fails', async () => {
    const token = await setup();
    await env.DB.prepare(
      `CREATE TRIGGER settings_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'settings audit failure'); END`,
    ).run();
    const response = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify({ ...DEFAULT_SYSTEM_SETTINGS, siteTitle: 'Should Roll Back' }),
      headers: {
        ...jsonHeaders(token, 'settings-atomic-failure'),
        'If-Match': '1970-01-01 00:00:00',
      },
    });
    await env.DB.prepare(`DROP TRIGGER settings_audit_failure`).run();
    expect(response.status).toBe(500);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM system_settings WHERE key <> 'settings_revision'`,
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key = 'settings-atomic-failure'`,
      ).first(),
    ).toEqual({ count: 0 });
  });

  it('R-SETTINGS-009 requires If-Match and rejects a stale concurrent update', async () => {
    const token = await setup();
    const missing = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify(DEFAULT_SYSTEM_SETTINGS),
      headers: jsonHeaders(token, 'settings-missing-if-match'),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('IF_MATCH_REQUIRED');

    const first = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify(DEFAULT_SYSTEM_SETTINGS),
      headers: {
        ...jsonHeaders(token, 'settings-concurrent-first'),
        'If-Match': '1970-01-01 00:00:00',
      },
    });
    expect(first.status).toBe(200);
    const stale = await SELF.fetch(BASE, {
      method: 'PATCH',
      body: JSON.stringify({ ...DEFAULT_SYSTEM_SETTINGS, siteTitle: 'Stale' }),
      headers: {
        ...jsonHeaders(token, 'settings-concurrent-stale'),
        'If-Match': '1970-01-01 00:00:00',
      },
    });
    expect(stale.status).toBe(412);
    expect((await stale.json()).error.code).toBe('STALE_IF_MATCH');
  });
});
