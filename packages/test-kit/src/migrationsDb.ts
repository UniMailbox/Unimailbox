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
// CAP-043 Slice 1 / D-CAP-043-B: per-user soft-delete columns + index on
// message_user_state. The migrationsDb() loader is the canonical entry
// point for the worker-pool test database; without this import the test
// pool would never see the new columns and the inbox-list query would
// fail with "no such column: is_deleted".
import messageUserStateSoftDeleteSql from '../../../migrations/0016_message_user_state_soft_delete.sql?raw';
// CAP-043 Slice 1 fix pass / D-CAP-043-F: rebuild message_user_state with
// PRIMARY KEY (mailbox_message_id, user_id) so per-user state rows can
// coexist (R-MESSAGE-005). Without this migration the worker-pool DB keeps
// the 0006 single-column PK and a second member's read/delete row cannot
// be written.
import messageUserStateCompositePkSql from '../../../migrations/0017_message_user_state_composite_pk.sql?raw';
import auditReadPermissionBackfillSql from '../../../migrations/0018_audit_read_permission_backfill.sql?raw';
// CAP-036: role_policies JSON normalization. Drops the two JSON columns
// (ban_email_patterns_json, avail_domain_patterns_json) and recreates
// role_policies as metadata-only. Two child tables (role_policy_ban_emails,
// role_policy_avail_domains) hold the patterns relationally.
import rolePolicyNormalizeSql from '../../../migrations/0019_role_policy_normalize.sql?raw';
// CAP-047 PATCH slice: raises the `idempotency_records.response_json`
// CHECK ceiling from 65,536 to 524,288 so the GET-compatible PATCH replay
// body fits. Without this import the loader would stop at 0019 and the
// worker-pool DB would still carry the legacy 65,536 ceiling — the
// focused large-body test would CHECK-reject and the entire D1 batch
// would roll back.
import idempotencyResponseSizeSql from '../../../migrations/0020_idempotency_response_size.sql?raw';
import attachmentUploadsSql from '../../../migrations/0021_attachment_uploads.sql?raw';
// CAP-050: message_attachments consumed-relation rows. Two D1-enforced
// guards (UNIQUE index + BEFORE INSERT trigger) make one-consume-per-upload
// safe under concurrent compose requests.
import messageAttachmentsSql from '../../../migrations/0022_message_attachments.sql?raw';
import messageUserStateStarSql from '../../../migrations/0023_message_user_state_star.sql?raw';
import domainSignaturesSql from '../../../migrations/0024_domain_signatures.sql?raw';
import systemSettingsRevisionSql from '../../../migrations/0025_system_settings_revision.sql?raw';
import adminUserLifecycleSql from '../../../migrations/0026_admin_user_lifecycle.sql?raw';
import webhookEventProjectionSql from '../../../migrations/0027_webhook_event_projection.sql?raw';
import inboundAttachmentsSql from '../../../migrations/0028_inbound_attachments.sql?raw';
import editorAssetsSql from '../../../migrations/0029_editor_assets.sql?raw';
import attachmentCleanupSql from '../../../migrations/0032_attachment_cleanup.sql?raw';
import aiConfigurationSql from '../../../migrations/0034_ai_configuration.sql?raw';
import mcpAccessSql from '../../../migrations/0035_mcp_access.sql?raw';
import scheduledSendSql from '../../../migrations/0033_scheduled_send.sql?raw';
import userPreferencesSql from '../../../migrations/0031_user_preferences.sql?raw';
import editorAssetSystemLimitSql from '../../../migrations/0030_editor_asset_system_limit.sql?raw';

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
  {
    name: '0016_message_user_state_soft_delete',
    fileName: '0016_message_user_state_soft_delete.sql',
    sql: messageUserStateSoftDeleteSql,
  },
  {
    name: '0017_message_user_state_composite_pk',
    fileName: '0017_message_user_state_composite_pk.sql',
    sql: messageUserStateCompositePkSql,
  },
  {
    name: '0018_audit_read_permission_backfill',
    fileName: '0018_audit_read_permission_backfill.sql',
    sql: auditReadPermissionBackfillSql,
  },
  {
    name: '0019_role_policy_normalize',
    fileName: '0019_role_policy_normalize.sql',
    sql: rolePolicyNormalizeSql,
  },
  {
    name: '0020_idempotency_response_size',
    fileName: '0020_idempotency_response_size.sql',
    sql: idempotencyResponseSizeSql,
  },
  {
    name: '0021_attachment_uploads',
    fileName: '0021_attachment_uploads.sql',
    sql: attachmentUploadsSql,
  },
  {
    name: '0022_message_attachments',
    fileName: '0022_message_attachments.sql',
    sql: messageAttachmentsSql,
  },
  {
    name: '0023_message_user_state_star',
    fileName: '0023_message_user_state_star.sql',
    sql: messageUserStateStarSql,
  },
  {
    name: '0024_domain_signatures',
    fileName: '0024_domain_signatures.sql',
    sql: domainSignaturesSql,
  },
  {
    name: '0025_system_settings_revision',
    fileName: '0025_system_settings_revision.sql',
    sql: systemSettingsRevisionSql,
  },
  {
    name: '0026_admin_user_lifecycle',
    fileName: '0026_admin_user_lifecycle.sql',
    sql: adminUserLifecycleSql,
  },
  {
    name: '0027_webhook_event_projection',
    fileName: '0027_webhook_event_projection.sql',
    sql: webhookEventProjectionSql,
  },
  {
    name: '0028_inbound_attachments',
    fileName: '0028_inbound_attachments.sql',
    sql: inboundAttachmentsSql,
  },
  { name: '0029_editor_assets', fileName: '0029_editor_assets.sql', sql: editorAssetsSql },
  {
    name: '0030_editor_asset_system_limit',
    fileName: '0030_editor_asset_system_limit.sql',
    sql: editorAssetSystemLimitSql,
  },
  { name: '0031_user_preferences', fileName: '0031_user_preferences.sql', sql: userPreferencesSql },
  {
    name: '0032_attachment_cleanup',
    fileName: '0032_attachment_cleanup.sql',
    sql: attachmentCleanupSql,
  },
  { name: '0033_scheduled_send', fileName: '0033_scheduled_send.sql', sql: scheduledSendSql },
  { name: '0034_ai_configuration', fileName: '0034_ai_configuration.sql', sql: aiConfigurationSql },
  { name: '0035_mcp_access', fileName: '0035_mcp_access.sql', sql: mcpAccessSql },
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
