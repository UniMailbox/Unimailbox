// CAP-067 — role administration Worker-pool tests.
// These use real D1 and the real auth/permission middleware. No database or
// provider mocks are used.

import { describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';
import { assignRole, seedRolesAndPermissions } from '../../modules/admin';

const BASE = 'http://localhost/api/v1/admin/roles';

async function createUser(roleId: 'administrator' | 'member', email: string): Promise<string> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('testPassword123');
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, status, password_algorithm,
      password_iterations, password_salt, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      email,
      roleId,
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    )
    .run();
  await assignRole(env.DB, userId, roleId, now);
  return userId;
}

async function createToken(userId: string): Promise<string> {
  const token = crypto.randomUUID();
  await env.CACHE.put(`auth:${token}`, JSON.stringify({ userId }), { expirationTtl: 900 });
  return token;
}

async function setup(): Promise<{ adminToken: string; memberToken: string }> {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  await seedRolesAndPermissions(env.DB, '2026-08-31 00:00:00');
  const adminId = await createUser('administrator', `admin-${crypto.randomUUID()}@example.com`);
  const memberId = await createUser('member', `member-${crypto.randomUUID()}@example.com`);
  return { adminToken: await createToken(adminId), memberToken: await createToken(memberId) };
}

function headers(token: string, key?: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    ...(key === undefined ? {} : { 'Idempotency-Key': key }),
  };
}

describe('GET /api/v1/admin/roles', () => {
  it('returns system roles and the closed permission catalog', async () => {
    const { adminToken } = await setup();
    const response = await SELF.fetch(BASE, { headers: headers(adminToken) });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.roles).toHaveLength(2);
    expect(body.data.roles.map((role: { id: string }) => role.id)).toEqual([
      'administrator',
      'member',
    ]);
    expect(body.data.permissions).toHaveLength(21);
    expect(body.data.roles[0]).not.toHaveProperty('userIds');
  });

  it('returns 401 anonymously and 403 to a member', async () => {
    const { memberToken } = await setup();
    const anonymous = await SELF.fetch(BASE);
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe('AUTHENTICATION_REQUIRED');

    const member = await SELF.fetch(BASE, { headers: headers(memberToken) });
    expect(member.status).toBe(403);
    expect((await member.json()).error.code).toBe('PERMISSION_DENIED');
  });
});

describe('POST /api/v1/admin/roles', () => {
  it('creates a custom role, grants permissions, audits, and replays', async () => {
    const { adminToken } = await setup();
    const key = `role-create-${crypto.randomUUID()}`;
    const request = (): RequestInit => ({
      method: 'POST',
      body: JSON.stringify({
        name: '  Support agent ',
        description: ' Read and send mail ',
        permissionKeys: ['message.read', 'message.send'],
      }),
      headers: { ...headers(adminToken, key), 'Content-Type': 'application/json' },
    });

    const first = await SELF.fetch(BASE, request());
    expect(first.status).toBe(201);
    const firstText = await first.text();
    expect(JSON.parse(firstText).data).toMatchObject({
      name: 'Support agent',
      description: 'Read and send mail',
      isSystem: false,
      permissionKeys: ['message.read', 'message.send'],
    });

    const replay = await SELF.fetch(BASE, request());
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'role.created'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('rejects duplicate names, unknown fields, and key reuse with a different body', async () => {
    const { adminToken } = await setup();
    const first = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ name: 'Support', description: 'One', permissionKeys: [] }),
      headers: { ...headers(adminToken, 'role-first-key'), 'Content-Type': 'application/json' },
    });
    expect(first.status).toBe(201);

    const duplicate = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ name: ' support ', description: 'Two', permissionKeys: [] }),
      headers: { ...headers(adminToken, 'role-duplicate-key'), 'Content-Type': 'application/json' },
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('ROLE_NAME_TAKEN');
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'role.created'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });

    const unknownField = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Other',
        description: 'Other',
        permissionKeys: [],
        isSystem: true,
      }),
      headers: { ...headers(adminToken, 'role-unknown-field'), 'Content-Type': 'application/json' },
    });
    expect(unknownField.status).toBe(400);
    expect((await unknownField.json()).error.code).toBe('VALIDATION_ERROR');

    const reuseKey = 'role-reuse-key';
    const reuseHeaders = { ...headers(adminToken, reuseKey), 'Content-Type': 'application/json' };
    expect(
      (
        await SELF.fetch(BASE, {
          method: 'POST',
          body: JSON.stringify({ name: 'Third', description: 'Third', permissionKeys: [] }),
          headers: reuseHeaders,
        })
      ).status,
    ).toBe(201);
    const reused = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ name: 'Fourth', description: 'Fourth', permissionKeys: [] }),
      headers: reuseHeaders,
    });
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('PATCH and DELETE /api/v1/admin/roles/:id', () => {
  it('replaces custom permissions atomically and audits the update', async () => {
    const { adminToken } = await setup();
    const create = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Editor',
        description: 'Initial',
        permissionKeys: ['message.read'],
      }),
      headers: { ...headers(adminToken, 'role-create-editor'), 'Content-Type': 'application/json' },
    });
    const roleId = (await create.json()).data.id as string;

    const response = await SELF.fetch(`${BASE}/${roleId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'Editor v2',
        description: 'Updated',
        permissionKeys: ['message.send', 'audit.read'],
      }),
      headers: { ...headers(adminToken, 'role-update-editor'), 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      id: roleId,
      name: 'Editor v2',
      permissionKeys: ['audit.read', 'message.send'],
    });
    const mappings = await env.DB.prepare(
      'SELECT permission_id FROM role_permissions WHERE role_id = ? ORDER BY permission_id',
    )
      .bind(roleId)
      .all<{ permission_id: string }>();
    expect(mappings.results).toEqual([
      { permission_id: 'audit.read' },
      { permission_id: 'message.send' },
    ]);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'role.updated'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('protects system roles and assigned custom roles, then deletes an unused role', async () => {
    const { adminToken } = await setup();
    const protectedSystem = await SELF.fetch(`${BASE}/administrator`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'admin', description: 'changed', permissionKeys: [] }),
      headers: { ...headers(adminToken, 'role-system-update'), 'Content-Type': 'application/json' },
    });
    expect(protectedSystem.status).toBe(409);
    expect((await protectedSystem.json()).error.code).toBe('SYSTEM_ROLE_PROTECTED');

    const protectedSystemDelete = await SELF.fetch(`${BASE}/administrator`, {
      method: 'DELETE',
      headers: headers(adminToken, 'role-system-delete'),
    });
    expect(protectedSystemDelete.status).toBe(409);
    expect((await protectedSystemDelete.json()).error.code).toBe('SYSTEM_ROLE_PROTECTED');

    const create = await SELF.fetch(BASE, {
      method: 'POST',
      body: JSON.stringify({ name: 'Temporary', description: 'Temporary', permissionKeys: [] }),
      headers: {
        ...headers(adminToken, 'role-create-temporary'),
        'Content-Type': 'application/json',
      },
    });
    const roleId = (await create.json()).data.id as string;
    const userId = await createUser('member', `assigned-${crypto.randomUUID()}@example.com`);
    await env.DB.prepare('INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)')
      .bind(userId, roleId, new Date().toISOString())
      .run();

    const assigned = await SELF.fetch(`${BASE}/${roleId}`, {
      method: 'DELETE',
      headers: headers(adminToken, 'role-delete-assigned'),
    });
    expect(assigned.status).toBe(409);
    expect((await assigned.json()).error.code).toBe('ROLE_IN_USE');

    await env.DB.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?')
      .bind(userId, roleId)
      .run();
    const deleted = await SELF.fetch(`${BASE}/${roleId}`, {
      method: 'DELETE',
      headers: headers(adminToken, 'role-delete-unused'),
    });
    expect(deleted.status).toBe(200);
    const deletedText = await deleted.text();
    expect(JSON.parse(deletedText)).toEqual({ data: { id: roleId, deleted: true } });
    const deleteReplay = await SELF.fetch(`${BASE}/${roleId}`, {
      method: 'DELETE',
      headers: headers(adminToken, 'role-delete-unused'),
    });
    expect(deleteReplay.status).toBe(200);
    expect(await deleteReplay.text()).toBe(deletedText);
    expect(
      await env.DB.prepare('SELECT id FROM roles WHERE id = ?').bind(roleId).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'role.deleted'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('returns a stable not-found error for missing custom roles', async () => {
    const { adminToken } = await setup();
    const missingRoleId = '00000000-0000-4000-8000-000000000099';
    const update = await SELF.fetch(`${BASE}/${missingRoleId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Missing', description: 'Missing', permissionKeys: [] }),
      headers: {
        ...headers(adminToken, 'role-update-missing'),
        'Content-Type': 'application/json',
      },
    });
    expect(update.status).toBe(404);
    expect((await update.json()).error.code).toBe('ROLE_NOT_FOUND');

    const deletion = await SELF.fetch(`${BASE}/${missingRoleId}`, {
      method: 'DELETE',
      headers: headers(adminToken, 'role-delete-missing'),
    });
    expect(deletion.status).toBe(404);
    expect((await deletion.json()).error.code).toBe('ROLE_NOT_FOUND');
  });
});
