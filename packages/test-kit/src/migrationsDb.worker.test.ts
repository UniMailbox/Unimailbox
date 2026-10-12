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
import aiConfigurationSql from '../../../migrations/0034_ai_configuration.sql?raw';
import aiConfigurationVerification from '../../../migrations/0034_ai_configuration.verify.sql?raw';
import settingsRevisionVerification from '../../../migrations/0025_system_settings_revision.verify.sql?raw';
import scheduledSendVerification from '../../../migrations/0033_scheduled_send.verify.sql?raw';
import attachmentCleanupVerification from '../../../migrations/0032_attachment_cleanup.verify.sql?raw';

const NEW_UUID = '00000000-0000-4000-8000-000000000001';
const NOW = '2026-01-01 00:00:00';
const SALT_HEX = '00';
const HASH_HEX = '11';
const AI_MIGRATION_STATEMENTS = aiConfigurationSql
  .replace(/^--.*$/gm, '')
  .split(';')
  .filter((sql) => sql.trim());

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

  it('0034 seeds disabled AI and prevents incomplete credentials or invalid revisions', async () => {
    const db = await migrationsDb({ through: '0033_scheduled_send' });
    // Deployment executes raw SQL; applyD1Migrations itself adds tracking rows
    // and would mask a missing registration statement in the migration.
    await db.batch(AI_MIGRATION_STATEMENTS.map((sql) => db.prepare(sql)));
    for (const sql of aiConfigurationVerification.split(';').filter((sql) => sql.trim())) {
      const rows = await db.prepare(sql).all<{ assertion: string; pass: number }>();
      for (const row of rows.results) expect(row.pass, row.assertion).toBe(1);
    }
    expect(await db.prepare(aiConfigurationVerification.split(';')[0] ?? '').first()).toEqual({
      assertion: '0034_ai_configuration_row',
      pass: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT json_extract(configuration, '$.enabled') AS enabled, revision, ciphertext FROM ai_configuration WHERE id='system'",
        )
        .first(),
    ).toEqual({ enabled: 0, revision: 0, ciphertext: null });
    await expect(
      db.prepare("UPDATE ai_configuration SET revision = -1 WHERE id='system'").run(),
    ).rejects.toThrow();
    await expect(
      db.prepare("UPDATE ai_configuration SET ciphertext = X'01' WHERE id='system'").run(),
    ).rejects.toThrow();
  });

  it('0034 resumes a partial raw deployment and preserves configured state on replay', async () => {
    const db = await migrationsDb({ through: '0033_scheduled_send' });
    const statements = AI_MIGRATION_STATEMENTS;
    await db.batch(statements.slice(0, -1).map((sql) => db.prepare(sql)));
    await db.prepare("UPDATE ai_configuration SET revision = 1 WHERE id='system'").run();
    for (let attempt = 0; attempt < 2; attempt++) {
      await db.batch(statements.map((sql) => db.prepare(sql)));
    }
    expect(
      await db.prepare("SELECT revision FROM ai_configuration WHERE id='system'").first(),
    ).toEqual({ revision: 1 });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM d1_migrations WHERE name='0034_ai_configuration.sql'",
        )
        .first(),
    ).toEqual({ count: 1 });
  });

  it('0033 adds nullable schedule fields and preserves existing outbox rows', async () => {
    const db = await migrationsDb({ through: '0032_attachment_cleanup' });
    const now = '2026-01-01 00:00:00';
    await db.batch([
      db
        .prepare(
          `INSERT INTO encrypted_credentials(id,name,version,ciphertext,iv,auth_tag,created_at,updated_at) VALUES('credential','schedule-upgrade',1,x'00',zeroblob(12),zeroblob(16),?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO provider_connections(id,provider_key,label,credential_id,status,created_at,updated_at) VALUES('connection','brevo','Upgrade','credential','active',?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO messages(id,from_address,status,created_at,updated_at) VALUES('message','upgrade@example.com','queued',?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO outbound_jobs(id,message_id,provider_connection_id,status,created_at,updated_at) VALUES('job','message','connection','queued',?,?)`,
        )
        .bind(now, now),
    ]);
    await migrationsDb();
    expect(
      await db
        .prepare(
          `SELECT status,scheduled_at,mailbox_id,schedule_revision FROM outbound_jobs WHERE id='job'`,
        )
        .first(),
    ).toEqual({ status: 'queued', scheduled_at: null, mailbox_id: null, schedule_revision: 0 });
    for (const sql of scheduledSendVerification
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const results = await db.prepare(sql).all<{ pass?: number }>();
      for (const row of results.results) expect(row.pass).toBe(1);
    }
  });

  it('0032 preserves existing expired uploads and leaves cleanup retryable on upgrade', async () => {
    const db = await migrationsDb({ through: '0031_user_preferences' });
    const actor = crypto.randomUUID();
    const domain = crypto.randomUUID();
    const mailbox = crypto.randomUUID();
    const upload = crypto.randomUUID();
    await insertUser(db, actor, 'cleanup-upgrade@example.com');
    await db.batch([
      db
        .prepare(
          "INSERT INTO managed_domains (id,name,status) VALUES (?,'cleanup.example.com','active')",
        )
        .bind(domain),
      db
        .prepare(
          "INSERT INTO mailboxes (id,domain_id,owner_user_id,local_part,status) VALUES (?,?,?,'cleanup','active')",
        )
        .bind(mailbox, domain, actor),
      db
        .prepare(
          `INSERT INTO attachment_uploads (id,owner_user_id,mailbox_id,kv_key,filename,content_type,size_bytes,status,expires_at,created_at)
        VALUES (?,?,?,?,'old.txt','text/plain',1,'expired',?,?)`,
        )
        .bind(upload, actor, mailbox, `attachment:${upload}`, NOW, NOW),
    ]);
    const original = await db
      .prepare('SELECT * FROM attachment_uploads WHERE id=?')
      .bind(upload)
      .first();
    await migrationsDb();
    expect(
      await db.prepare('SELECT * FROM attachment_uploads WHERE id=?').bind(upload).first(),
    ).toEqual({ ...original, cleanup_completed_at: null });
    for (const sql of attachmentCleanupVerification
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)) {
      const rows = await db.prepare(sql).all<{ pass: number }>();
      for (const row of rows.results) expect(row.pass).toBe(1);
    }
    await migrationsDb();
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM d1_migrations WHERE name='0032_attachment_cleanup.sql'",
        )
        .first(),
    ).toEqual({ count: 1 });
  });

  it('0030 preserves published capability metadata and usage foreign keys while raising the storage ceiling', async () => {
    const db = await migrationsDb({ through: '0029_editor_assets' });
    const actor = crypto.randomUUID();
    const domain = crypto.randomUUID();
    const mailbox = crypto.randomUUID();
    const asset = crypto.randomUUID();
    const resource = crypto.randomUUID();
    await insertUser(db, actor, 'editor-upgrade@example.com');
    await db.batch([
      db
        .prepare(
          "INSERT INTO managed_domains (id,name,status) VALUES (?,'upgrade.example.com','active')",
        )
        .bind(domain),
      db
        .prepare(
          "INSERT INTO mailboxes (id,domain_id,owner_user_id,local_part,status) VALUES (?,?,?,'upgrade','active')",
        )
        .bind(mailbox, domain, actor),
      db
        .prepare(
          "INSERT INTO editor_assets (id,owner_user_id,mailbox_id,secret_hash,object_key,filename,content_type,size_bytes,kind,created_at,expires_at) VALUES (?,?,?,'hash','unchanged-key','file.pdf','application/pdf',12,'file',?,?)",
        )
        .bind(asset, actor, mailbox, NOW, NOW),
      db
        .prepare(
          "INSERT INTO editor_asset_usages (asset_id,resource_type,resource_id) VALUES (?,'message',?)",
        )
        .bind(asset, resource),
    ]);
    const original = await db.prepare('SELECT * FROM editor_assets WHERE id=?').bind(asset).first();
    await migrationsDb();
    expect(await db.prepare('SELECT * FROM editor_assets WHERE id=?').bind(asset).first()).toEqual(
      original,
    );
    expect(
      await db.prepare('SELECT * FROM editor_asset_usages WHERE asset_id=?').bind(asset).first(),
    ).toEqual({ asset_id: asset, resource_type: 'message', resource_id: resource });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await expect(
      db.prepare('DELETE FROM editor_assets WHERE id=?').bind(asset).run(),
    ).rejects.toThrow();
    await db
      .prepare('UPDATE editor_assets SET size_bytes=? WHERE id=?')
      .bind(100 * 1024 * 1024, asset)
      .run();
    await expect(
      db
        .prepare('UPDATE editor_assets SET size_bytes=? WHERE id=?')
        .bind(100 * 1024 * 1024 + 1, asset)
        .run(),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='editor_assets_pending_quota'",
        )
        .first(),
    ).not.toBeNull();
  });

  it('R-DATA-004: PRAGMA foreign_keys is ON', async () => {
    const db = await migrationsDb();
    const row = await db.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
  });

  it('0027 backfills only existing Brevo webhook projections', async () => {
    const db = await migrationsDb({ through: '0026_admin_user_lifecycle' });
    const brevoConnection = crypto.randomUUID();
    const otherConnection = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
         VALUES (?, 'migration-credential', 1, X'00', X'000000000000000000000000', X'00000000000000000000000000000000', ?, ?)`,
        )
        .bind(credentialId, NOW, NOW),
      db
        .prepare(
          `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(brevoConnection, 'brevo', 'Brevo', credentialId, NOW, NOW),
      db
        .prepare(
          `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(otherConnection, 'other', 'Other', credentialId, NOW, NOW),
      db
        .prepare(
          `INSERT INTO webhook_deliveries (id, connection_id, event_type, raw_payload, message_id, status, event_time, event_time_source, created_at)
         VALUES (?, ?, 'bounce', ?, NULL, 'processed', 1760000000000, 'provider', ?)`,
        )
        .bind(crypto.randomUUID(), brevoConnection, '{"messageId":"brevo-old"}', NOW),
      db
        .prepare(
          `INSERT INTO webhook_deliveries (id, connection_id, event_type, raw_payload, message_id, status, event_time, event_time_source, created_at)
         VALUES (?, ?, 'delivered', ?, NULL, 'processed', 1760000000000, 'provider', ?)`,
        )
        .bind(crypto.randomUUID(), otherConnection, '{"messageId":"other-old"}', NOW),
    ]);

    await migrationsDb();
    const rows = await db
      .prepare(
        `SELECT connection_id, verified_provider_message_id, message_status
         FROM webhook_deliveries ORDER BY connection_id`,
      )
      .all<{
        connection_id: string;
        verified_provider_message_id: string | null;
        message_status: string | null;
      }>();
    expect(rows.results.find((row) => row.connection_id === brevoConnection)).toMatchObject({
      verified_provider_message_id: 'brevo-old',
      message_status: 'bounced',
    });
    expect(rows.results.find((row) => row.connection_id === otherConnection)).toMatchObject({
      verified_provider_message_id: null,
      message_status: null,
    });
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
    // CAP-069: 0025 seeds the internal system-settings revision row.
    expect(CONTRACT_SCHEMA_VERSION).toBe('0034');
  });

  it('R-MESSAGE-005 R-DATA-004 R-DATA-005: 0023 shape and legacy-star backfill cover the owner and explicit members', async () => {
    const db = await migrationsDb({ through: '0022_message_attachments' });
    const ownerId = '00000000-0000-4000-8000-000000005801';
    const memberId = '00000000-0000-4000-8000-000000005802';
    const domainId = '00000000-0000-4000-8000-000000005803';
    const mailboxId = '00000000-0000-4000-8000-000000005804';
    const messageId = '00000000-0000-4000-8000-000000005805';
    const mailboxMessageId = '00000000-0000-4000-8000-000000005806';

    const insertUser = db.prepare(
      `INSERT INTO users (
         id, email, display_name, status, password_algorithm, password_iterations,
         password_salt, password_hash, created_at, updated_at
       ) VALUES (?, ?, ?, 'active', 'pbkdf2-sha256', 600000, x'00', x'11', ?, ?)`,
    );
    await insertUser.bind(ownerId, 'cap058-owner@example.test', 'Owner', NOW, NOW).run();
    await insertUser.bind(memberId, 'cap058-member@example.test', 'Member', NOW, NOW).run();
    await db
      .prepare(
        `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
         VALUES (?, 'cap058.example.test', 'active', NULL, ?, ?)`,
      )
      .bind(domainId, NOW, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'inbox', '', 'active', ?, ?)`,
      )
      .bind(mailboxId, domainId, ownerId, NOW, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
         VALUES (?, ?, 'viewer', ?)`,
      )
      .bind(mailboxId, memberId, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO messages (id, from_address, from_name, subject, html_body, text_body, references_header, status, created_by_user_id, created_at, updated_at)
         VALUES (?, 'sender@example.test', 'Sender', 'legacy star', '', '', '', 'delivered', ?, ?, ?)`,
      )
      .bind(messageId, ownerId, NOW, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
         VALUES (?, ?, ?, 0, 1, 'inbox', ?)`,
      )
      .bind(mailboxMessageId, mailboxId, messageId, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, updated_at, is_deleted, deleted_at)
         VALUES (?, ?, 1, ?, ?, 0, NULL)`,
      )
      .bind(mailboxMessageId, ownerId, NOW, NOW)
      .run();

    await migrationsDb();

    const column = await db
      .prepare(
        `SELECT type, "notnull" AS required, dflt_value
           FROM pragma_table_info('message_user_state')
          WHERE name = 'is_starred'`,
      )
      .first<{ type: string; required: number; dflt_value: string | null }>();
    expect(column).toEqual({ type: 'INTEGER', required: 1, dflt_value: '0' });
    const ddl = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_user_state'")
      .first<{ sql: string }>();
    expect(ddl?.sql).toContain('is_starred IN (0, 1)');

    const stateRows = await db
      .prepare(
        `SELECT user_id, is_read, is_starred
           FROM message_user_state
          WHERE mailbox_message_id = ?
          ORDER BY user_id`,
      )
      .bind(mailboxMessageId)
      .all<{ user_id: string; is_read: number; is_starred: number }>();
    expect(stateRows.results).toEqual([
      { user_id: ownerId, is_read: 1, is_starred: 1 },
      { user_id: memberId, is_read: 0, is_starred: 1 },
    ]);

    const legacy = await db
      .prepare('SELECT is_starred FROM mailbox_messages WHERE id = ?')
      .bind(mailboxMessageId)
      .first<{ is_starred: number }>();
    expect(legacy?.is_starred).toBe(1);
    const duplicateCount = await db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM message_user_state
          WHERE mailbox_message_id = ?`,
      )
      .bind(mailboxMessageId)
      .first<{ count: number }>();
    expect(duplicateCount?.count).toBe(2);
  });

  it('R-SETTINGS-009: 0025 seeds one repeat-safe internal settings revision row', async () => {
    const db = await migrationsDb();
    const revision = await db
      .prepare(`SELECT key, value, updated_at FROM system_settings WHERE key = 'settings_revision'`)
      .first<{ key: string; value: string; updated_at: string }>();
    expect(revision).toEqual({
      key: 'settings_revision',
      value: '1',
      updated_at: '1970-01-01 00:00:00',
    });
    const tracked = await db
      .prepare(`SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?`)
      .bind('0025_system_settings_revision.sql')
      .first<{ count: number }>();
    expect(tracked?.count).toBe(1);
    await migrationsDb();
    const repeated = await db
      .prepare(`SELECT COUNT(*) AS count FROM system_settings WHERE key = 'settings_revision'`)
      .first<{ count: number }>();
    expect(repeated?.count).toBe(1);
  });

  it('R-SETTINGS-009: 0025 normalizes a pre-existing internal revision row', async () => {
    const db = await migrationsDb({ through: '0024_domain_signatures' });
    await db
      .prepare(
        `INSERT INTO system_settings (key, value, updated_at, created_at)
         VALUES ('settings_revision', 'legacy', 'not-a-timestamp', 'not-a-timestamp')`,
      )
      .run();
    await migrationsDb();
    const revision = await db
      .prepare(`SELECT value, updated_at FROM system_settings WHERE key = 'settings_revision'`)
      .first<{ value: string; updated_at: string }>();
    expect(revision).toEqual({ value: '1', updated_at: '1970-01-01 00:00:00' });
  });

  it('0025 live verification accepts settings updates and still rejects an invalid revision timestamp', async () => {
    const db = await migrationsDb();
    const statements = settingsRevisionVerification
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean);
    await db
      .prepare("UPDATE system_settings SET updated_at = ? WHERE key = 'settings_revision'")
      .bind(NOW)
      .run();
    const valid = await db.batch(statements.map((sql) => db.prepare(sql)));
    expect(valid.flatMap((result) => result.results)).toEqual([
      { assertion: '0025_tracking_row_exists', pass: 1 },
      { assertion: '0025_revision_row_shape', pass: 1 },
    ]);
    await db
      .prepare("UPDATE system_settings SET updated_at = 'invalid' WHERE key = 'settings_revision'")
      .run();
    const invalid = await db.batch(statements.map((sql) => db.prepare(sql)));
    expect(invalid.flatMap((result) => result.results)).toContainEqual({
      assertion: '0025_revision_row_shape',
      pass: 0,
    });
  });

  it('CAP-044: upgrading an existing administrator grants audit.read', async () => {
    const db = await migrationsDb({ through: '0017_message_user_state_composite_pk' });
    await db
      .prepare(
        `INSERT INTO roles (id, name, description, is_system, created_at)
         VALUES ('administrator', 'Administrator', 'Legacy administrator role', 1, ?)`,
      )
      .bind(NOW)
      .run();

    const before = await db
      .prepare(`SELECT COUNT(*) AS count FROM permissions WHERE key = 'audit.read'`)
      .first<{ count: number }>();
    expect(before?.count).toBe(0);

    await migrationsDb({ through: '0018_audit_read_permission_backfill' });

    const permission = await db
      .prepare(`SELECT id, key FROM permissions WHERE key = 'audit.read'`)
      .first<{ id: string; key: string }>();
    expect(permission).toEqual({ id: 'audit.read', key: 'audit.read' });
    const mapping = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM role_permissions
         WHERE role_id = 'administrator' AND permission_id = 'audit.read'`,
      )
      .first<{ count: number }>();
    expect(mapping?.count).toBe(1);

    await migrationsDb();
    const repeated = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM role_permissions
         WHERE role_id = 'administrator' AND permission_id = 'audit.read'`,
      )
      .first<{ count: number }>();
    expect(repeated?.count).toBe(1);
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
