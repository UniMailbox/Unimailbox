// packages/test-kit/src/migrationsDb.worker.test.ts — CAP-004.
//
// Runs in the worker pool (vitest.workers.config.ts) against the real
// D1 binding sourced from apps/worker/wrangler.jsonc. Proves:
//   R-DATA-001 — users.email lookup is case-insensitive.
//   R-DATA-004 — PRAGMA foreign_keys is ON on the migrated DB.
//   R-AUTH-002 — users.status CHECK constraint rejects 'unknown'.
//   R-AUTH-006 — users.password_iterations CHECK rejects below-floor
//                values (F4 / ADR-006; rule id allocated by the
//                implementer — see D-CAP-004-A in the ledger).
//   ADR-006    — users.password_* columns are present.
import { beforeEach, describe, expect, it } from 'vitest';
import { migrationsDb } from './migrationsDb';

const NEW_UUID = '00000000-0000-4000-8000-000000000001';
const NOW = '2026-01-01 00:00:00';
const SALT_HEX = '00';
const HASH_HEX = '11';

describe('migrationsDb (worker pool)', () => {
  // F10 / M3 / M6: each test starts from a clean DB. applyD1Migrations
  // is idempotent on the schema but the row data persists across calls,
  // so without reset() a later test that picks a colliding email/UUID
  // would fail with UNIQUE. cloudflare:test's reset() also clears R2,
  // KV and DO state in this isolate; acceptable because this fixture
  // only touches D1.
  beforeEach(async () => {
    const { reset } = await import('cloudflare:test');
    await reset();
  });

  it('R-DATA-004: PRAGMA foreign_keys is ON', async () => {
    const db = await migrationsDb();
    const row = await db.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
  });

  it('ADR-006: users has the four PBKDF2 columns', async () => {
    const db = await migrationsDb();
    const cols = await db.prepare("SELECT name FROM pragma_table_info('users') WHERE name LIKE 'password_%'").all<{ name: string }>();
    const names = cols.results.map((r) => r.name).sort();
    expect(names).toEqual(['password_algorithm', 'password_hash', 'password_iterations', 'password_salt']);
  });

  it('R-AUTH-002: users.status CHECK rejects unknown values', async () => {
    const db = await migrationsDb();
    await expect(
      db
        .prepare(
          `INSERT INTO users (id, email, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, 'pbkdf2-sha256', 600000, x'${SALT_HEX}', x'${HASH_HEX}', ?, ?)`,
        )
        .bind(NEW_UUID, 'bad@example.test', 'unknown', NOW, NOW)
        .run(),
    ).rejects.toThrowError(/CHECK constraint failed: status IN .*active.*banned.*deleted/);
  });

  // F4 — confirms the password_iterations CHECK (>= 100000) at the
  // D1 layer. The application layer (CAP-019) raises the floor to
  // ADR-006's 600000; the SQL floor is the lower bound.
  it('R-AUTH-006: users.password_iterations CHECK rejects below-floor values', async () => {
    const db = await migrationsDb();
    await expect(
      db
        .prepare(
          `INSERT INTO users (id, email, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
           VALUES (?, ?, 'active', 'pbkdf2-sha256', 99999, x'${SALT_HEX}', x'${HASH_HEX}', ?, ?)`,
        )
        .bind(NEW_UUID, 'below-floor@example.test', NOW, NOW)
        .run(),
    ).rejects.toThrowError(/CHECK constraint failed: password_iterations >= 100000/);
  });

  it('R-DATA-001: users.email lookup is case-insensitive on UNIQUE NOCASE', async () => {
    const db = await migrationsDb();
    const id1 = '00000000-0000-4000-8000-000000000010';
    const id2 = '00000000-0000-4000-8000-000000000011';
    const insert = db.prepare(
      `INSERT INTO users (id, email, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, 'active', 'pbkdf2-sha256', 600000, x'${SALT_HEX}', x'${HASH_HEX}', ?, ?)`,
    );
    await insert.bind(id1, 'Mixed@Case.test', NOW, NOW).run();
    // Inserting the same address in a different case must fail.
    await expect(
      insert.bind(id2, 'MIXED@case.test', NOW, NOW).run(),
    ).rejects.toThrow(/UNIQUE/);
    // And a case-insensitive lookup finds the original row.
    const row = await db.prepare('SELECT id FROM users WHERE email = ?').bind('mixed@CASE.test').first<{ id: string }>();
    expect(row?.id).toBe(id1);
  });
});