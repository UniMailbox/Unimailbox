// packages/test-kit/src/migrationsDb.ts — CAP-004 test fixture.
//
// migrationsDb() returns the worker-pool D1 binding with all migrations
// (0001_initial.sql, 0002_managed_domains.sql, etc.) already applied.
// Use it in worker-pool tests that need a real, migrated database.
//
// The fixture is worker-pool only: it uses `applyD1Migrations` from
// `cloudflare:test`, which only resolves inside workerd. Node-pool tests
// (e.g. rule-ID grep proves R-DATA-001 case-insensitivity, which actually
// needs a real D1 binding) should be *.worker.test.ts files.
//
// Implementation note: we read the SQL via vite's `?raw` import at module
// load time, so the fixture tracks the migration file as it changes — no
// duplicated SQL in the test-kit. The SQL is also the deployable artifact,
// so single-source-of-truth is preserved.
//
// NOTE: `applyD1Migrations` splits queries on semicolons, so multi-statement
// migrations work correctly.

import initialSql from '../../../migrations/0001_initial.sql?raw';
import managedDomainsSql from '../../../migrations/0002_managed_domains.sql?raw';
import providerConnectionsSql from '../../../migrations/0003_provider_connections.sql?raw';
import registrationKeysSql from '../../../migrations/0004_registration_keys.sql?raw';
import mailboxesSql from '../../../migrations/0005_mailboxes.sql?raw';
import messagesSql from '../../../migrations/0006_messages.sql?raw';
import outboundJobsSql from '../../../migrations/0007_outbound_jobs.sql?raw';
import webhookEventsSql from '../../../migrations/0008_webhook_events.sql?raw';
import idempotencyRecordsSql from '../../../migrations/0009_idempotency_records.sql?raw';
import blocklistAndRolePoliciesSql from '../../../migrations/0010_blocklist_and_role_policies.sql?raw';
import messageEventTimeSql from '../../../migrations/0011_message_event_time.sql?raw';
import webhookEventTimeSql from '../../../migrations/0012_webhook_event_time.sql?raw';
import webhookDeliveryMessageIndexSql from '../../../migrations/0013_webhook_delivery_message_index.sql?raw';
import betterAuthSubstrateSql from '../../../migrations/0014_better_auth_substrate.sql?raw';
import credentialBackfillSql from '../../../migrations/0015_credential_backfill.sql?raw';

// Split migration SQL for applyD1Migrations. CREATE TRIGGER bodies contain
// internal semicolons, so they remain one statement through their END; line.
function splitSql(sql: string): string[] {
  const lines = sql.split('\n');
  const statements: string[] = [];
  let current = '';
  let inTrigger = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) {
      continue;
    }
    current += line + '\n';
    if (/^CREATE\s+TRIGGER\b/i.test(trimmed)) {
      inTrigger = true;
    }
    if ((inTrigger && /^END;$/i.test(trimmed)) || (!inTrigger && trimmed.endsWith(';'))) {
      statements.push(current.trim());
      current = '';
      inTrigger = false;
    }
  }

  // Handle any remaining content (without trailing semicolon)
  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements.filter((s) => s.trim());
}

const MIGRATIONS = [
  { name: '0001_initial', fileName: '0001_initial.sql', sql: initialSql },
  { name: '0002_managed_domains', fileName: '0002_managed_domains.sql', sql: managedDomainsSql },
  {
    name: '0003_provider_connections',
    fileName: '0003_provider_connections.sql',
    sql: providerConnectionsSql,
  },
  {
    name: '0004_registration_keys',
    fileName: '0004_registration_keys.sql',
    sql: registrationKeysSql,
  },
  { name: '0005_mailboxes', fileName: '0005_mailboxes.sql', sql: mailboxesSql },
  { name: '0006_messages', fileName: '0006_messages.sql', sql: messagesSql },
  { name: '0007_outbound_jobs', fileName: '0007_outbound_jobs.sql', sql: outboundJobsSql },
  { name: '0008_webhook_events', fileName: '0008_webhook_events.sql', sql: webhookEventsSql },
  {
    name: '0009_idempotency_records',
    fileName: '0009_idempotency_records.sql',
    sql: idempotencyRecordsSql,
  },
  {
    name: '0010_blocklist_and_role_policies',
    fileName: '0010_blocklist_and_role_policies.sql',
    sql: blocklistAndRolePoliciesSql,
  },
  {
    name: '0011_message_event_time',
    fileName: '0011_message_event_time.sql',
    sql: messageEventTimeSql,
  },
  {
    name: '0012_webhook_event_time',
    fileName: '0012_webhook_event_time.sql',
    sql: webhookEventTimeSql,
  },
  {
    name: '0013_webhook_delivery_message_index',
    fileName: '0013_webhook_delivery_message_index.sql',
    sql: webhookDeliveryMessageIndexSql,
  },
  {
    name: '0014_better_auth_substrate',
    fileName: '0014_better_auth_substrate.sql',
    sql: betterAuthSubstrateSql,
  },
  {
    name: '0015_credential_backfill',
    fileName: '0015_credential_backfill.sql',
    sql: credentialBackfillSql,
  },
] as const;

export interface MigrationsDbOptions {
  /** Apply through this migration name, inclusive. Omit for the current schema. */
  readonly through?: string;
}

/**
 * Returns the worker-pool D1 binding with all migrations applied. The
 * `d1_migrations` tracking table makes subsequent calls a no-op, so
 * calling migrationsDb() in every test is safe (and cheap).
 */
export async function migrationsDb(options: MigrationsDbOptions = {}): Promise<D1Database> {
  // Lazy-import so packages/test-kit still typechecks for callers that
  // never touch a worker-pool binding (e.g. unit tests of the fixtures
  // themselves). cloudflare:test is a virtual module — it only exists
  // inside workerd.
  const mod = await import('cloudflare:test');
  const throughIndex = options.through
    ? MIGRATIONS.findIndex((migration) => migration.name === options.through)
    : MIGRATIONS.length - 1;
  if (throughIndex < 0) {
    throw new Error(`Unknown migration boundary: ${options.through}`);
  }

  let applied = new Set<string>();
  try {
    const rows = await mod.env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
    applied = new Set(rows.results.map((row) => row.name));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('no such table: d1_migrations')) {
      throw error;
    }
  }

  const pending = MIGRATIONS.slice(0, throughIndex + 1)
    .filter((migration) => !applied.has(migration.fileName))
    .map((migration) => ({ name: migration.name, queries: splitSql(migration.sql) }));
  if (pending.length > 0) {
    await mod.applyD1Migrations(mod.env.DB, pending);
  }
  return mod.env.DB;
}
