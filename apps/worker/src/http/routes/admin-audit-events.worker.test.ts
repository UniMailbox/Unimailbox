// admin-audit-events.worker.test.ts — CAP-044 Slice 2 (AC 11; CAP-033
// absorbed, D-CAP-044-E). Worker-pool tests for
// GET /api/v1/admin/audit-events. Uses SELF.fetch to exercise the full
// request pipeline against real D1 (no D1 mocking, per testing rules).
//
// Covers:
// - 401 anonymous / 403 member (no audit.read) / 200 administrator
//   (D-CAP-044-D: audit.read is admin-only)
// - Filters: actorUserId, resource pair, action, and combinations
// - Cursor walk across a page edge (limit=2 over 5 rows; disjoint pages,
//   null cursor at the end) — R-API-005
// - Empty result → items: [], nextCursor: null
// - resourceType without resourceId → 400 (the schema's pair rule)
// - Tampered cursor → 400 INVALID_CURSOR (R-API-005)
// - Every response row matches auditEventSchema from contracts
// - R-AUDIT-003: metadata is returned as stored (opaque JSON text)
//
// Slice 2 fix pass additions:
// - (b) a stored row with an out-of-enum action → 500 AUDIT_ROW_INVALID
//   (server-side detection point; never a 200 the client dies parsing)
// - (c) repository contract: a half-set resource pair throws
//   AuditFilterPairError (unreachable via the validated route)
// - (d) a cursor minted for the 'messages' surface is rejected here
// - (g) the (created_at = ? AND id < ?) tie-breaker arm across a page
//   edge, and the exact-limit tail (a full final page still emits a
//   cursor; the next page is empty with nextCursor null)

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';
import { signCursor } from '../../platform/cursor';
import { createAuditEvent, queryAuditEvents, AuditFilterPairError } from '../../modules/admin';
import { auditEventSchema, type AuditAction } from '@unimailbox/contracts';

// ---------------------------------------------------------------------------
// Seeding helpers (modelled on messages.worker.test.ts).
// ---------------------------------------------------------------------------

// Seed installation + the audit.read permission (D-CAP-044-D). The
// administrator role gets it; the member role does NOT.
async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('audit.read', 'audit.read', 'Read audit events', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'audit.read', datetime('now'))`,
    ),
  ]);
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

async function hashToken(token: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function createSession(userId: string): Promise<string> {
  const accessToken = crypto.randomUUID();
  const refreshTokenHash = await hashToken(crypto.randomUUID());
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, refreshTokenHash, expiresAt, new Date().toISOString())
    .run();

  await env.CACHE.put(`auth:${accessToken}`, JSON.stringify({ userId }), {
    expirationTtl: 15 * 60,
  });

  return accessToken;
}

/** Deterministic uuid-shaped ids so ordering assertions stay readable. */
function auditId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * The worker-pool test provides CURSOR_SIGNING_KEY as a plain string var
 * (wrangler.test.jsonc); the Secrets Store form only exists in production.
 * Fix (d) tests mint cross-surface cursors with the REAL key so the only
 * failing check can be the surface discriminator.
 */
function cursorSigningKey(): string {
  const key = env.CURSOR_SIGNING_KEY;
  if (typeof key !== 'string') {
    throw new Error('worker-pool test expects CURSOR_SIGNING_KEY as a plain string var');
  }
  return key;
}

interface SeedRow {
  n: number;
  actorUserId: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId: string | null;
  metadata?: string;
}

/** Seeds one audit row at a deterministic created_at (row n → 00:00:0n). */
async function seedAuditRow(row: SeedRow): Promise<void> {
  const seconds = String(row.n).padStart(2, '0');
  await createAuditEvent(env.DB, {
    id: auditId(row.n),
    actorUserId: row.actorUserId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    requestId: `req-${row.n}`,
    metadata: row.metadata ?? JSON.stringify({ seeded: row.n }),
    createdAt: `2026-01-01 00:00:${seconds}`,
  });
}

const BASE = 'http://localhost/api/v1/admin/audit-events';

// ---------------------------------------------------------------------------
// Authorization (R-AUTHZ-001/002, D-CAP-044-D)
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/audit-events — authorization', () => {
  it('returns 401 when unauthenticated', async () => {
    await resetAndMigrate();
    await completeSetup();

    const response = await SELF.fetch(BASE);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for a member (member role has no audit.read)', async () => {
    await resetAndMigrate();
    await completeSetup();
    const memberId = await createUserWithRole('member', 'member@example.com');
    const memberToken = await createSession(memberId);

    const response = await SELF.fetch(BASE, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  it('returns 200 for an administrator and every row matches auditEventSchema', async () => {
    await resetAndMigrate();
    await completeSetup();
    const adminId = await createUserWithRole('administrator', 'admin@example.com');
    const adminToken = await createSession(adminId);
    await seedAuditRow({
      n: 1,
      actorUserId: adminId,
      action: 'message.send',
      resourceType: 'message',
      resourceId: 'message-1',
    });

    const response = await SELF.fetch(BASE, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.nextCursor).toBeNull();

    // AC 11: every row in the response parses against the contracts schema.
    for (const item of body.data.items) {
      const parsed = auditEventSchema.safeParse(item);
      expect(parsed.success, JSON.stringify(item)).toBe(true);
    }
    expect(body.data.items[0]).toMatchObject({
      id: auditId(1),
      actorUserId: adminId,
      action: 'message.send',
      resourceType: 'message',
      resourceId: 'message-1',
      requestId: 'req-1',
    });
    // R-AUDIT-003: metadata comes back as the STORED JSON text — opaque,
    // exactly the string that was written.
    expect(body.data.items[0].metadata).toBe(JSON.stringify({ seeded: 1 }));
  });
});

// ---------------------------------------------------------------------------
// Filters (composable; the resource pair rule)
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/audit-events — filters', () => {
  let adminToken: string;
  let adminId: string;
  let otherActorId: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    adminId = await createUserWithRole('administrator', 'admin@example.com');
    adminToken = await createSession(adminId);
    otherActorId = await createUserWithRole('member', 'actor2@example.com');

    await seedAuditRow({
      n: 1,
      actorUserId: adminId,
      action: 'message.send',
      resourceType: 'message',
      resourceId: 'message-a',
    });
    await seedAuditRow({
      n: 2,
      actorUserId: otherActorId,
      action: 'message.receive',
      resourceType: 'message',
      resourceId: 'message-a',
    });
    await seedAuditRow({
      n: 3,
      actorUserId: adminId,
      action: 'mailbox.create',
      resourceType: 'mailbox',
      resourceId: 'mailbox-b',
    });
    await seedAuditRow({
      n: 4,
      actorUserId: null,
      action: 'setup.claim',
      resourceType: 'system',
      resourceId: null,
    });
  });

  it('filters by actorUserId', async () => {
    const response = await SELF.fetch(`${BASE}?actorUserId=${otherActorId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].actorUserId).toBe(otherActorId);
    expect(body.data.items[0].id).toBe(auditId(2));
  });

  it('filters by the resourceType + resourceId pair', async () => {
    const response = await SELF.fetch(`${BASE}?resourceType=message&resourceId=message-a`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items.map((i: { id: string }) => i.id)).toEqual([auditId(2), auditId(1)]);
  });

  it('combines actorUserId + resource pair', async () => {
    const response = await SELF.fetch(
      `${BASE}?actorUserId=${adminId}&resourceType=message&resourceId=message-a`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe(auditId(1));
  });

  it('filters by action', async () => {
    const response = await SELF.fetch(`${BASE}?action=mailbox.create`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe(auditId(3));
  });

  it('returns an empty page for a filter matching nothing', async () => {
    const response = await SELF.fetch(`${BASE}?resourceType=message&resourceId=no-such-message`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.nextCursor).toBeNull();
  });

  it('rejects resourceType without resourceId with 400 VALIDATION_ERROR (pair rule)', async () => {
    const response = await SELF.fetch(`${BASE}?resourceType=message`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects resourceId without resourceType with 400 VALIDATION_ERROR (pair rule)', async () => {
    const response = await SELF.fetch(`${BASE}?resourceId=message-a`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-uuid actorUserId with 400 VALIDATION_ERROR', async () => {
    const response = await SELF.fetch(`${BASE}?actorUserId=not-a-uuid`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Cursor pagination (R-API-005 — signed cursor, newest-first walk)
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/audit-events — cursor pagination', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const adminId = await createUserWithRole('administrator', 'admin@example.com');
    adminToken = await createSession(adminId);

    for (let n = 1; n <= 5; n += 1) {
      await seedAuditRow({
        n,
        actorUserId: adminId,
        action: 'message.send',
        resourceType: 'message',
        resourceId: `message-${n}`,
      });
    }
  });

  it('walks the full trail across page edges with disjoint pages and a null terminal cursor', async () => {
    // Page 1: rows 5,4 (newest first) + a cursor.
    const page1 = await (
      await SELF.fetch(`${BASE}?limit=2`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page1.data.items.map((i: { id: string }) => i.id)).toEqual([auditId(5), auditId(4)]);
    expect(typeof page1.data.nextCursor).toBe('string');

    // Page 2: rows 3,2 + a cursor.
    const page2 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page2.data.items.map((i: { id: string }) => i.id)).toEqual([auditId(3), auditId(2)]);
    expect(typeof page2.data.nextCursor).toBe('string');

    // Page 3: the final row, no cursor.
    const page3 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page2.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page3.data.items.map((i: { id: string }) => i.id)).toEqual([auditId(1)]);
    expect(page3.data.nextCursor).toBeNull();

    // Disjoint across the whole walk: every row exactly once.
    const all = [...page1.data.items, ...page2.data.items, ...page3.data.items];
    expect(all).toHaveLength(5);
    expect(new Set(all.map((i: { id: string }) => i.id)).size).toBe(5);
  });

  it('returns 400 INVALID_CURSOR for a tampered cursor', async () => {
    const page1 = await (
      await SELF.fetch(`${BASE}?limit=2`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    const tampered = `${page1.data.nextCursor.slice(0, -4)}AAAA`;

    const response = await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(tampered)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_CURSOR');
  });

  it('returns 400 INVALID_CURSOR for a cursor minted by the messages surface (fix (d))', async () => {
    // Signed with the REAL key — signature verification passes — but the
    // payload names the messages API's surface. Only the surface
    // discriminator (CAP-044 Slice 2 fix (d)) keeps a messages cursor
    // from being replayed as an audit-events page boundary.
    const messagesCursor = await signCursor(
      { createdAt: '2026-01-01 00:00:00', id: crypto.randomUUID(), surface: 'messages' },
      cursorSigningKey(),
    );

    const response = await SELF.fetch(
      `${BASE}?limit=2&cursor=${encodeURIComponent(messagesCursor)}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_CURSOR');
  });
});

// ---------------------------------------------------------------------------
// Pagination hardening (fix (g)) — the id tie-breaker arm and the
// exact-limit tail, both against real D1 ordering.
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/audit-events — pagination hardening (fix (g))', () => {
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    adminId = await createUserWithRole('administrator', 'admin@example.com');
    adminToken = await createSession(adminId);
  });

  it('breaks created_at ties by id DESC across a page edge — pins the (created_at = ? AND id < ?) arm', async () => {
    // THREE rows sharing ONE created_at, distinct ids. The page edge falls
    // INSIDE the tie group: the boundary cursor's created_at equals the
    // created_at of rows on both sides, so page 2 is reachable only through
    // the (created_at = ? AND id < ?) arm. A strict (created_at < ?) walk
    // would return an empty page 2; a (created_at <= ?) walk would repeat
    // row 2. (Fix (g): the original suite only ever walked distinct
    // created_at values, so this branch had no proof.)
    for (const n of [1, 2, 3]) {
      await createAuditEvent(env.DB, {
        id: auditId(n),
        actorUserId: adminId,
        action: 'message.send',
        resourceType: 'message',
        resourceId: `message-${n}`,
        requestId: `req-${n}`,
        metadata: JSON.stringify({ seeded: n }),
        createdAt: '2026-01-01 00:00:10',
      });
    }

    const page1 = await (
      await SELF.fetch(`${BASE}?limit=2`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page1.data.items.map((i: { id: string }) => i.id)).toEqual([auditId(3), auditId(2)]);
    expect(typeof page1.data.nextCursor).toBe('string');

    const page2 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page2.data.items.map((i: { id: string }) => i.id)).toEqual([auditId(1)]);
    expect(page2.data.nextCursor).toBeNull();
  });

  it('emits a NON-null cursor after a full final page; the walk tail is empty (exact-limit tail)', async () => {
    // 4 rows / limit 2: page 2 is FULL yet contains the last row. The
    // page-was-full rule must still emit a cursor (the repository cannot
    // know there are no more rows without querying); only the walk's next
    // page proves the end with items: [] and nextCursor: null. A client
    // that treats "full page" as "done" would silently drop rows; a server
    // that omits the cursor on a full last page would strand them.
    for (let n = 1; n <= 4; n += 1) {
      await seedAuditRow({
        n,
        actorUserId: adminId,
        action: 'message.send',
        resourceType: 'message',
        resourceId: `message-${n}`,
      });
    }

    const page1 = await (
      await SELF.fetch(`${BASE}?limit=2`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page1.data.items.map((i: { id: string }) => i.id)).toEqual([auditId(4), auditId(3)]);
    expect(typeof page1.data.nextCursor).toBe('string');

    const page2 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page2.data.items.map((i: { id: string }) => i.id)).toEqual([auditId(2), auditId(1)]);
    // Full page + last row: STILL a non-null cursor.
    expect(typeof page2.data.nextCursor).toBe('string');

    const page3 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page2.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page3.data.items).toEqual([]);
    expect(page3.data.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stored-row contract (fix (b)) — the server-side enum detection point.
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/audit-events — stored-row contract (fix (b))', () => {
  it('returns 500 AUDIT_ROW_INVALID when a stored row carries an out-of-enum action', async () => {
    await resetAndMigrate();
    await completeSetup();
    const adminId = await createUserWithRole('administrator', 'admin@example.com');
    const adminToken = await createSession(adminId);

    // One healthy row (seeded through the real repository), then a corrupt
    // row inserted DIRECTLY via D1 — the schema only length-checks
    // `action` (no enum CHECK), so a rogue writer or a legacy row can land
    // outside the closed AuditAction enum. The route must surface a typed
    // 500 AUDIT_ROW_INVALID: never a 200 the client page dies parsing on,
    // and never a silently skipped row (R-AUDIT-003 — forensic surface).
    await seedAuditRow({
      n: 1,
      actorUserId: adminId,
      action: 'message.send',
      resourceType: 'message',
      resourceId: 'message-1',
    });
    await env.DB.prepare(
      `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, request_id, metadata, ip, created_at)
       VALUES (?, NULL, 'not-a-real-action', 'message', 'message-corrupt', NULL, NULL, NULL, '2026-01-01 00:01:00')`,
    )
      .bind(auditId(99))
      .run();

    const response = await SELF.fetch(BASE, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('AUDIT_ROW_INVALID');
  });
});

// ---------------------------------------------------------------------------
// Repository contract (fix (c)) — the half-pair guard on the exported
// function. Unreachable through the validated route (the zod schema's
// refine rejects a half pair with 400 first), so this is a direct
// repository call — still against real D1, never mocked.
// ---------------------------------------------------------------------------

describe('queryAuditEvents — repository contract (fix (c))', () => {
  it('throws AuditFilterPairError when only resourceType is supplied', async () => {
    await resetAndMigrate();
    await completeSetup();

    await expect(
      queryAuditEvents(
        env.DB,
        { resourceType: 'message' },
        { cursorSigningKey: cursorSigningKey() },
      ),
    ).rejects.toBeInstanceOf(AuditFilterPairError);
  });

  it('throws AuditFilterPairError when only resourceId is supplied', async () => {
    await resetAndMigrate();
    await completeSetup();

    await expect(
      queryAuditEvents(
        env.DB,
        { resourceId: 'message-1' },
        { cursorSigningKey: cursorSigningKey() },
      ),
    ).rejects.toBeInstanceOf(AuditFilterPairError);
  });
});
