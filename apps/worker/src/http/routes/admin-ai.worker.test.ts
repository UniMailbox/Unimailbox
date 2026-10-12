// CAP-069 — general settings administration Worker-pool tests.
// The route is exercised through real auth, D1, permissions, idempotency,
// and audit tables. No storage or provider mocks are used.

import { describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { DEFAULT_AI_CONFIGURATION } from '@unimailbox/contracts';
import { hashPassword } from '../../platform/crypto';

const BASE = 'http://localhost/api/v1/admin/ai';

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

const configuration = {
  ...DEFAULT_AI_CONFIGURATION,
  protocol: 'openai' as const,
  model: 'test-model',
  enabled: true,
};
async function put(
  token: string,
  body: unknown,
  revision = '0',
  key = crypto.randomUUID(),
): Promise<Response> {
  return SELF.fetch(BASE, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { ...jsonHeaders(token, key), 'If-Match': revision },
  });
}
describe('AI configuration administration', () => {
  it('returns safe disabled defaults and enforces permissions', async () => {
    const token = await setup();
    const response = await SELF.fetch(BASE, { headers: headers(token) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        configuration: DEFAULT_AI_CONFIGURATION,
        revision: 0,
        hasApiKey: false,
        canManage: true,
        workersAiAvailable: false,
      },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await SELF.fetch(BASE)).status).toBe(401);
    const member = await setup('member');
    expect((await SELF.fetch(BASE, { headers: headers(member) })).status).toBe(403);
    expect((await put(member, { configuration, apiKey: 'private-key' })).status).toBe(403);
  });
  it('encrypts, replays, audits and retains a key on model changes', async () => {
    const token = await setup();
    const body = { configuration, apiKey: 'private-key' };
    const key = crypto.randomUUID();
    const response = await put(token, body, '0', key);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('private-key');
    expect(JSON.parse(text).data).toMatchObject({ hasApiKey: true, revision: 1 });
    expect(await (await put(token, body, '0', key)).text()).toBe(text);
    const row = await env.DB.prepare(
      "SELECT configuration, ciphertext, iv, auth_tag FROM ai_configuration WHERE id='system'",
    ).first<{
      configuration: string;
      ciphertext: ArrayBuffer;
      iv: ArrayBuffer;
      auth_tag: ArrayBuffer;
    }>();
    expect(row?.configuration).not.toContain('private-key');
    expect(
      new TextDecoder().decode(new Uint8Array(row?.ciphertext ?? new ArrayBuffer(0))),
    ).not.toContain('private-key');
    const { decrypt, importEncryptionKey } = await import('../../platform/crypto');
    expect(
      await decrypt(
        {
          ciphertext: new Uint8Array(row?.ciphertext ?? new ArrayBuffer(0)),
          iv: new Uint8Array(row?.iv ?? new ArrayBuffer(0)),
          authTag: new Uint8Array(row?.auth_tag ?? new ArrayBuffer(0)),
        },
        await importEncryptionKey('a'.repeat(64)),
      ),
    ).toBe('private-key');
    const audit = await env.DB.prepare(
      "SELECT metadata FROM audit_events WHERE action='ai.configuration_updated'",
    ).all();
    expect(audit.results).toHaveLength(1);
    expect(JSON.stringify(audit.results)).not.toContain('private-key');
    expect(
      (await put(token, { configuration: { ...configuration, model: 'other-model' } }, '1')).status,
    ).toBe(200);
    expect(
      (await (await SELF.fetch(BASE, { headers: headers(token) })).json()).data.hasApiKey,
    ).toBe(true);
  });
  it('rejects stale writes and different bodies with a reused key', async () => {
    const token = await setup();
    const key = crypto.randomUUID();
    expect((await put(token, { configuration, apiKey: 'key' }, '0', key)).status).toBe(200);
    expect(
      (
        await put(
          token,
          { configuration: { ...configuration, model: 'other' }, apiKey: 'key' },
          '0',
          key,
        )
      ).status,
    ).toBe(409);
    expect((await put(token, { configuration, apiKey: 'key' })).status).toBe(412);
  });
  it('handles concurrent same-key and different-key writes atomically', async () => {
    const token = await setup();
    const key = crypto.randomUUID();
    const body = { configuration, apiKey: 'key' };
    const same = await Promise.all([put(token, body, '0', key), put(token, body, '0', key)]);
    expect(same.map((r) => r.status)).toEqual([200, 200]);
    expect(await same[0]?.text()).toBe(await same[1]?.text());
    const different = await Promise.all([put(token, body, '1'), put(token, body, '1')]);
    expect(different.map((r) => r.status).sort()).toEqual([200, 412]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action='ai.configuration_updated'",
      ).first(),
    ).toEqual({ count: 2 });
  });
  it('requires fresh keys when switching endpoint or protocol and supports removal', async () => {
    const token = await setup();
    await put(token, { configuration, apiKey: 'key' });
    const changed = { ...configuration, baseUrl: 'https://other.example.com/v1' };
    expect((await put(token, { configuration: changed }, '1')).status).toBe(400);
    expect(
      (await put(token, { configuration: { ...configuration, protocol: 'anthropic' } }, '1'))
        .status,
    ).toBe(400);
    expect((await put(token, { configuration: changed, apiKey: 'new-key' }, '1')).status).toBe(200);
    expect(
      (await put(token, { configuration: { ...changed, enabled: false }, apiKey: null }, '2'))
        .status,
    ).toBe(200);
    expect(
      (await (await SELF.fetch(BASE, { headers: headers(token) })).json()).data.hasApiKey,
    ).toBe(false);
  });
  it('checks binding availability, key presence, revisions, input and idempotency', async () => {
    const token = await setup();
    expect(
      (
        await put(token, {
          configuration: { ...DEFAULT_AI_CONFIGURATION, enabled: true, model: '@cf/model' },
        })
      ).status,
    ).toBe(400);
    expect((await put(token, { configuration })).status).toBe(400);
    expect((await put(token, { configuration, apiKey: 'key' }, 'invalid')).status).toBe(400);
    expect(
      (
        await put(token, {
          configuration: { ...configuration, baseUrl: 'http://example.com' },
          apiKey: 'key',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await SELF.fetch(BASE, {
          method: 'PUT',
          body: JSON.stringify({ configuration }),
          headers: headers(token),
        })
      ).status,
    ).toBe(400);
  });
  it('rolls back credentials, revision and replay records if auditing fails', async () => {
    const token = await setup();
    await env.DB.prepare(
      "CREATE TRIGGER ai_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit failure'); END",
    ).run();
    const response = await put(token, { configuration, apiKey: 'key' });
    await env.DB.prepare('DROP TRIGGER ai_audit_failure').run();
    expect(response.status).toBe(500);
    expect(
      await env.DB.prepare(
        "SELECT revision, ciphertext FROM ai_configuration WHERE id='system'",
      ).first(),
    ).toEqual({ revision: 0, ciphertext: null });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_records WHERE operation='PUT /api/v1/admin/ai'",
      ).first(),
    ).toEqual({ count: 0 });
  });
});
