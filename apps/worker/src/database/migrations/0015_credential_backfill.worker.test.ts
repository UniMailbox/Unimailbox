// apps/worker/src/database/migrations/0015_credential_backfill.worker.test.ts
// — CAP-042 (AC 15) credential-backfill migration.
//
// Worker-pool test against the real D1 binding. Proves the AC 15
// acceptance matrix against the canonical `users` table and the
// `auth_accounts` table the migration writes to:
//
//   1. Every canonical user with ADR-006 credentials and
//      `status != 'deleted'` produced exactly one backfilled row.
//   2. Banned, deleted, non-PBKDF2, and non-canonical-iteration users
//      did NOT produce `auth_accounts` rows (R-AUTH-002,
//      R-AUTH-006).
//   3. No duplicate `(issuer, account_id)` pairs.
//   4. No orphan `auth_accounts` rows (`user_id` references a real
//      `users.id`).
//   5. The envelope matches Better Auth's canonical regex.
//   6. Re-running the INSERT OR IGNORE statement produces no new rows
//      (the backfill is structurally idempotent).
//   7. The migration is idempotent at the runner level too: the
//      second `migrationsDb()` call is a no-op against the migration
//      tracking table.
//
// The test uses `migrationsDb({ through: '0014_better_auth_substrate' })`
// to pause at 0014, seeds the legacy rows with the canonical
// `sqliteUtcTextDate` format, then calls `migrationsDb({ through:
// '0015_credential_backfill' })` to apply the backfill. Per
// `.claude/rules/testing.md` §Mocking, the D1 binding is real —
// `applyD1Migrations` runs inside workerd against the wrangler
// test-config bindings.
import { beforeEach, describe, expect, it } from 'vitest';
import { migrationsDb } from '@unimailbox/test-kit';

const SALT_BYTES = new Uint8Array(16);
const HASH_BYTES = new Uint8Array(32);
const NOW_TEXT = '2026-01-01 00:00:00';

// Five user rows exercising every branch of the backfill predicate:
//
//   1. legacy-active        — should be backfilled (active, PBKDF2, 600k)
//   2. legacy-banned        — should be SKIPPED (R-AUTH-002)
//   3. legacy-deleted       — should be SKIPPED (R-AUTH-002)
//   4. legacy-non-pbkdf2    — should be SKIPPED (defence against drift)
//   5. legacy-non-canonical — should be SKIPPED (defence against drift)
//
// All five rows are seeded BEFORE the 0015 migration runs, so the
// backfill reads them as if they were pre-CAP-042 production data.
const LEGACY_ACTIVE = '00000000-0000-4000-8000-00000000ba51';
const LEGACY_BANNED = '00000000-0000-4000-8000-00000000ba52';
const LEGACY_DELETED = '00000000-0000-4000-8000-00000000ba53';
const LEGACY_NON_PBKDF2 = '00000000-0000-4000-8000-00000000ba54';
const LEGACY_NON_CANONICAL = '00000000-0000-4000-8000-00000000ba55';

interface SeedUser {
  readonly id: string;
  readonly email: string;
  readonly status: 'active' | 'banned' | 'deleted';
  readonly algorithm: string;
  readonly iterations: number;
}

const SEED_USERS: readonly SeedUser[] = [
  {
    id: LEGACY_ACTIVE,
    email: 'legacy-active@example.test',
    status: 'active',
    algorithm: 'pbkdf2-sha256',
    iterations: 600_000,
  },
  {
    id: LEGACY_BANNED,
    email: 'legacy-banned@example.test',
    status: 'banned',
    algorithm: 'pbkdf2-sha256',
    iterations: 600_000,
  },
  {
    id: LEGACY_DELETED,
    email: 'legacy-deleted@example.test',
    status: 'deleted',
    algorithm: 'pbkdf2-sha256',
    iterations: 600_000,
  },
  {
    id: LEGACY_NON_PBKDF2,
    email: 'legacy-non-pbkdf2@example.test',
    status: 'active',
    algorithm: 'pending',
    iterations: 600_000,
  },
  {
    id: LEGACY_NON_CANONICAL,
    email: 'legacy-non-canonical@example.test',
    status: 'active',
    algorithm: 'pbkdf2-sha256',
    iterations: 100_000,
  },
];

async function seedLegacyUsers(db: D1Database): Promise<void> {
  await db.batch(
    SEED_USERS.map((user) =>
      db
        .prepare(
          `INSERT INTO users (
             id, email, display_name, status,
             password_algorithm, password_iterations, password_salt, password_hash,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          user.id,
          user.email,
          // display_name is non-null per 0014 — the 0014 migration's
          // UPDATE pass already backfilled any nulls the canonical
          // DDL allowed; here we mirror the post-0014 state so the
          // backfill isn't racing the trigger.
          user.email.split('@')[0] ?? user.email,
          user.status,
          user.algorithm,
          user.iterations,
          SALT_BYTES,
          HASH_BYTES,
          NOW_TEXT,
          NOW_TEXT,
        ),
    ),
  );
}

// The backfill INSERT statement. Re-running it directly (without the
// migration runner's `d1_migrations` bookkeeping) proves the SQL is
// idempotent on its own — the unique index `auth_accounts_issuer_account_id_unique`
// is the structural guarantee.
const BACKFILL_INSERT_SQL = `
  INSERT OR IGNORE INTO auth_accounts (
    id, issuer, account_id, provider_id, user_id, password,
    created_at, updated_at
  )
  SELECT
    'cap042-backfill-' || u.id,
    'local:credential',
    u.id,
    'credential',
    u.id,
    'pbkdf2-sha256$' || u.password_iterations || '$' ||
      lower(hex(u.password_salt)) || '$' ||
      lower(hex(u.password_hash)),
    CAST((julianday(u.created_at) - 2440587.5) * 86400000 AS INTEGER),
    CAST((julianday(u.updated_at) - 2440587.5) * 86400000 AS INTEGER)
  FROM users AS u
  WHERE u.password_algorithm = 'pbkdf2-sha256'
    AND u.password_iterations = 600000
    AND u.status NOT IN ('banned', 'deleted');
`;

describe('CAP-042 AC 15 — 0015_credential_backfill', () => {
  beforeEach(async () => {
    const { reset } = await import('cloudflare:test');
    await reset();
  });

  it('seeds five legacy users at the 0014 boundary', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);

    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM users WHERE id LIKE ?')
      .bind('00000000-0000-4000-8000-00000000ba5%')
      .first<{ n: number }>();
    expect(row?.n).toBe(SEED_USERS.length);

    // Before the migration runs, no auth_accounts row exists for any
    // of these users. The backfill is the only writer.
    const beforeRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM auth_accounts`)
      .first<{ n: number }>();
    expect(beforeRow?.n).toBe(0);
  });

  it('AC 15.1 — every active PBKDF2 user produced exactly one backfill row', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    const backfill = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_accounts
           WHERE issuer = 'local:credential'
             AND provider_id = 'credential'
             AND id LIKE 'cap042-backfill-%'`,
      )
      .first<{ n: number }>();
    expect(backfill?.n).toBe(1);

    const row = await db
      .prepare(
        `SELECT id, user_id, password FROM auth_accounts
           WHERE id = ?`,
      )
      .bind(`cap042-backfill-${LEGACY_ACTIVE}`)
      .first<{ id: string; user_id: string; password: string }>();
    expect(row?.id).toBe(`cap042-backfill-${LEGACY_ACTIVE}`);
    expect(row?.user_id).toBe(LEGACY_ACTIVE);
    // The envelope shape the Better Auth password adapter verifies.
    expect(row?.password).toMatch(/^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  });

  it('AC 15.2 — banned users did NOT produce an auth_accounts row (R-AUTH-002)', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM auth_accounts WHERE user_id = ?`)
      .bind(LEGACY_BANNED)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('AC 15.3 — deleted users did NOT produce an auth_accounts row (R-AUTH-002)', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM auth_accounts WHERE user_id = ?`)
      .bind(LEGACY_DELETED)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('AC 15.4 — non-PBKDF2 users did NOT produce an auth_accounts row', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM auth_accounts WHERE user_id = ?`)
      .bind(LEGACY_NON_PBKDF2)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('AC 15.5 — non-canonical iterations did NOT produce an auth_accounts row', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM auth_accounts WHERE user_id = ?`)
      .bind(LEGACY_NON_CANONICAL)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('AC 15.6 — no duplicate (issuer, account_id) pairs', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT issuer, account_id, COUNT(*) AS hits
             FROM auth_accounts
             GROUP BY issuer, account_id
             HAVING hits > 1
         )`,
      )
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('AC 15.7 — every auth_accounts.user_id references a real users.id (no orphans)', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_accounts AS a
            LEFT JOIN users AS u ON u.id = a.user_id
            WHERE u.id IS NULL`,
      )
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("AC 15.8 — the envelope matches Better Auth's canonical regex", async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    // D1 SQLite does not implement a `REGEXP` function. The canonical
    // envelope shape is decomposed into structural pieces the
    // application's verifier enforces:
    //   prefix = `pbkdf2-sha256$600000$`
    //   total length = 118 chars
    //   salt segment (chars 22..53) is 32 lowercase hex
    //   hash segment (chars 54..117) is 64 lowercase hex
    //   `$` separator at position 54
    //   no trailing characters
    const prefix = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_accounts
           WHERE provider_id = 'credential'
             AND id LIKE 'cap042-backfill-%'
             AND password NOT LIKE 'pbkdf2-sha256$600000$%'`,
      )
      .first<{ n: number }>();
    expect(prefix?.n).toBe(0);

    const length = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_accounts
           WHERE provider_id = 'credential'
             AND id LIKE 'cap042-backfill-%'
             AND length(password) <> 118`,
      )
      .first<{ n: number }>();
    expect(length?.n).toBe(0);

    const salt = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_accounts
           WHERE provider_id = 'credential'
             AND id LIKE 'cap042-backfill-%'
             AND substr(password, 22, 32) GLOB '*[^0-9a-f]*'`,
      )
      .first<{ n: number }>();
    expect(salt?.n).toBe(0);

    const hash = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_accounts
           WHERE provider_id = 'credential'
             AND id LIKE 'cap042-backfill-%'
             AND substr(password, 55, 64) GLOB '*[^0-9a-f]*'`,
      )
      .first<{ n: number }>();
    expect(hash?.n).toBe(0);

    const separator = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_accounts
           WHERE provider_id = 'credential'
             AND id LIKE 'cap042-backfill-%'
             AND substr(password, 54, 1) <> '$'`,
      )
      .first<{ n: number }>();
    expect(separator?.n).toBe(0);
  });

  it('AC 15.9 — re-running the backfill INSERT statement is a no-op (repeat-safe)', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    const before = await db
      .prepare(`SELECT COUNT(*) AS n FROM auth_accounts`)
      .first<{ n: number }>();
    const beforeCount = before?.n ?? 0;

    // Re-run the INSERT OR IGNORE statement directly. The migration
    // runner would skip 0015 because `d1_migrations` already records
    // it; calling `db.batch` here exercises the SQL idempotency on
    // its own, which is the property that matters when an operator
    // re-runs the backfill by hand. `db.exec()` only accepts a
    // single statement per D1's binding, so we prepare and batch.
    await db.batch([db.prepare(BACKFILL_INSERT_SQL)]);

    const after = await db
      .prepare(`SELECT COUNT(*) AS n FROM auth_accounts`)
      .first<{ n: number }>();
    expect(after?.n).toBe(beforeCount);
  });

  it('AC 15.10 — calling migrationsDb() twice is a no-op against the tracking table', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });
    // Second call must not throw, must not change row counts.
    await migrationsDb({ through: '0015_credential_backfill' });

    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM d1_migrations WHERE name = '0015_credential_backfill.sql'`,
      )
      .first<{ n: number }>();
    expect(row?.n).toBe(1);

    const accounts = await db
      .prepare(`SELECT COUNT(*) AS n FROM auth_accounts`)
      .first<{ n: number }>();
    expect(accounts?.n).toBe(1);
  });

  it('AC 15.11 — backfill timestamps are Unix-ms integers derived from users.created_at', async () => {
    const db = await migrationsDb({ through: '0014_better_auth_substrate' });
    await seedLegacyUsers(db);
    await migrationsDb({ through: '0015_credential_backfill' });

    const row = await db
      .prepare(`SELECT created_at, updated_at FROM auth_accounts WHERE user_id = ?`)
      .bind(LEGACY_ACTIVE)
      .first<{ created_at: number; updated_at: number }>();
    expect(typeof row?.created_at).toBe('number');
    expect(typeof row?.updated_at).toBe('number');
    // 2026-01-01T00:00:00Z → 1_767_225_600_000ms. The conversion
    // drops the sub-second component because the canonical text
    // format includes `00:00:00` (no fractional seconds), so the
    // expected Unix-ms matches the UTC second boundary.
    expect(row?.created_at).toBe(1_767_225_600_000);
    expect(row?.updated_at).toBe(1_767_225_600_000);
  });
});
