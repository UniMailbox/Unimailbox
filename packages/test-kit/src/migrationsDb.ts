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

// Split migration SQL on semicolons for applyD1Migrations
// Filters out comment-only lines to avoid passing them as separate statements
function splitSql(sql: string): string[] {
  const lines = sql.split('\n');
  const statements: string[] = [];
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comment-only lines but keep the separator
    if (trimmed.startsWith('--')) {
      continue;
    }
    current += line + '\n';
    if (trimmed.endsWith(';')) {
      statements.push(current.trim());
      current = '';
    }
  }

  // Handle any remaining content (without trailing semicolon)
  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements.filter(s => s.trim());
}

/**
 * Returns the worker-pool D1 binding with all migrations applied. The
 * `d1_migrations` tracking table makes subsequent calls a no-op, so
 * calling migrationsDb() in every test is safe (and cheap).
 */
export async function migrationsDb(): Promise<D1Database> {
  // Lazy-import so packages/test-kit still typechecks for callers that
  // never touch a worker-pool binding (e.g. unit tests of the fixtures
  // themselves). cloudflare:test is a virtual module — it only exists
  // inside workerd.
  const mod = await import('cloudflare:test');
  await mod.applyD1Migrations(mod.env.DB, [
    { name: '0001_initial', queries: splitSql(initialSql) },
    { name: '0002_managed_domains', queries: splitSql(managedDomainsSql) },
    { name: '0003_provider_connections', queries: splitSql(providerConnectionsSql) },
    { name: '0004_registration_keys', queries: splitSql(registrationKeysSql) },
    { name: '0005_mailboxes', queries: splitSql(mailboxesSql) },
    { name: '0006_messages', queries: splitSql(messagesSql) },
    { name: '0007_outbound_jobs', queries: splitSql(outboundJobsSql) },
    { name: '0008_webhook_events', queries: splitSql(webhookEventsSql) },
  ]);
  return mod.env.DB;
}
