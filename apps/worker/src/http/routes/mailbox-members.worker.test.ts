// CAP-057 mailbox sharing API tests. These use SELF.fetch and real D1/KV so
// authorization, atomic rows, canonical envelopes, and replay behavior are
// exercised through the production route.

import { beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedInstallationState, resetAndMigrate } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';
import { seedRolesAndPermissions } from '../../modules/admin';
import { assertCan } from '../../modules/tenancy';

const BASE = 'http://localhost/api/v1';

async function setup(): Promise<void> {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  await seedRolesAndPermissions(env.DB, new Date().toISOString());
}

async function createUser(
  email: string,
  role: 'administrator' | 'member' = 'member',
  displayName: string | null = 'Test User',
): Promise<string> {
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword('testPassword123');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm,
       password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      email,
      displayName,
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

async function sessionFor(userId: string): Promise<string> {
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

async function mailboxFor(
  ownerUserId: string,
  localPart = `box-${crypto.randomUUID().slice(0, 8)}`,
) {
  const domainId = crypto.randomUUID();
  const mailboxId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, 'example.com', 'active', NULL, ?, ?)`,
    ).bind(domainId, now, now),
    env.DB.prepare(
      `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Test mailbox', 'active', ?, ?)`,
    ).bind(mailboxId, domainId, ownerUserId, localPart, now, now),
  ]);
  return mailboxId;
}

function jsonHeaders(token: string, idempotencyKey?: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

async function addMember(
  token: string,
  mailboxId: string,
  email: string,
  role: 'viewer' | 'sender' | 'admin',
  key = `add-${crypto.randomUUID()}`,
): Promise<Response> {
  return SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members`, {
    method: 'POST',
    headers: jsonHeaders(token, key),
    body: JSON.stringify({ email, role }),
  });
}

describe('CAP-057 mailbox member contracts and lifecycle', () => {
  beforeEach(setup);

  it('R-MAILBOX-003 R-MAILBOX-004 R-AUTHZ-001 R-AUTHZ-003 R-API-001 R-API-004 R-AUDIT-001 lets the owner add/list/remove with one add audit and one removal audit', async () => {
    const ownerId = await createUser('owner@example.com');
    const targetId = await createUser('TARGET@example.com', 'member', 'Target User');
    const ownerToken = await sessionFor(ownerId);
    const mailboxId = await mailboxFor(ownerId);

    const addKey = 'member-add-audit-01';
    const add = await addMember(ownerToken, mailboxId, ' target@example.com ', 'sender', addKey);
    expect(add.status).toBe(201);
    const addRequestId = add.headers.get('X-Request-Id');
    expect(addRequestId).toEqual(expect.any(String));
    const addText = await add.text();
    const addBody = JSON.parse(addText) as { data: Record<string, unknown> };
    expect(addBody.data).toEqual({
      userId: targetId,
      email: 'target@example.com',
      displayName: 'Target User',
      role: 'sender',
      createdAt: expect.any(String),
    });

    const list = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: { items: Record<string, unknown>[] } };
    expect(listBody.data.items).toEqual([addBody.data]);
    expect(Object.keys(listBody.data.items[0] ?? {}).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'role',
      'userId',
    ]);
    expect(JSON.stringify(listBody)).not.toContain('password');

    const addAudit = await env.DB.prepare(
      `SELECT action, actor_user_id, resource_type, resource_id, request_id, metadata
       FROM audit_events WHERE action = 'mailbox.member_added'`,
    ).all();
    expect(addAudit.results).toHaveLength(1);
    expect(addAudit.results[0]).toMatchObject({
      action: 'mailbox.member_added',
      actor_user_id: ownerId,
      resource_type: 'mailbox',
      resource_id: mailboxId,
      request_id: addRequestId,
      metadata: JSON.stringify({ memberUserId: targetId, role: 'sender' }),
    });
    expect(JSON.stringify(addAudit.results)).not.toContain(addKey);
    expect(JSON.stringify(addAudit.results)).not.toContain('testPassword123');

    const remove = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members/${targetId}`, {
      method: 'DELETE',
      headers: jsonHeaders(ownerToken, 'remove-member-01'),
    });
    expect(remove.status).toBe(200);
    const removeRequestId = remove.headers.get('X-Request-Id');
    expect(removeRequestId).toEqual(expect.any(String));
    const removeText = await remove.text();
    expect(JSON.parse(removeText)).toEqual({ data: { removed: true, userId: targetId } });

    const removeReplay = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members/${targetId}`, {
      method: 'DELETE',
      headers: jsonHeaders(ownerToken, 'remove-member-01'),
    });
    expect(removeReplay.status).toBe(200);
    expect(await removeReplay.text()).toBe(removeText);

    const emptyList = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(emptyList.status).toBe(200);
    expect(await emptyList.json()).toEqual({ data: { items: [] } });

    const missing = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members/${targetId}`, {
      method: 'DELETE',
      headers: jsonHeaders(ownerToken, 'remove-member-02'),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('MAILBOX_MEMBER_NOT_FOUND');
    const removeAudits = await env.DB.prepare(
      `SELECT action, actor_user_id, resource_type, resource_id, request_id, metadata
       FROM audit_events WHERE action = 'mailbox.member_removed'`,
    ).all();
    expect(removeAudits.results).toHaveLength(1);
    expect(removeAudits.results[0]).toMatchObject({
      action: 'mailbox.member_removed',
      actor_user_id: ownerId,
      resource_type: 'mailbox',
      resource_id: mailboxId,
      request_id: removeRequestId,
      metadata: JSON.stringify({ memberUserId: targetId, role: 'sender' }),
    });
    expect(JSON.stringify(removeAudits.results)).not.toContain('remove-member-01');
    expect(JSON.stringify(removeAudits.results)).not.toContain('testPassword123');
  });

  it('R-AUTHZ-001 R-AUTHZ-003 R-AUTHZ-004 R-MAILBOX-005 R-MAILBOX-006 R-MAILBOX-007 R-DATA-004 R-API-002 denies mailbox-admin role without mailbox.share but permits global share', async () => {
    const ownerId = await createUser('owner@example.com');
    const memberAdminId = await createUser('member-admin@example.com');
    const globalId = await createUser('global@example.com', 'administrator');
    await createUser('target@example.com');
    const mailboxId = await mailboxFor(ownerId);
    const memberAdminToken = await sessionFor(memberAdminId);
    const globalToken = await sessionFor(globalId);

    await env.DB.prepare(
      `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
       VALUES (?, ?, 'admin', datetime('now'))`,
    )
      .bind(mailboxId, memberAdminId)
      .run();

    const denied = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members`, {
      headers: { Authorization: `Bearer ${memberAdminToken}` },
    });
    expect(denied.status).toBe(404);
    expect((await denied.json()).error.code).toBe('MAILBOX_NOT_FOUND');

    const allowed = await addMember(globalToken, mailboxId, 'target@example.com', 'viewer');
    expect(allowed.status).toBe(201);
  });

  it('R-DATA-001 R-API-003 R-API-006 R-AUDIT-004 rejects unknown/self/duplicate/invalid without side effects', async () => {
    const ownerId = await createUser('owner@example.com');
    await createUser('target@example.com');
    const ownerToken = await sessionFor(ownerId);
    const mailboxId = await mailboxFor(ownerId);

    const unknown = await addMember(ownerToken, mailboxId, 'missing@example.com', 'viewer');
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe('MAILBOX_MEMBER_USER_NOT_FOUND');

    const self = await addMember(ownerToken, mailboxId, 'owner@example.com', 'viewer');
    expect(self.status).toBe(409);
    expect((await self.json()).error.code).toBe('MAILBOX_OWNER_CANNOT_BE_MEMBER');

    const first = await addMember(ownerToken, mailboxId, 'target@example.com', 'viewer');
    expect(first.status).toBe(201);
    const duplicate = await addMember(ownerToken, mailboxId, 'TARGET@example.com', 'admin');
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('MAILBOX_MEMBER_DUPLICATE');

    const invalid = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members`, {
      method: 'POST',
      headers: jsonHeaders(ownerToken, 'invalid-role-01'),
      body: JSON.stringify({ email: 'target@example.com', role: 'owner', extra: 'rejected' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe('VALIDATION_ERROR');
    const invalidIdempotency = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM idempotency_records
       WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
    )
      .bind(ownerId, `POST /api/v1/mailboxes/${mailboxId}/members`, 'invalid-role-01')
      .first<{ count: number }>();
    expect(invalidIdempotency?.count).toBe(0);

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM mailbox_members WHERE mailbox_id = ?) AS members,
         (SELECT COUNT(*) FROM audit_events WHERE action = 'mailbox.member_added') AS audits`,
    )
      .bind(mailboxId)
      .first<{ members: number; audits: number }>();
    expect(counts).toEqual({ members: 1, audits: 1 });
  });

  it('R-API-004 R-API-006 R-AUDIT-001 replays the exact POST response and rejects same-key body changes', async () => {
    const ownerId = await createUser('owner@example.com');
    await createUser('target@example.com');
    const ownerToken = await sessionFor(ownerId);
    const mailboxId = await mailboxFor(ownerId);
    const key = 'replay-member-01';

    const first = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members`, {
      method: 'POST',
      headers: jsonHeaders(ownerToken, key),
      body: JSON.stringify({ email: 'target@example.com', role: 'viewer' }),
    });
    const firstText = await first.text();
    const replay = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members`, {
      method: 'POST',
      headers: jsonHeaders(ownerToken, key),
      body: ' { "role": "viewer", "email": " TARGET@EXAMPLE.COM " } ',
    });
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);

    const conflict = await addMember(ownerToken, mailboxId, 'target@example.com', 'sender', key);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM mailbox_members WHERE mailbox_id = ?`,
    )
      .bind(mailboxId)
      .first<{ count: number }>();
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'mailbox.member_added'`,
    ).first<{ count: number }>();
    expect(rows?.count).toBe(1);
    expect(audits?.count).toBe(1);
  });

  it('R-API-004 R-AUDIT-001 handles concurrent same-key adds as one committed transition', async () => {
    const ownerId = await createUser('owner@example.com');
    await createUser('target@example.com');
    const ownerToken = await sessionFor(ownerId);
    const mailboxId = await mailboxFor(ownerId);
    const key = 'concurrent-member-01';

    const responses = await Promise.all([
      addMember(ownerToken, mailboxId, 'target@example.com', 'viewer', key),
      addMember(ownerToken, mailboxId, 'target@example.com', 'viewer', key),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 201]);
    const responseTexts = await Promise.all(responses.map((response) => response.text()));
    expect(responseTexts[0]).toBe(responseTexts[1]);

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM mailbox_members WHERE mailbox_id = ?) AS members,
         (SELECT COUNT(*) FROM audit_events WHERE action = 'mailbox.member_added') AS audits`,
    )
      .bind(mailboxId)
      .first<{ members: number; audits: number }>();
    expect(counts).toEqual({ members: 1, audits: 1 });
  });

  it('R-AUDIT-001 R-API-004 emits one removal audit when different-key deletes race', async () => {
    const ownerId = await createUser('owner@example.com');
    const targetId = await createUser('target@example.com');
    const ownerToken = await sessionFor(ownerId);
    const mailboxId = await mailboxFor(ownerId);
    const added = await addMember(ownerToken, mailboxId, 'target@example.com', 'viewer');
    expect(added.status).toBe(201);

    const responses = await Promise.all(
      ['delete-race-01', 'delete-race-02'].map((key) =>
        SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members/${targetId}`, {
          method: 'DELETE',
          headers: jsonHeaders(ownerToken, key),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'mailbox.member_removed'`,
    ).first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  it('R-API-004 R-AUDIT-001 replays concurrent same-key deletes after the member preflight loses', async () => {
    const ownerId = await createUser('owner@example.com');
    const targetId = await createUser('target@example.com');
    const ownerToken = await sessionFor(ownerId);
    const mailboxId = await mailboxFor(ownerId);
    const added = await addMember(ownerToken, mailboxId, 'target@example.com', 'viewer');
    expect(added.status).toBe(201);

    const key = 'delete-same-key-01';
    const responses = await Promise.all(
      [1, 2].map(() =>
        SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members/${targetId}`, {
          method: 'DELETE',
          headers: jsonHeaders(ownerToken, key),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
    const responseTexts = await Promise.all(responses.map((response) => response.text()));
    expect(responseTexts[0]).toBe(responseTexts[1]);
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'mailbox.member_removed'`,
    ).first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  it('R-MAILBOX-005 R-MAILBOX-006 R-MAILBOX-007 persists viewer/sender/admin role semantics for mailbox authorization', async () => {
    const ownerId = await createUser('owner@example.com');
    const viewerId = await createUser('viewer@example.com');
    const senderId = await createUser('sender@example.com');
    const adminId = await createUser('admin@example.com');
    const ownerToken = await sessionFor(ownerId);
    const mailboxId = await mailboxFor(ownerId);

    expect((await addMember(ownerToken, mailboxId, 'viewer@example.com', 'viewer')).status).toBe(
      201,
    );
    expect((await addMember(ownerToken, mailboxId, 'sender@example.com', 'sender')).status).toBe(
      201,
    );
    expect((await addMember(ownerToken, mailboxId, 'admin@example.com', 'admin')).status).toBe(201);

    await expect(assertCan(env.DB, viewerId, mailboxId, 'read')).resolves.toBeUndefined();
    await expect(assertCan(env.DB, viewerId, mailboxId, 'send')).rejects.toMatchObject({
      code: 'MAILBOX_ACCESS_DENIED',
    });
    await expect(assertCan(env.DB, senderId, mailboxId, 'read')).resolves.toBeUndefined();
    await expect(assertCan(env.DB, senderId, mailboxId, 'send')).resolves.toBeUndefined();
    await expect(assertCan(env.DB, senderId, mailboxId, 'manage_members')).rejects.toMatchObject({
      code: 'MAILBOX_ACCESS_DENIED',
    });
    await expect(assertCan(env.DB, adminId, mailboxId, 'read')).resolves.toBeUndefined();
    await expect(assertCan(env.DB, adminId, mailboxId, 'send')).resolves.toBeUndefined();
    await expect(assertCan(env.DB, adminId, mailboxId, 'manage_members')).resolves.toBeUndefined();
  });

  it('R-AUTHZ-003 R-AUTHZ-004 R-API-002 protects foreign/missing mailboxes and owner deletion paths', async () => {
    const ownerId = await createUser('owner@example.com');
    const otherId = await createUser('other@example.com');
    const ownerToken = await sessionFor(ownerId);
    const otherToken = await sessionFor(otherId);
    const mailboxId = await mailboxFor(ownerId);
    const missingMailboxId = crypto.randomUUID();

    const foreign = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.code).toBe('MAILBOX_NOT_FOUND');

    const missing = await SELF.fetch(`${BASE}/mailboxes/${missingMailboxId}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('MAILBOX_NOT_FOUND');

    const ownerDelete = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members/${ownerId}`, {
      method: 'DELETE',
      headers: jsonHeaders(ownerToken, 'owner-delete-01'),
    });
    expect(ownerDelete.status).toBe(404);
    expect((await ownerDelete.json()).error.code).toBe('MAILBOX_MEMBER_NOT_FOUND');
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'mailbox.member_removed'`,
    ).first<{ count: number }>();
    expect(audits?.count).toBe(0);
  });

  it('R-API-004 R-DATA-001 returns multiple members in stable createdAt/userId order', async () => {
    const ownerId = await createUser('owner@example.com');
    const firstId = await createUser('first@example.com', 'member', 'First');
    const secondId = await createUser('second@example.com', 'member', 'Second');
    const thirdId = await createUser('third@example.com', 'member', 'Third');
    const ownerToken = await sessionFor(ownerId);
    const mailboxId = await mailboxFor(ownerId);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)`,
      ).bind(mailboxId, firstId, '2026-08-30 00:00:02'),
      env.DB.prepare(
        `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, 'sender', ?)`,
      ).bind(mailboxId, secondId, '2026-08-30 00:00:01'),
      env.DB.prepare(
        `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
      ).bind(mailboxId, thirdId, '2026-08-30 00:00:03'),
    ]);

    const response = await SELF.fetch(`${BASE}/mailboxes/${mailboxId}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { items: { userId: string }[] } };
    expect(body.data.items.map((item) => item.userId)).toEqual([secondId, firstId, thirdId]);
  });
});
