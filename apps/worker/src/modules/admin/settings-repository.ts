// settings-repository — CAP-069.
//
// The deployable schema is the existing scalar key/value table. This
// repository is deliberately closed over the documented keys; it never
// exposes arbitrary rows or credentials from that table.

import {
  DEFAULT_SYSTEM_SETTINGS,
  systemSettingsSchema,
  type SystemSettings,
} from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';

export const SYSTEM_SETTINGS_DEFAULT_UPDATED_AT = '1970-01-01 00:00:00';
export const SYSTEM_SETTINGS_REVISION_KEY = 'settings_revision';

export const SYSTEM_SETTING_STORAGE_KEYS = {
  siteTitle: 'site_title',
  registrationEnabled: 'registration_enabled',
  inboundEnabled: 'inbound_enabled',
  outboundEnabled: 'outbound_enabled',
  unknownRecipientPolicy: 'unknown_recipient_policy',
  maxMailboxesPerUser: 'max_mailboxes_per_user',
  maxAttachmentsPerMessage: 'max_attachments_per_message',
  maxAttachmentBytes: 'max_attachment_bytes',
  auditRetentionDays: 'audit_retention_days',
  idempotencyRetentionHours: 'idempotency_retention_hours',
} as const satisfies Record<keyof SystemSettings, string>;

type SystemSettingsKey = keyof typeof SYSTEM_SETTING_STORAGE_KEYS;

const SYSTEM_SETTING_PROPERTIES_BY_STORAGE_KEY: Record<string, SystemSettingsKey> = {
  site_title: 'siteTitle',
  registration_enabled: 'registrationEnabled',
  inbound_enabled: 'inboundEnabled',
  outbound_enabled: 'outboundEnabled',
  unknown_recipient_policy: 'unknownRecipientPolicy',
  max_mailboxes_per_user: 'maxMailboxesPerUser',
  max_attachments_per_message: 'maxAttachmentsPerMessage',
  max_attachment_bytes: 'maxAttachmentBytes',
  audit_retention_days: 'auditRetentionDays',
  idempotency_retention_hours: 'idempotencyRetentionHours',
};

interface SystemSettingStorageRow {
  readonly key: string;
  readonly value: string;
  readonly updated_at: string;
}

export interface SystemSettingsSnapshot {
  readonly settings: SystemSettings;
  readonly updatedAt: string;
}

/** Reads only the known settings and fills absent rows from the defaults. */
export async function readSystemSettings(db: Database): Promise<SystemSettingsSnapshot> {
  const storageKeys = [...Object.values(SYSTEM_SETTING_STORAGE_KEYS), SYSTEM_SETTINGS_REVISION_KEY];
  const placeholders = storageKeys.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `SELECT key, value, updated_at
       FROM system_settings
       WHERE key IN (${placeholders})`,
    )
    .bind(...storageKeys)
    .all<SystemSettingStorageRow>();

  const values: Partial<Record<SystemSettingsKey, unknown>> = {};
  let updatedAt = SYSTEM_SETTINGS_DEFAULT_UPDATED_AT;
  let revisionUpdatedAt: string | null = null;
  for (const row of result.results) {
    if (row.key === SYSTEM_SETTINGS_REVISION_KEY) {
      revisionUpdatedAt = row.updated_at;
      continue;
    }
    const property = SYSTEM_SETTING_PROPERTIES_BY_STORAGE_KEY[row.key];
    if (property === undefined) continue;
    values[property] = parseStoredValue(property, row.value);
    if (row.updated_at > updatedAt) updatedAt = row.updated_at;
  }
  if (revisionUpdatedAt !== null) updatedAt = revisionUpdatedAt;

  return {
    settings: systemSettingsSchema.parse({ ...DEFAULT_SYSTEM_SETTINGS, ...values }),
    updatedAt,
  };
}

/** Prepares the atomic compare-and-swap guard for a full settings update. */
export function prepareCompareAndSetSettingsRevision(
  db: Database,
  expectedUpdatedAt: string,
  updatedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE system_settings
          SET value = CASE WHEN updated_at = ? THEN value ELSE NULL END,
              updated_at = ?
        WHERE key = ?`,
    )
    .bind(expectedUpdatedAt, updatedAt, SYSTEM_SETTINGS_REVISION_KEY);
}

/** Prepares one upsert per allowlisted setting for an atomic D1 batch. */
export function prepareUpsertSystemSettings(
  db: Database,
  settings: SystemSettings,
  updatedAt: string,
): D1PreparedStatement[] {
  return (Object.keys(SYSTEM_SETTING_STORAGE_KEYS) as SystemSettingsKey[]).map((property) => {
    const key = SYSTEM_SETTING_STORAGE_KEYS[property];
    return db
      .prepare(
        `INSERT INTO system_settings (key, value, updated_at, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, serializeSetting(property, settings[property]), updatedAt, updatedAt);
  });
}

function parseStoredValue(property: SystemSettingsKey, value: string): unknown {
  if (property === 'siteTitle') {
    if (value.trim() !== value) invalidStoredSetting(property);
    return parseWithSchema(property, systemSettingsSchema.shape.siteTitle, value);
  }

  if (
    property === 'registrationEnabled' ||
    property === 'inboundEnabled' ||
    property === 'outboundEnabled'
  ) {
    const candidate: unknown = value === 'true' ? true : value === 'false' ? false : null;
    return parseWithSchema(property, systemSettingsSchema.shape[property], candidate);
  }

  if (property === 'unknownRecipientPolicy') {
    return parseWithSchema(property, systemSettingsSchema.shape.unknownRecipientPolicy, value);
  }

  if (!/^(0|[1-9]\d*)$/.test(value)) invalidStoredSetting(property);
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) invalidStoredSetting(property);

  if (property === 'maxMailboxesPerUser') {
    return parseWithSchema(property, systemSettingsSchema.shape.maxMailboxesPerUser, numberValue);
  }
  if (property === 'maxAttachmentsPerMessage') {
    return parseWithSchema(
      property,
      systemSettingsSchema.shape.maxAttachmentsPerMessage,
      numberValue,
    );
  }
  if (property === 'maxAttachmentBytes') {
    return parseWithSchema(property, systemSettingsSchema.shape.maxAttachmentBytes, numberValue);
  }
  if (property === 'auditRetentionDays') {
    return parseWithSchema(property, systemSettingsSchema.shape.auditRetentionDays, numberValue);
  }
  return parseWithSchema(
    property,
    systemSettingsSchema.shape.idempotencyRetentionHours,
    numberValue,
  );
}

type SafeParseSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

function parseWithSchema<T>(
  property: SystemSettingsKey,
  schema: SafeParseSchema<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalidStoredSetting(property);
  return parsed.data;
}

function serializeSetting(
  _property: SystemSettingsKey,
  value: SystemSettings[SystemSettingsKey],
): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function invalidStoredSetting(property: SystemSettingsKey): never {
  throw new DomainError({
    code: 'INTERNAL',
    message: `Stored system setting is invalid: ${property}`,
    httpStatus: 500,
  });
}
