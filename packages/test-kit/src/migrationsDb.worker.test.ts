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
import { CURRENT_SCHEMA_VERSION as CONTRACT_SCHEMA_VERSION } from '@unimailbox/contracts';
import { migrationsDb } from './migrationsDb';

const NEW_UUID = '00000000-0000-4000-8000-000000000001';
const NOW = '2026-01-01 00:00:00';
const SALT_HEX = '00';
const HASH_HEX = '11';

async function insertUser(
  db: D1Database,
  id: string,
  email: string,
  displayName: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (
         id, email, display_name, status, password_algorithm, password_iterations,
         password_salt, password_hash, created_at, updated_at
       ) VALUES (?, ?, ?, 'active', 'pbkdf2-sha256', 600000, x'${SALT_HEX}', x'${HASH_HEX}', ?, ?)`,
    )
    .bind(id, email, displayName, NOW, NOW)
    .run();
}

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
    const cols = await db
      .prepare("SELECT name FROM pragma_table_info('users') WHERE name LIKE 'password_%'")
      .all<{ name: string }>();
    const names = cols.results.map((r) => r.name).sort();
    expect(names).toEqual([
      'password_algorithm',
      'password_hash',
      'password_iterations',
      'password_salt',
    ]);
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
    await expect(insert.bind(id2, 'MIXED@case.test', NOW, NOW).run()).rejects.toThrow(/UNIQUE/);
    // And a case-insensitive lookup finds the original row.
    const row = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind('mixed@CASE.test')
      .first<{ id: string }>();
    expect(row?.id).toBe(id1);
  });

  it('CAP-042: fresh 0014 schema has the exact auth shapes, indexes, cascades, and tracking row', async () => {
    const db = await migrationsDb();
    const tableNames = await db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('auth_accounts', 'auth_sessions', 'auth_verifications')
         ORDER BY name`,
      )
      .all<{ name: string }>();
    expect(tableNames.results.map((row) => row.name)).toEqual([
      'auth_accounts',
      'auth_sessions',
      'auth_verifications',
    ]);

    const exactColumns = async (table: string): Promise<string[]> => {
      const result = await db
        .prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)
        .all<{ name: string }>();
      return result.results.map((row) => row.name);
    };
    expect(await exactColumns('auth_accounts')).toEqual([
      'id',
      'issuer',
      'account_id',
      'provider_id',
      'user_id',
      'access_token',
      'refresh_token',
      'id_token',
      'access_token_expires_at',
      'refresh_token_expires_at',
      'scope',
      'password',
      'created_at',
      'updated_at',
    ]);
    expect(await exactColumns('auth_sessions')).toEqual([
      'id',
      'token',
      'user_id',
      'expires_at',
      'ip_address',
      'user_agent',
      'created_at',
      'updated_at',
    ]);
    expect(await exactColumns('auth_verifications')).toEqual([
      'id',
      'identifier',
      'value',
      'expires_at',
      'created_at',
      'updated_at',
    ]);

    const userColumns = await db
      .prepare(
        `SELECT name, type, [notnull] AS required, dflt_value
         FROM pragma_table_info('users')
         WHERE name IN ('email_verified', 'image') ORDER BY name`,
      )
      .all<{ name: string; type: string; required: number; dflt_value: string | null }>();
    expect(userColumns.results).toEqual([
      { name: 'email_verified', type: 'INTEGER', required: 1, dflt_value: '0' },
      { name: 'image', type: 'TEXT', required: 0, dflt_value: null },
    ]);

    const indexes = await db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'auth_%' ORDER BY name`,
      )
      .all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual([
      'auth_accounts_issuer_account_id_unique',
      'auth_accounts_user_id_idx',
      'auth_sessions_token_unique',
      'auth_sessions_user_id_idx',
      'auth_verifications_identifier_idx',
    ]);

    for (const table of ['auth_accounts', 'auth_sessions']) {
      const fk = await db
        .prepare(`SELECT [table], [from], [to], on_delete FROM pragma_foreign_key_list('${table}')`)
        .first<{ table: string; from: string; to: string; on_delete: string }>();
      expect(fk).toEqual({ table: 'users', from: 'user_id', to: 'id', on_delete: 'CASCADE' });
    }

    const tracking = await db
      .prepare(`SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?`)
      .bind('0014_better_auth_substrate.sql')
      .first<{ count: number }>();
    expect(tracking?.count).toBe(1);
    expect(CONTRACT_SCHEMA_VERSION).toBe('0017');
  });

  it('CAP-042: upgrading 0013 to 0014 preserves canonical IDs, passwords, and legacy sessions', async () => {
    const db = await migrationsDb({ through: '0013_webhook_delivery_message_index' });
    const nullId = '00000000-0000-4000-8000-000000001401';
    const blankId = '00000000-0000-4000-8000-000000001402';
    await insertUser(db, nullId, 'legacy-null@example.test');
    await insertUser(db, blankId, 'legacy-blank@example.test', '   ');
    await db
      .prepare(
        `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
         VALUES ('legacy-session-0014', ?, 'legacy-refresh-hash', 1999999999, ?)`,
      )
      .bind(nullId, NOW)
      .run();

    await migrationsDb();

    const users = await db
      .prepare(
        `SELECT id, display_name, email_verified, image,
                length(password_salt) AS salt_length, length(password_hash) AS hash_length
         FROM users WHERE id IN (?, ?) ORDER BY id`,
      )
      .bind(nullId, blankId)
      .all<{
        id: string;
        display_name: string;
        email_verified: number;
        image: string | null;
        salt_length: number;
        hash_length: number;
      }>();
    expect(users.results).toEqual([
      {
        id: nullId,
        display_name: 'legacy-null',
        email_verified: 0,
        image: null,
        salt_length: 1,
        hash_length: 1,
      },
      {
        id: blankId,
        display_name: 'legacy-blank',
        email_verified: 0,
        image: null,
        salt_length: 1,
        hash_length: 1,
      },
    ]);
    const legacySession = await db
      .prepare(`SELECT id, user_id FROM sessions WHERE id = 'legacy-session-0014'`)
      .first<{ id: string; user_id: string }>();
    expect(legacySession).toEqual({ id: 'legacy-session-0014', user_id: nullId });
  });

  it('CAP-042: repeat migration is a no-op and unknown boundaries fail closed', async () => {
    const db = await migrationsDb();
    await db
      .prepare(
        `INSERT INTO auth_verifications
         (id, identifier, value, expires_at, created_at, updated_at)
         VALUES ('repeat-proof', 'repeat@example.test', 'value', 4, 2, 1)`,
      )
      .run();

    await migrationsDb();

    const tracking = await db
      .prepare(`SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?`)
      .bind('0014_better_auth_substrate.sql')
      .first<{ count: number }>();
    const proof = await db
      .prepare(`SELECT value FROM auth_verifications WHERE id = 'repeat-proof'`)
      .first<{ value: string }>();
    expect(tracking?.count).toBe(1);
    expect(proof?.value).toBe('value');
    await expect(migrationsDb({ through: '9999_unknown' })).rejects.toThrow(
      'Unknown migration boundary: 9999_unknown',
    );
  });

  it('CAP-042: insert and update triggers normalize future null and blank display names', async () => {
    const db = await migrationsDb();
    const id = '00000000-0000-4000-8000-000000001403';
    await insertUser(db, id, 'insert-prefix@example.test');
    const inserted = await db
      .prepare('SELECT display_name FROM users WHERE id = ?')
      .bind(id)
      .first<{ display_name: string }>();
    expect(inserted?.display_name).toBe('insert-prefix');

    await db
      .prepare(
        `UPDATE users SET email = 'updated-prefix@example.test', display_name = '  ' WHERE id = ?`,
      )
      .bind(id)
      .run();
    const updated = await db
      .prepare('SELECT display_name FROM users WHERE id = ?')
      .bind(id)
      .first<{ display_name: string }>();
    expect(updated?.display_name).toBe('updated-prefix');
  });

  it('R-AUTH-003: the eleventh auth session evicts only the deterministic oldest row', async () => {
    const db = await migrationsDb();
    const userId = '00000000-0000-4000-8000-000000001404';
    await insertUser(db, userId, 'sessions@example.test', 'Sessions');
    for (let n = 1; n <= 11; n += 1) {
      await db
        .prepare(
          `INSERT INTO auth_sessions
           (id, token, user_id, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, 999999, ?, ?)`,
        )
        .bind(`session-${n.toString().padStart(2, '0')}`, `token-${n}`, userId, n, n)
        .run();
    }
    const rows = await db
      .prepare(`SELECT id FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC, id DESC`)
      .bind(userId)
      .all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual([
      'session-11',
      'session-10',
      'session-09',
      'session-08',
      'session-07',
      'session-06',
      'session-05',
      'session-04',
      'session-03',
      'session-02',
    ]);
  });

  it('R-AUTH-005: changing a password revokes only the owning user auth sessions', async () => {
    const db = await migrationsDb();
    const targetId = '00000000-0000-4000-8000-000000001405';
    const otherId = '00000000-0000-4000-8000-000000001406';
    await insertUser(db, targetId, 'target@example.test', 'Target');
    await insertUser(db, otherId, 'other@example.test', 'Other');
    await db.batch([
      db
        .prepare(
          `INSERT INTO auth_accounts
           (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at)
           VALUES ('target-account', 'local:credential', ?, 'credential', ?, 'before', 1, 1)`,
        )
        .bind(targetId, targetId),
      db
        .prepare(
          `INSERT INTO auth_sessions
           (id, token, user_id, expires_at, created_at, updated_at)
           VALUES ('target-session', 'target-token', ?, 9, 1, 1)`,
        )
        .bind(targetId),
      db
        .prepare(
          `INSERT INTO auth_sessions
           (id, token, user_id, expires_at, created_at, updated_at)
           VALUES ('other-session', 'other-token', ?, 9, 1, 1)`,
        )
        .bind(otherId),
    ]);

    await db
      .prepare(`UPDATE auth_accounts SET password = 'after' WHERE id = 'target-account'`)
      .run();
    const rows = await db.prepare('SELECT user_id FROM auth_sessions ORDER BY user_id').all<{
      user_id: string;
    }>();
    expect(rows.results.map((row) => row.user_id)).toEqual([otherId]);
  });

  it('CAP-042: exhausted invite aborts the D1 batch and rolls back its preceding user write', async () => {
    const db = await migrationsDb();
    const creatorId = '00000000-0000-4000-8000-000000001407';
    const rolledBackId = '00000000-0000-4000-8000-000000001408';
    await insertUser(db, creatorId, 'creator@example.test', 'Creator');
    await db
      .prepare(
        `INSERT INTO registration_keys
         (id, code_hash, role_id, max_uses, used_count, created_by, created_at)
         VALUES ('exhausted-key-0014', 'exhausted-code-0014', NULL, 1, 1, ?, ?)`,
      )
      .bind(creatorId, NOW)
      .run();

    const userInsert = db
      .prepare(
        `INSERT INTO users
         (id, email, display_name, status, password_algorithm, password_iterations,
          password_salt, password_hash, created_at, updated_at)
         VALUES (?, 'rollback@example.test', 'Rollback', 'active', 'pbkdf2-sha256',
                 600000, x'00', x'11', ?, ?)`,
      )
      .bind(rolledBackId, NOW, NOW);
    const overuse = db.prepare(
      `UPDATE registration_keys SET used_count = used_count + 1 WHERE id = 'exhausted-key-0014'`,
    );
    await expect(db.batch([userInsert, overuse])).rejects.toThrow(
      /CAP042_REGISTRATION_KEY_EXHAUSTED/,
    );
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(rolledBackId).first();
    const key = await db
      .prepare(`SELECT used_count FROM registration_keys WHERE id = 'exhausted-key-0014'`)
      .first<{ used_count: number }>();
    expect(user).toBeNull();
    expect(key?.used_count).toBe(1);
  });

  it('CAP-042: account/session uniqueness and canonical-user cascades are enforced by D1', async () => {
    const db = await migrationsDb();
    const ownerId = '00000000-0000-4000-8000-000000001409';
    const otherId = '00000000-0000-4000-8000-000000001410';
    await insertUser(db, ownerId, 'owner@example.test', 'Owner');
    await insertUser(db, otherId, 'unique-other@example.test', 'Other');
    const accountInsert = db.prepare(
      `INSERT INTO auth_accounts
       (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES (?, 'local:credential', 'shared-account-id', 'credential', ?, 'password', 1, 1)`,
    );
    await accountInsert.bind('owner-account', ownerId).run();
    await expect(accountInsert.bind('duplicate-account', otherId).run()).rejects.toThrow(/UNIQUE/);

    const sessionInsert = db.prepare(
      `INSERT INTO auth_sessions
       (id, token, user_id, expires_at, created_at, updated_at)
       VALUES (?, 'shared-token', ?, 9, 1, 1)`,
    );
    await sessionInsert.bind('owner-session', ownerId).run();
    await expect(sessionInsert.bind('duplicate-session', otherId).run()).rejects.toThrow(/UNIQUE/);

    await db.prepare('DELETE FROM users WHERE id = ?').bind(ownerId).run();
    const accountCount = await db
      .prepare(`SELECT COUNT(*) AS count FROM auth_accounts WHERE user_id = ?`)
      .bind(ownerId)
      .first<{ count: number }>();
    const sessionCount = await db
      .prepare(`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?`)
      .bind(ownerId)
      .first<{ count: number }>();
    expect(accountCount?.count).toBe(0);
    expect(sessionCount?.count).toBe(0);
  });
});
