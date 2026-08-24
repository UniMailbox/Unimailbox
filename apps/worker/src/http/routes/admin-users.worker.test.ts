// admin-users.worker.test.ts — CAP-044 Slice 3 (AC 17). Worker-pool
// tests for GET /api/v1/admin/users. Uses SELF.fetch to exercise the
// full request pipeline against real D1 (no D1 mocking, per testing
// rules).
//
// Covers:
// - 401 anonymous / 403 member (no user.read) / 200 administrator
//   (R-AUTHZ-001/002: user.read is admin-gated)
// - Response shape: every row matches userListItemSchema from contracts
//   (AC 16); displayName nullable; status returned as stored, including
//   soft-deleted users (AC 16 status clause)
// - R-SECRET-003 / AC 16: a recursive walk over the serialized response
//   finds NO key matching /password|salt|hash|credential|secret|token/i —
//   the credential columns (password_algorithm, password_iterations,
//   password_salt, password_hash) never leave the repository
// - Cursor walk across a page edge (limit=2 over 5 rows + the admin;
//   disjoint pages, null terminal cursor) — R-API-005
// - The (created_at = ? AND id < ?) tie-breaker arm across a page edge
//   and the exact-limit tail (the audit-events fix (g) hardening,
//   applied to this surface)
// - Tampered cursor → 400 INVALID_CURSOR (R-API-005)
// - Cross-surface rejection (fix (d)): cursors minted for 'messages'
//   AND 'audit-events' (signed with the real key) are both rejected —
//   'admin-users' is this endpoint's surface
// - Empty page / near-empty table (only the administrator themselves)
// - 400 VALIDATION_ERROR for limit=0, limit=abc, cursor= (empty)
//
// NOT covered here: the 500 USER_ROW_INVALID branch. Unlike
// audit_events.action (length-checked only), users.status carries a
// CHECK constraint in the migration, so an out-of-enum row cannot be
// inserted through D1 at all — the repository's safeParse is
// defense-in-depth against a future schema drift, and a direct
// repository test cannot manufacture the corrupt row without mocking
// D1 (forbidden).

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';
import { signCursor } from '../../platform/cursor';
import { userListItemSchema } from '@unimailbox/contracts';

// ---------------------------------------------------------------------------
// Seeding helpers (modelled on admin-audit-events.worker.test.ts).
// ---------------------------------------------------------------------------

// Seed installation + the user.read permission. The administrator role
// gets it; the member role does NOT (member seeds only the roles
// themselves — user.read stays admin-only).
async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('user.read', 'user.read', 'Read users', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'user.read', datetime('now'))`,
    ),
  ]);
}

interface SeedUserOptions {
  n: number;
  email: string;
  displayName?: string | null;
  status?: 'active' | 'banned' | 'deleted';
  role?: 'administrator' | 'member';
}

/**
 * Seeds one user at a deterministic created_at (row n → 00:00:0n), with a
 * real PBKDF2 password hash (ADR-006) so the row is production-shaped —
 * the no-secret walk proves those columns never leave the repository.
 */
async function seedUser(opts: SeedUserOptions): Promise<string> {
  const userId = `00000000-0000-4000-8000-${String(opts.n).padStart(12, '0')}`;
  const passwordHash = await hashPassword('testPassword123');
  const now = new Date().toISOString();
  const seconds = String(opts.n).padStart(2, '0');

  const statements = [
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      opts.email,
      opts.displayName === undefined ? `${opts.email} user` : opts.displayName,
      opts.status ?? 'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      `2026-01-01 00:00:${seconds}`,
      now,
    ),
  ];
  if (opts.role !== undefined) {
    statements.push(
      env.DB.prepare(`INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)`).bind(
        userId,
        opts.role,
        now,
      ),
    );
  }
  await env.DB.batch(statements);

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

/** userId(n) mirrors seedUser's deterministic ids so assertions stay readable. */
function userId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * The worker-pool test provides CURSOR_SIGNING_KEY as a plain string var
 * (wrangler.test.jsonc); the Secrets Store form only exists in production.
 * Cross-surface tests mint cursors with the REAL key so the only failing
 * check can be the surface discriminator.
 */
function cursorSigningKey(): string {
  const key = env.CURSOR_SIGNING_KEY;
  if (typeof key !== 'string') {
    throw new Error('worker-pool test expects CURSOR_SIGNING_KEY as a plain string var');
  }
  return key;
}

/** Recursively collects every key in a parsed JSON body (objects + arrays). */
function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      collectKeys(entry, into);
    }
  }
  return into;
}

const BASE = 'http://localhost/api/v1/admin/users';

// ---------------------------------------------------------------------------
// Authorization (R-AUTHZ-001/002)
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/users — authorization', () => {
  it('returns 401 when unauthenticated', async () => {
    await resetAndMigrate();
    await completeSetup();

    const response = await SELF.fetch(BASE);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for a member (member role has no user.read)', async () => {
    await resetAndMigrate();
    await completeSetup();
    const memberId = await seedUser({ n: 2, email: 'member@example.com', role: 'member' });
    const memberToken = await createSession(memberId);

    const response = await SELF.fetch(BASE, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  it('returns 200 for an administrator; every row matches userListItemSchema and no credential key appears (R-SECRET-003 / AC 16)', async () => {
    await resetAndMigrate();
    await completeSetup();
    const adminId = await seedUser({
      n: 1,
      email: 'admin@example.com',
      displayName: 'Admin Person',
      role: 'administrator',
    });
    const adminToken = await createSession(adminId);
    await seedUser({ n: 2, email: 'plain@example.com', displayName: null });
    await seedUser({ n: 3, email: 'banned@example.com', status: 'banned' });
    await seedUser({ n: 4, email: 'deleted@example.com', status: 'deleted' });

    const response = await SELF.fetch(BASE, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // 4 rows: the admin + the three seeded users, newest first.
    expect(body.data.items).toHaveLength(4);
    expect(body.data.nextCursor).toBeNull();

    // AC 16/17: every row parses against the contracts schema (which is
    // .strict() — an extra key would fail here too).
    for (const item of body.data.items) {
      const parsed = userListItemSchema.safeParse(item);
      expect(parsed.success, JSON.stringify(item)).toBe(true);
    }

    // Newest first: rows 4,3,2,1.
    expect(body.data.items.map((i: { id: string }) => i.id)).toEqual([
      userId(4),
      userId(3),
      userId(2),
      userId(1),
    ]);

    // Field-level shape: displayName always populated, status returned as
    // stored.
    expect(body.data.items[3]).toMatchObject({
      id: adminId,
      email: 'admin@example.com',
      displayName: 'Admin Person',
      status: 'active',
      createdAt: '2026-01-01 00:00:01',
    });
    // Migration 0014's trigger normalises a NULL/empty display_name to the
    // email local part at write time — a seeded NULL surfaces as 'plain'
    // (the column is nullable per the DDL, but the trigger keeps it
    // non-empty in practice; the wire shape stays nullable to mirror
    // "as stored").
    expect(body.data.items[2].displayName).toBe('plain');
    // Soft-deleted users remain visible to the administrator (AC 16
    // status clause — personnel read, returned as stored).
    expect(body.data.items[1].status).toBe('banned');
    expect(body.data.items[0].status).toBe('deleted');

    // R-SECRET-003: walk EVERY key of the serialized body — no
    // password/credential column may appear under any name. The pattern
    // names all four credential column stems (password_*, _salt, _hash)
    // plus the generic secret/credential/token stems.
    const keys = collectKeys(body);
    const leaking = keys.filter((key) => /password|salt|hash|credential|secret|token/i.test(key));
    expect(leaking, `keys matching the secret pattern: ${leaking.join(', ')}`).toEqual([]);
  });

  it('returns the administrator alone on a near-empty table, with a null cursor', async () => {
    await resetAndMigrate();
    await completeSetup();
    const adminId = await seedUser({ n: 1, email: 'admin@example.com', role: 'administrator' });
    const adminToken = await createSession(adminId);

    const response = await SELF.fetch(BASE, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe(adminId);
    expect(body.data.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cursor pagination (R-API-005 — signed cursor, newest-first walk)
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/users — cursor pagination', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    // Admin is row 1 (oldest); rows 2..5 are members seeded AFTER, each
    // one second newer. Five users total.
    const adminId = await seedUser({ n: 1, email: 'admin@example.com', role: 'administrator' });
    adminToken = await createSession(adminId);
    for (let n = 2; n <= 5; n += 1) {
      await seedUser({ n, email: `user${n}@example.com` });
    }
  });

  it('walks the full table across page edges with disjoint pages and a null terminal cursor', async () => {
    // Page 1: rows 5,4 (newest first) + a cursor.
    const page1 = await (
      await SELF.fetch(`${BASE}?limit=2`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page1.data.items.map((i: { id: string }) => i.id)).toEqual([userId(5), userId(4)]);
    expect(typeof page1.data.nextCursor).toBe('string');

    // Page 2: rows 3,2 + a cursor.
    const page2 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page2.data.items.map((i: { id: string }) => i.id)).toEqual([userId(3), userId(2)]);
    expect(typeof page2.data.nextCursor).toBe('string');

    // Page 3: the final row (the admin themselves), no cursor.
    const page3 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page2.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page3.data.items.map((i: { id: string }) => i.id)).toEqual([userId(1)]);
    expect(page3.data.nextCursor).toBeNull();

    // Disjoint across the whole walk: every user exactly once.
    const all = [...page1.data.items, ...page2.data.items, ...page3.data.items];
    expect(all).toHaveLength(5);
    expect(new Set(all.map((i: { id: string }) => i.id)).size).toBe(5);
  });

  it('emits a NON-null cursor after a full final page; the walk tail is empty (exact-limit tail)', async () => {
    // Seed one more user (6 total) so every page of the limit-2 walk is
    // full through the last row. 6 users / limit 2: page 3 is FULL yet
    // contains the last row. The page-was-full rule must still emit a
    // cursor (the repository cannot know there are no more rows without
    // querying); only the walk's next page proves the end with items: []
    // and nextCursor: null.
    await seedUser({ n: 6, email: 'user6@example.com' });
    const page1 = await (
      await SELF.fetch(`${BASE}?limit=2`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    const page2 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    const page3 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page2.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page3.data.items.map((i: { id: string }) => i.id)).toEqual([userId(2), userId(1)]);
    // Full page + last row: STILL a non-null cursor.
    expect(typeof page3.data.nextCursor).toBe('string');

    const page4 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page3.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page4.data.items).toEqual([]);
    expect(page4.data.nextCursor).toBeNull();
  });

  it('breaks created_at ties by id DESC across a page edge — pins the (created_at = ? AND id < ?) arm', async () => {
    await resetAndMigrate();
    await completeSetup();
    const adminId = await seedUser({ n: 1, email: 'admin@example.com', role: 'administrator' });
    adminToken = await createSession(adminId);

    // THREE rows sharing ONE created_at, distinct ids. The page edge falls
    // INSIDE the tie group: the boundary cursor's created_at equals the
    // created_at of rows on both sides, so page 2 is reachable only
    // through the (created_at = ? AND id < ?) arm.
    const seconds = String(2).padStart(2, '0');
    const tieCreatedAt = `2026-01-01 00:00:${seconds}`;
    const passwordHash = await hashPassword('testPassword123');
    const now = new Date().toISOString();
    for (const n of [2, 3, 4]) {
      await env.DB.prepare(
        `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          userId(n),
          `tie${n}@example.com`,
          null,
          'active',
          passwordHash.algorithm,
          passwordHash.iterations,
          passwordHash.salt,
          passwordHash.hash,
          tieCreatedAt,
          now,
        )
        .run();
    }

    const page1 = await (
      await SELF.fetch(`${BASE}?limit=2`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    // The tie group (ids 4,3) sorts before the older admin (id 1); within
    // the tie, id DESC.
    expect(page1.data.items.map((i: { id: string }) => i.id)).toEqual([userId(4), userId(3)]);
    expect(typeof page1.data.nextCursor).toBe('string');

    const page2 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page2.data.items.map((i: { id: string }) => i.id)).toEqual([userId(2), userId(1)]);
    // Page 2 is FULL (2 of limit 2) and contains the last row: still a
    // non-null cursor (the exact-limit rule), proven terminal by page 3.
    expect(typeof page2.data.nextCursor).toBe('string');

    const page3 = await (
      await SELF.fetch(`${BASE}?limit=2&cursor=${encodeURIComponent(page2.data.nextCursor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(page3.data.items).toEqual([]);
    expect(page3.data.nextCursor).toBeNull();
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
    // from being replayed as an admin-users page boundary.
    const messagesCursor = await signCursor(
      { createdAt: '2026-01-01 00:00:00', id: crypto.randomUUID(), surface: 'messages' },
      cursorSigningKey(),
    );

    const response = await SELF.fetch(`${BASE}?cursor=${encodeURIComponent(messagesCursor)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_CURSOR');
  });

  it('returns 400 INVALID_CURSOR for a cursor minted by the audit-events surface (fix (d))', async () => {
    // The sibling admin list is the most tempting replay target — the
    // promotion of the surface union into contracts (CAP-044 Slice 3
    // amendment) must not have loosened the discrimination.
    const auditCursor = await signCursor(
      { createdAt: '2026-01-01 00:00:00', id: crypto.randomUUID(), surface: 'audit-events' },
      cursorSigningKey(),
    );

    const response = await SELF.fetch(`${BASE}?cursor=${encodeURIComponent(auditCursor)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_CURSOR');
  });
});

// ---------------------------------------------------------------------------
// Query-param validation (the route's zod boundary)
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/users — query validation', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const adminId = await seedUser({ n: 1, email: 'admin@example.com', role: 'administrator' });
    adminToken = await createSession(adminId);
  });

  it('rejects limit=0 with 400 VALIDATION_ERROR', async () => {
    const response = await SELF.fetch(`${BASE}?limit=0`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-numeric limit with 400 VALIDATION_ERROR', async () => {
    const response = await SELF.fetch(`${BASE}?limit=abc`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an empty cursor with 400 VALIDATION_ERROR', async () => {
    const response = await SELF.fetch(`${BASE}?cursor=`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('clamps limit above the max server-side (limit=500 behaves as 50, still 200)', async () => {
    const response = await SELF.fetch(`${BASE}?limit=500`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items.length).toBeLessThanOrEqual(50);
  });
});
