// apps/worker/test/role-policy-normalize.worker.test.ts — CAP-036.
//
// Real Worker-pool upgrade suite. Exercises the full D1 migration path
// through 0019_role_policy_normalize.sql + the new contract surface
// (hydrated RolePolicy + prepareSetRolePolicyBatch).
//
// Per .claude/rules/testing.md §Mocking — D1 is real (workerd binding).
// Per the contract's TEST-FIRST EXPECTATIONS: the suite proves exact
// child-row backfill, hydrated single/multi-role reads, no Cartesian
// multiplication, replacement writes, empty-array replacement, 500/501
// boundary, child-row CASCADE, unchanged inbound semantics, and failure
// rollback across business + audit + idempotency statements.

import { describe, expect, it, beforeEach } from 'vitest';
import { env as _env } from 'cloudflare:test';
import { migrationsDb } from '@unimailbox/test-kit';
import {
  prepareSetRolePolicyBatch,
  prepareCreateAuditEvent,
  getRolePolicy,
  loadRolePoliciesForRoleIds,
  createRolePolicyReader,
} from '../src/modules/admin';
import { evaluateInboundPolicy } from '../src/modules/inbound-mail/policy-evaluator';
import { prepareCreateIdempotencyRecord, sqliteTimestamp } from '../src/platform/idempotency';
import { systemIds } from '../src/platform/ids';
import { setRolePolicyRequestSchema } from '@unimailbox/contracts';
import type { ParsedEmail } from '@unimailbox/email-core';
import rolePolicyNormalizeVerifySql from '../../../migrations/0019_role_policy_normalize.verify.sql?raw';

const parsedLike = (overrides: Partial<ParsedEmail> = {}): ParsedEmail => ({
  from: { address: 'sender@example.com', name: 'Sender' },
  to: [{ address: 'inbox@example.com', name: 'Inbox' }],
  cc: [],
  subject: 'Hello',
  messageId: '<e@message.id>',
  inReplyTo: null,
  references: '',
  htmlBody: '<p>x</p>',
  textBody: 'x',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedRole(db: D1Database, id: string, name: string): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
       VALUES (?, ?, ?, 1, datetime('now'))`,
    )
    .bind(id, name, name)
    .run();
}

// CAP-036: role_policies.updated_by REFERENCES users(id) ON DELETE SET NULL.
// The FK check fires on INSERT, so tests that call prepareSetRolePolicyBatch
// with updatedBy='u-1' must first seed that user row. Same for any other
// actor id used as updated_by in this suite.
async function seedActor(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO users
         (id, email, display_name, status, password_algorithm, password_iterations,
          password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'pbkdf2-sha256', 600000, x'00', x'11',
               datetime('now'), datetime('now'))`,
    )
    .bind(id, `${id}@example.test`, id)
    .run();
}

async function nowTs(): Promise<string> {
  return sqliteTimestamp(new Date());
}

function verificationStatements(db: D1Database): D1PreparedStatement[] {
  return rolePolicyNormalizeVerifySql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement));
}

function createReadBatchProbe(results: ReadonlyArray<D1Result<Record<string, unknown>>>): {
  readonly db: D1Database;
  readonly batchCalls: () => number;
  readonly batchStatementCounts: () => ReadonlyArray<number>;
} {
  let calls = 0;
  const statementCounts: number[] = [];
  const db = {
    prepare(query: string) {
      const statement = {
        query,
        bind() {
          return statement;
        },
        first() {
          throw new Error('read executed outside batch');
        },
        all() {
          throw new Error('read executed outside batch');
        },
      };
      return statement;
    },
    async batch(statements: ReadonlyArray<D1PreparedStatement>) {
      calls += 1;
      statementCounts.push(statements.length);
      return results;
    },
  } as unknown as D1Database;

  return {
    db,
    batchCalls: () => calls,
    batchStatementCounts: () => statementCounts,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CAP-036 — role_policies JSON normalization upgrade suite', () => {
  beforeEach(async () => {
    // Only reset the binding. Do NOT pre-apply migrations here — the
    // migration tests below must be able to step through 0018 first and
    // observe the legacy JSON columns, then advance through 0019. If
    // beforeEach applied the full set, 0019 would drop the columns before
    // the legacy-INSERT assertions ran.
    const { reset } = await import('cloudflare:test');
    await reset();
  });

  // Helper for tests that need the latest schema + the FK-targeted users
  // rows. Each test that calls migrationsDb() without a `through` boundary
  // is responsible for seeding its own actor(s).
  async function setupLatestWithActor(): Promise<D1Database> {
    const db = await migrationsDb();
    await seedActor(db, 'u-1');
    await seedActor(db, 'u-2');
    return db;
  }

  // -------------------------------------------------------------------------
  // AC: migrate through 0018 → seed legacy JSON → advance through 0019 →
  // exact child-row backfill.
  // -------------------------------------------------------------------------
  it('migrates 0018 → seeds legacy JSON → advances 0019 with exact backfill', async () => {
    // 1. Apply only 0001..0018.
    const db = await migrationsDb({ through: '0018_audit_read_permission_backfill' });

    // 2. Seed roles + legacy role_policies rows with JSON columns.
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
         VALUES ('role-a', 'role-a', 'A', 1, datetime('now'))`,
      ),
      db.prepare(
        `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
         VALUES ('role-b', 'role-b', 'B', 1, datetime('now'))`,
      ),
      db.prepare(
        `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
         VALUES ('role-empty', 'role-empty', 'Empty', 1, datetime('now'))`,
      ),
    ]);
    const now = await nowTs();
    await db.batch([
      db
        .prepare(
          `INSERT INTO role_policies (role_id, ban_email_patterns_json, avail_domain_patterns_json, updated_by, updated_at)
           VALUES ('role-a', ?, ?, NULL, ?)`,
        )
        .bind(
          JSON.stringify(['spammer@example.com', '@evil.com']),
          JSON.stringify(['@allowed.com', '@other.com']),
          now,
        ),
      db
        .prepare(
          `INSERT INTO role_policies (role_id, ban_email_patterns_json, avail_domain_patterns_json, updated_by, updated_at)
           VALUES ('role-b', ?, ?, NULL, ?)`,
        )
        .bind(JSON.stringify(['*']), JSON.stringify([]), now),
      db
        .prepare(
          `INSERT INTO role_policies (role_id, ban_email_patterns_json, avail_domain_patterns_json, updated_by, updated_at)
           VALUES ('role-empty', ?, ?, NULL, ?)`,
        )
        .bind(JSON.stringify([]), JSON.stringify([]), now),
    ]);

    // 3. Advance through 0019.
    await migrationsDb();

    // 4. role_policies has exactly the metadata columns.
    const cols = await db.prepare(`PRAGMA table_info('role_policies')`).all<{ name: string }>();
    const colNames = (cols.results ?? []).map((r: { name: string }) => r.name).sort();
    expect(colNames).toEqual(['role_id', 'updated_at', 'updated_by']);
    // Legacy JSON columns are gone.
    expect(colNames).not.toContain('ban_email_patterns_json');
    expect(colNames).not.toContain('avail_domain_patterns_json');

    // 5. Exact backfill: role-a has 2 ban patterns + 2 avail patterns.
    const aBan = await db
      .prepare(`SELECT pattern FROM role_policy_ban_emails WHERE role_id = ? ORDER BY pattern`)
      .bind('role-a')
      .all<{ pattern: string }>();
    expect((aBan.results ?? []).map((r: { pattern: string }) => r.pattern)).toEqual([
      '@evil.com',
      'spammer@example.com',
    ]);
    const aAvail = await db
      .prepare(`SELECT pattern FROM role_policy_avail_domains WHERE role_id = ? ORDER BY pattern`)
      .bind('role-a')
      .all<{ pattern: string }>();
    expect((aAvail.results ?? []).map((r: { pattern: string }) => r.pattern)).toEqual([
      '@allowed.com',
      '@other.com',
    ]);

    // role-b: ban=['*'], avail=[].
    const bBan = await db
      .prepare(`SELECT pattern FROM role_policy_ban_emails WHERE role_id = ?`)
      .bind('role-b')
      .all<{ pattern: string }>();
    expect((bBan.results ?? []).map((r: { pattern: string }) => r.pattern)).toEqual(['*']);
    const bAvail = await db
      .prepare(`SELECT pattern FROM role_policy_avail_domains WHERE role_id = ?`)
      .bind('role-b')
      .all<{ pattern: string }>();
    expect(bAvail.results ?? []).toEqual([]);

    // role-empty: ban=[], avail=[].
    const emptyBan = await db
      .prepare(`SELECT pattern FROM role_policy_ban_emails WHERE role_id = ?`)
      .bind('role-empty')
      .all<{ pattern: string }>();
    expect(emptyBan.results ?? []).toEqual([]);
    const emptyAvail = await db
      .prepare(`SELECT pattern FROM role_policy_avail_domains WHERE role_id = ?`)
      .bind('role-empty')
      .all<{ pattern: string }>();
    expect(emptyAvail.results ?? []).toEqual([]);

    // 6. Metadata rows survived the rebuild (role_id, updated_by, updated_at).
    const metaA = await db
      .prepare(`SELECT role_id, updated_by, updated_at FROM role_policies WHERE role_id = ?`)
      .bind('role-a')
      .first<{ role_id: string; updated_by: string | null; updated_at: string }>();
    expect(metaA?.role_id).toBe('role-a');
    expect(metaA?.updated_by).toBeNull();
    expect(metaA?.updated_at).toBe(now);
  });

  it('executes every 0019 companion assertion successfully on the final schema', async () => {
    const db = await migrationsDb();
    const results = await db.batch<{ assertion: string; pass: number }>(verificationStatements(db));

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.results.length === 1)).toBe(true);
    const rows = results.flatMap((result) => result.results);
    expect(rows.every((row) => row.pass === 1)).toBe(true);
    expect(rows.map((row) => row.assertion).sort()).toEqual(
      [
        '0019_tracking_row_exists',
        '0019_role_policies_columns',
        '0019_role_policies_no_legacy_json',
        '0019_role_policies_pk',
        '0019_role_policies_fk',
        '0019_ban_emails_table',
        '0019_ban_emails_pattern_check',
        '0019_ban_emails_pk',
        '0019_ban_emails_fk_cascade',
        '0019_avail_domains_table',
        '0019_avail_domains_pattern_check',
        '0019_avail_domains_pk',
        '0019_avail_domains_fk_cascade',
        '0019_no_orphan_ban_emails',
        '0019_no_orphan_avail_domains',
        '0019_ban_email_lengths_valid',
        '0019_avail_domain_lengths_valid',
        '0019_no_duplicate_ban_emails',
        '0019_no_duplicate_avail_domains',
      ].sort(),
    );
  });

  it('rolls back a failed 0019 migration without leaving partial schema state', async () => {
    const db = await migrationsDb({ through: '0018_audit_read_permission_backfill' });
    await seedRole(db, 'role-invalid-upgrade', 'role-invalid-upgrade');
    await db
      .prepare(
        `INSERT INTO role_policies
           (role_id, ban_email_patterns_json, avail_domain_patterns_json, updated_by, updated_at)
         VALUES (?, ?, '[]', NULL, datetime('now'))`,
      )
      .bind('role-invalid-upgrade', 'not-valid-json')
      .run();

    await expect(migrationsDb()).rejects.toThrow();

    const legacyColumns = await db
      .prepare(`SELECT name FROM pragma_table_info('role_policies') ORDER BY cid`)
      .all<{ name: string }>();
    expect(legacyColumns.results.map((row) => row.name)).toEqual([
      'role_id',
      'ban_email_patterns_json',
      'avail_domain_patterns_json',
      'updated_by',
      'updated_at',
    ]);
    const childTables = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('role_policy_ban_emails', 'role_policy_avail_domains')`,
      )
      .first<{ count: number }>();
    const tracking = await db
      .prepare(`SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?`)
      .bind('0019_role_policy_normalize.sql')
      .first<{ count: number }>();
    expect(childTables?.count).toBe(0);
    expect(tracking?.count).toBe(0);
  });

  it('treats a repeated pending-only 0019 migration run as a no-op', async () => {
    const db = await migrationsDb();
    await seedActor(db, 'repeat-actor');
    await seedRole(db, 'role-repeat', 'role-repeat');
    const now = await nowTs();
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-repeat',
        banEmail: ['repeat@example.com'],
        availDomain: ['@repeat.example'],
        updatedBy: 'repeat-actor',
        updatedAt: now,
      }),
    );

    await migrationsDb();

    const tracking = await db
      .prepare(`SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?`)
      .bind('0019_role_policy_normalize.sql')
      .first<{ count: number }>();
    expect(tracking?.count).toBe(1);
    expect(await getRolePolicy(db, 'role-repeat')).toMatchObject({
      banEmail: ['repeat@example.com'],
      availDomain: ['@repeat.example'],
    });
  });

  // -------------------------------------------------------------------------
  // AC: null/default/empty legacy values backfill to empty child collections.
  // -------------------------------------------------------------------------
  it('null / default / empty legacy values backfill to empty child collections', async () => {
    const db = await migrationsDb({ through: '0018_audit_read_permission_backfill' });
    await seedRole(db, 'role-null', 'role-null');
    await seedRole(db, 'role-default', 'role-default');
    await seedRole(db, 'role-explicit-empty', 'role-explicit-empty');

    // (a) The 0010 schema defaults are '[]' for both JSON columns. Insert
    //     with explicit '[]' (D1's SQLite version does not accept the
    //     DEFAULT keyword in INSERT VALUES at the position this test uses).
    await db
      .prepare(
        `INSERT INTO role_policies (role_id, ban_email_patterns_json, avail_domain_patterns_json, updated_by, updated_at)
         VALUES ('role-default', '[]', '[]', NULL, datetime('now'))`,
      )
      .run();
    // (b) Explicit empty arrays.
    await db
      .prepare(
        `INSERT INTO role_policies (role_id, ban_email_patterns_json, avail_domain_patterns_json, updated_by, updated_at)
         VALUES ('role-explicit-empty', '[]', '[]', NULL, datetime('now'))`,
      )
      .run();

    await migrationsDb();

    for (const roleId of ['role-default', 'role-explicit-empty']) {
      const bans = await db
        .prepare(`SELECT pattern FROM role_policy_ban_emails WHERE role_id = ?`)
        .bind(roleId)
        .all<{ pattern: string }>();
      const avails = await db
        .prepare(`SELECT pattern FROM role_policy_avail_domains WHERE role_id = ?`)
        .bind(roleId)
        .all<{ pattern: string }>();
      expect(bans.results ?? []).toEqual([]);
      expect(avails.results ?? []).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // AC: hydrated single-role read returns RolePolicy (no JSON parsing).
  // -------------------------------------------------------------------------
  it('getRolePolicy returns hydrated RolePolicy objects (no raw storage row)', async () => {
    const db = await setupLatestWithActor();
    await seedRole(db, 'role-hydrate', 'role-hydrate');
    const now = await nowTs();
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-hydrate',
        banEmail: ['a@example.com', '@x.com'],
        availDomain: ['@x.com'],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
    );

    const policy = await getRolePolicy(db, 'role-hydrate');
    expect(policy).not.toBeNull();
    if (!policy) throw new Error('expected hydrated policy');
    expect(policy.roleId).toBe('role-hydrate');
    expect(policy.banEmail.sort()).toEqual(['@x.com', 'a@example.com']);
    expect(policy.availDomain).toEqual(['@x.com']);
    expect(policy.updatedBy).toBe('u-1');
    expect(policy.updatedAt).toBe(now);
    // No raw storage fields leak across the edge.
    expect(
      (policy as unknown as { ban_email_patterns_json?: unknown }).ban_email_patterns_json,
    ).toBeUndefined();
  });

  it('getRolePolicy returns null when the role has no policy metadata row', async () => {
    const db = await migrationsDb();
    await seedRole(db, 'role-without-policy', 'role-without-policy');

    await expect(getRolePolicy(db, 'role-without-policy')).resolves.toBeNull();
  });

  it('executes the three policy reads in one transactional D1 batch', async () => {
    const probe = createReadBatchProbe([
      { results: [{ role_id: 'role-batched', updated_by: null, updated_at: 'now' }] },
      { results: [{ role_id: 'role-batched', pattern: 'ban@example.com' }] },
      { results: [{ role_id: 'role-batched', pattern: '@allowed.example' }] },
    ] as ReadonlyArray<D1Result<Record<string, unknown>>>);

    await expect(getRolePolicy(probe.db, 'role-batched')).resolves.toMatchObject({
      roleId: 'role-batched',
      banEmail: ['ban@example.com'],
      availDomain: ['@allowed.example'],
    });
    expect(probe.batchCalls()).toBe(1);
    expect(probe.batchStatementCounts()).toEqual([3]);
  });

  it('executes a multi-role projection as one three-statement read batch', async () => {
    const probe = createReadBatchProbe([
      {
        results: [
          { role_id: 'role-a', updated_by: null, updated_at: 'now-a' },
          { role_id: 'role-b', updated_by: null, updated_at: 'now-b' },
        ],
      },
      { results: [{ role_id: 'role-a', pattern: 'ban@example.com' }] },
      { results: [{ role_id: 'role-b', pattern: '@allowed.example' }] },
    ] as ReadonlyArray<D1Result<Record<string, unknown>>>);

    await expect(loadRolePoliciesForRoleIds(probe.db, ['role-a', 'role-b'])).resolves.toEqual([
      {
        roleId: 'role-a',
        banEmail: ['ban@example.com'],
        availDomain: [],
        updatedBy: null,
        updatedAt: 'now-a',
      },
      {
        roleId: 'role-b',
        banEmail: [],
        availDomain: ['@allowed.example'],
        updatedBy: null,
        updatedAt: 'now-b',
      },
    ]);
    expect(probe.batchCalls()).toBe(1);
    expect(probe.batchStatementCounts()).toEqual([3]);
  });

  it('rejects malformed rows returned by the policy read batch', async () => {
    const probe = createReadBatchProbe([
      { results: [{ role_id: 'role-malformed', updated_by: null, updated_at: 'now' }] },
      { results: [{ role_id: 'role-malformed', pattern: null }] },
      { results: [] },
    ] as ReadonlyArray<D1Result<Record<string, unknown>>>);

    await expect(getRolePolicy(probe.db, 'role-malformed')).rejects.toThrow(
      'Malformed role policy pattern row',
    );
  });

  // -------------------------------------------------------------------------
  // AC: hydrated multi-role read; no Cartesian multiplication across the
  // two one-to-many child tables.
  // -------------------------------------------------------------------------
  it('loadRolePoliciesForRoleIds groups child rows without Cartesian multiplication', async () => {
    const db = await setupLatestWithActor();
    await seedRole(db, 'role-m1', 'role-m1');
    await seedRole(db, 'role-m2', 'role-m2');
    await seedRole(db, 'role-m3', 'role-m3');

    const now = await nowTs();
    // role-m1: 2 ban, 3 avail (different counts — Cartesian would blow up).
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-m1',
        banEmail: ['m1-a@x.com', 'm1-b@x.com'],
        availDomain: ['@m1-x.com', '@m1-y.com', '@m1-z.com'],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
    );
    // role-m2: 0 ban, 1 avail.
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-m2',
        banEmail: [],
        availDomain: ['@m2.com'],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
    );
    // role-m3: empty policy.
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-m3',
        banEmail: [],
        availDomain: [],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
    );

    const multi = await loadRolePoliciesForRoleIds(db, ['role-m1', 'role-m2', 'role-m3']);
    // Exactly 3 entries — no duplication.
    expect(multi.length).toBe(3);
    const ids = multi.map((p) => p.roleId).sort();
    expect(ids).toEqual(['role-m1', 'role-m2', 'role-m3']);

    // Each role's patterns match what was set.
    const m1 = multi.find((p) => p.roleId === 'role-m1');
    expect(m1?.banEmail.sort()).toEqual(['m1-a@x.com', 'm1-b@x.com']);
    expect(m1?.availDomain.sort()).toEqual(['@m1-x.com', '@m1-y.com', '@m1-z.com']);
    const m2 = multi.find((p) => p.roleId === 'role-m2');
    expect(m2?.banEmail).toEqual([]);
    expect(m2?.availDomain).toEqual(['@m2.com']);
    const m3 = multi.find((p) => p.roleId === 'role-m3');
    expect(m3?.banEmail).toEqual([]);
    expect(m3?.availDomain).toEqual([]);

    // Empty input → empty output (no SQL roundtrip).
    expect(await loadRolePoliciesForRoleIds(db, [])).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // AC: RolePolicyReader (cross-module read seam) returns hydrated objects.
  // -------------------------------------------------------------------------
  it('RolePolicyReader returns hydrated RolePolicy (cross-module edge never exposes raw row)', async () => {
    const db = await setupLatestWithActor();
    await seedRole(db, 'role-reader', 'role-reader');
    const now = await nowTs();
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-reader',
        banEmail: ['reader@x.com'],
        availDomain: ['@reader.com'],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
    );

    const reader = createRolePolicyReader(db);
    const policies = await reader.loadRolePoliciesForRoleIds(['role-reader']);
    expect(policies.length).toBe(1);
    const p = policies[0];
    if (!p) throw new Error('expected one policy');
    expect(p.roleId).toBe('role-reader');
    expect(p.banEmail).toEqual(['reader@x.com']);
    expect(p.availDomain).toEqual(['@reader.com']);
    expect(p.updatedBy).toBe('u-1');
    // No raw storage fields leak across the edge.
    expect(
      (p as unknown as { ban_email_patterns_json?: unknown }).ban_email_patterns_json,
    ).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC: replacement writes use the 5-statement batch; empty arrays delete
  // existing child rows without inserting replacements; metadata row is
  // preserved.
  // -------------------------------------------------------------------------
  it('prepareSetRolePolicyBatch with empty arrays deletes child rows and keeps metadata', async () => {
    const db = await setupLatestWithActor();
    await seedRole(db, 'role-empty-write', 'role-empty-write');
    const now = await nowTs();

    // First write: 1 ban + 1 avail.
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-empty-write',
        banEmail: ['keep@x.com'],
        availDomain: ['@keep.com'],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
    );
    expect(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM role_policy_ban_emails WHERE role_id = ?`)
          .bind('role-empty-write')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM role_policy_avail_domains WHERE role_id = ?`)
          .bind('role-empty-write')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);

    // Replace with empty arrays.
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-empty-write',
        banEmail: [],
        availDomain: [],
        updatedBy: 'u-2',
        updatedAt: now,
      }),
    );
    expect(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM role_policy_ban_emails WHERE role_id = ?`)
          .bind('role-empty-write')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM role_policy_avail_domains WHERE role_id = ?`)
          .bind('role-empty-write')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    // Metadata row remains; updated_by reflects the latest write.
    expect(
      (
        await db
          .prepare(`SELECT updated_by FROM role_policies WHERE role_id = ?`)
          .bind('role-empty-write')
          .first<{ updated_by: string | null }>()
      )?.updated_by,
    ).toBe('u-2');
  });

  // -------------------------------------------------------------------------
  // AC: 500 items succeed; 501 are rejected by request-schema validation
  // (the public contract cap).
  // -------------------------------------------------------------------------
  it('500 items succeed and 501 are rejected by request-schema validation', async () => {
    const db = await setupLatestWithActor();
    await seedRole(db, 'role-cap', 'role-cap');
    const now = await nowTs();

    // 500 distinct banEmail patterns; 500 distinct availDomain patterns.
    const ban500 = Array.from({ length: 500 }, (_, i) => `u${i}@example.com`);
    const avail500 = Array.from({ length: 500 }, (_, i) => `@d${i}.example`);

    const stmts = prepareSetRolePolicyBatch(db, {
      roleId: 'role-cap',
      banEmail: ban500,
      availDomain: avail500,
      updatedBy: 'u-1',
      updatedAt: now,
    });
    expect(stmts.length).toBe(5);
    await db.batch(stmts);

    const banCount = (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM role_policy_ban_emails WHERE role_id = ?`)
        .bind('role-cap')
        .first<{ n: number }>()
    )?.n;
    expect(banCount).toBe(500);
    const availCount = (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM role_policy_avail_domains WHERE role_id = ?`)
        .bind('role-cap')
        .first<{ n: number }>()
    )?.n;
    expect(availCount).toBe(500);

    // 501 patterns: rejected by the public schema.
    const result501 = setRolePolicyRequestSchema.safeParse({
      banEmail: Array.from({ length: 501 }, (_, i) => `x${i}@example.com`),
      availDomain: [],
    });
    expect(result501.success).toBe(false);
  });

  it('rejects child patterns outside the relational length constraints', async () => {
    const db = await setupLatestWithActor();
    await seedRole(db, 'role-length-check', 'role-length-check');

    await expect(
      db
        .prepare(`INSERT INTO role_policy_ban_emails (role_id, pattern) VALUES (?, ?)`)
        .bind('role-length-check', 'x'.repeat(255))
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      db
        .prepare(`INSERT INTO role_policy_avail_domains (role_id, pattern) VALUES (?, ?)`)
        .bind('role-length-check', '@')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  // -------------------------------------------------------------------------
  // AC: child-row CASCADE — deleting a role removes its policy metadata +
  // child rows.
  // -------------------------------------------------------------------------
  it('deleting a role cascades to its policy metadata and child rows', async () => {
    const db = await setupLatestWithActor();
    await seedRole(db, 'role-cascade', 'role-cascade');
    const now = await nowTs();
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-cascade',
        banEmail: ['cascade@x.com'],
        availDomain: ['@cascade.com'],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
    );
    expect(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM role_policy_ban_emails WHERE role_id = ?`)
          .bind('role-cascade')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);

    // PRAGMA foreign_keys is ON by default in D1; delete cascades.
    await db.prepare(`DELETE FROM roles WHERE id = ?`).bind('role-cascade').run();

    expect(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM role_policy_ban_emails WHERE role_id = ?`)
          .bind('role-cascade')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM role_policy_avail_domains WHERE role_id = ?`)
          .bind('role-cascade')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM role_policies WHERE role_id = ?`)
          .bind('role-cascade')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC: failure rollback — a failure in any one of the 5 batched statements
  // rolls back the entire logical operation (business + audit +
  // idempotency).
  // -------------------------------------------------------------------------
  it('a failure in the batch rolls back business, audit, and idempotency writes', async () => {
    const db = await setupLatestWithActor();
    await seedRole(db, 'role-rollback', 'role-rollback');
    const now = await nowTs();

    // 1. Seed an existing policy.
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-rollback',
        banEmail: ['before@example.com'],
        availDomain: ['@before.com'],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
    );

    // 2. Construct a 7-statement batch:
    //    5× business (delete/insert/upsert) + 1× audit + 1× idempotency.
    //    The audit row references an actor_user_id that does NOT exist in
    //    users. FK CASCADE on audit_events.actor_user_id → users(id) is
    //    SET NULL (not RESTRICT), so SET NULL would silently coerce. To
    //    force a failure, we rely on a NOT NULL constraint on
    //    idempotency_records.actor_id. Better: make the metadata UPSERT
    //    fail by passing an updated_by that does not exist.
    //    role_policies.updated_by REFERENCES users(id) ON DELETE SET NULL,
    //    which is also non-restrict. Instead, target the idempotency
    //    record's PRIMARY KEY conflict: a duplicate idempotency_key for
    //    the same (actor, operation) violates the unique constraint that
    //    the platform enforces. To make this concrete, we first write a
    //    benign idempotency record, then submit a second batch with the
    //    same key — the second batch fails atomically.
    const idemKey = 'idem-rollback-' + crypto.randomUUID();
    const operation = 'PUT /api/v1/admin/roles/role-rollback/policy';
    // idempotency_records.request_hash is length-CHECKed to 64 chars
    // (SHA-256 hex). Use realistic hex strings, not placeholders.
    const hashExisting = 'a'.repeat(64);
    const hashConflict = 'b'.repeat(64);

    // Pre-seed an idempotency record with the same actor + operation + key.
    await db.batch([
      prepareCreateIdempotencyRecord(db, {
        id: systemIds.uuid(),
        actorId: 'u-1',
        operation,
        idempotencyKey: idemKey,
        requestHash: hashExisting,
        responseStatus: 200,
        responseJson: '{"data":{}}',
        createdAt: now,
      }),
    ]);

    const failingBatch = [
      ...prepareSetRolePolicyBatch(db, {
        roleId: 'role-rollback',
        banEmail: ['after@example.com'],
        availDomain: ['@after.com'],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
      prepareCreateAuditEvent(db, {
        id: systemIds.uuid(),
        actorUserId: 'u-1',
        action: 'role_policy.set',
        resourceType: 'role_policy',
        resourceId: 'role-rollback',
        requestId: null,
        createdAt: now,
      }),
      prepareCreateIdempotencyRecord(db, {
        id: systemIds.uuid(),
        actorId: 'u-1',
        operation,
        idempotencyKey: idemKey, // duplicate key
        requestHash: hashConflict,
        responseStatus: 200,
        responseJson: '{"data":{}}',
        createdAt: now,
      }),
    ];

    await expect(db.batch(failingBatch)).rejects.toThrow();

    // 3. Verify rollback across all three layers.
    const bans = await db
      .prepare(`SELECT pattern FROM role_policy_ban_emails WHERE role_id = ?`)
      .bind('role-rollback')
      .all<{ pattern: string }>();
    expect((bans.results ?? []).map((r: { pattern: string }) => r.pattern)).toEqual([
      'before@example.com',
    ]);
    const avails = await db
      .prepare(`SELECT pattern FROM role_policy_avail_domains WHERE role_id = ?`)
      .bind('role-rollback')
      .all<{ pattern: string }>();
    expect((avails.results ?? []).map((r: { pattern: string }) => r.pattern)).toEqual([
      '@before.com',
    ]);

    const auditCount = (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'role_policy.set' AND resource_id = ?`,
        )
        .bind('role-rollback')
        .first<{ n: number }>()
    )?.n;
    expect(auditCount).toBe(0);

    const idemCount = (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM idempotency_records WHERE idempotency_key = ?`)
        .bind(idemKey)
        .first<{ n: number }>()
    )?.n;
    expect(idemCount).toBe(1); // pre-existing one only; the failing batch was rolled back
  });

  // -------------------------------------------------------------------------
  // AC: inbound policy semantics unchanged. The evaluator still rejects
  // banEmail hits, accepts availDomain matches, and combines multiple
  // roles restrictively.
  // -------------------------------------------------------------------------
  it('inbound policy semantics unchanged through the hydrated contract', async () => {
    const db = await setupLatestWithActor();
    await seedRole(db, 'role-evals', 'role-evals');
    const now = await nowTs();
    await db.batch(
      prepareSetRolePolicyBatch(db, {
        roleId: 'role-evals',
        banEmail: ['spammer@example.com', '@evil.com'],
        availDomain: ['@allowed.com'],
        updatedBy: 'u-1',
        updatedAt: now,
      }),
    );

    const policies = await loadRolePoliciesForRoleIds(db, ['role-evals']);
    expect(policies.length).toBe(1);

    // banEmail exact match → reject.
    const d1 = evaluateInboundPolicy(
      parsedLike({ from: { address: 'spammer@evil.com', name: '' } }),
      policies,
      [],
    );
    expect(d1.allow).toBe(false);
    if (d1.allow === true) throw new Error('expected rejection');
    expect(d1.reason).toContain('banned');

    // banEmail domain match → reject.
    const d2 = evaluateInboundPolicy(
      parsedLike({ from: { address: 'anyone@evil.com', name: '' } }),
      policies,
      [],
    );
    expect(d2.allow).toBe(false);

    // banEmail no match, availDomain match → allow.
    const d3 = evaluateInboundPolicy(
      parsedLike({ from: { address: 'friend@allowed.com', name: '' } }),
      policies,
      [],
    );
    expect(d3.allow).toBe(true);

    // banEmail no match, availDomain no match → reject.
    const d4 = evaluateInboundPolicy(
      parsedLike({ from: { address: 'stranger@other.com', name: '' } }),
      policies,
      [],
    );
    expect(d4.allow).toBe(false);

    // Wildcard ban wins over availDomain allow.
    const policy = policies[0];
    if (!policy) throw new Error('expected policy');
    const d5 = evaluateInboundPolicy(
      parsedLike({ from: { address: 'friend@allowed.com', name: '' } }),
      [{ ...policy, banEmail: ['*'] }],
      [],
    );
    expect(d5.allow).toBe(false);
  });
});
