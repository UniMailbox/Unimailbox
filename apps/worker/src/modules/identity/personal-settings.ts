import {
  DEFAULT_PERSONAL_PREFERENCES,
  personalSettingsSchema,
  type AuditEventWriter,
  type PersonalPreferences,
  type PersonalSettings,
} from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import {
  assertSameRequestHash,
  findIdempotencyRecord,
  prepareCreateIdempotencyRecord,
  sqliteTimestamp,
} from '../../platform/idempotency';

type SettingsRow = PersonalPreferences & {
  avatar_object_key: string | null;
  avatar_content_type: string | null;
  avatar_version: string | null;
};
export async function readPersonalSettings(
  db: Database,
  userId: string,
): Promise<PersonalSettings> {
  const row = await db
    .prepare(
      `SELECT language, theme, density, reading_pane AS readingPane,
    default_mailbox_id AS defaultMailboxId, avatar_content_type, avatar_version
    FROM user_preferences WHERE user_id=?`,
    )
    .bind(userId)
    .first<SettingsRow>();
  return personalSettingsSchema.parse({
    preferences: row
      ? {
          language: row.language,
          theme: row.theme,
          density: row.density,
          readingPane: row.readingPane,
          defaultMailboxId: row.defaultMailboxId,
        }
      : DEFAULT_PERSONAL_PREFERENCES,
    avatarVersion: row?.avatar_version ?? null,
    avatarContentType: row?.avatar_content_type ?? null,
  });
}
export async function personalAvatarKey(db: Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT avatar_object_key FROM user_preferences WHERE user_id=?')
    .bind(userId)
    .first<{ avatar_object_key: string | null }>();
  return row?.avatar_object_key ?? null;
}
export interface PersonalSettingsWrite {
  userId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  requestId: string | null;
}
export async function replayPersonalSettings(
  db: Database,
  input: PersonalSettingsWrite,
): Promise<string | null> {
  const replay = await findIdempotencyRecord(
    db,
    input.userId,
    input.operation,
    input.idempotencyKey,
  );
  if (!replay) return null;
  assertSameRequestHash(replay, input.requestHash);
  return replay.responseJson;
}
const columns = {
  language: 'language',
  theme: 'theme',
  density: 'density',
  readingPane: 'reading_pane',
  defaultMailboxId: 'default_mailbox_id',
} as const;
// Only changed relational columns are written: simultaneous changes to separate settings cannot erase each other.
export async function savePersonalSettings(
  db: Database,
  audit: AuditEventWriter,
  input: PersonalSettingsWrite,
  patch: Partial<PersonalPreferences>,
  avatar?: { key: string; contentType: string; version: string } | null,
): Promise<string> {
  const replay = await replayPersonalSettings(db, input);
  if (replay) return replay;
  const current = await readPersonalSettings(db, input.userId);
  const responseJson = JSON.stringify({
    data: personalSettingsSchema.parse({
      preferences: { ...current.preferences, ...patch },
      avatarVersion: avatar === undefined ? current.avatarVersion : (avatar?.version ?? null),
      avatarContentType:
        avatar === undefined ? current.avatarContentType : (avatar?.contentType ?? null),
    }),
  });
  const entries = Object.entries(patch) as Array<[keyof PersonalPreferences, string | null]>;
  const names: string[] = entries.map(([key]) => columns[key]);
  const values: Array<string | null> = entries.map(([, value]) => value);
  if (avatar !== undefined) {
    names.push('avatar_object_key', 'avatar_content_type', 'avatar_version');
    values.push(avatar?.key ?? null, avatar?.contentType ?? null, avatar?.version ?? null);
  }
  const now = sqliteTimestamp(systemClock.now());
  try {
    await db.batch([
      prepareCreateIdempotencyRecord(db, {
        id: systemIds.uuid(),
        actorId: input.userId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        responseStatus: 200,
        responseJson,
        createdAt: now,
      }),
      db
        .prepare(
          `INSERT INTO user_preferences(user_id, ${names.join(',')}, updated_at)
        VALUES (?, ${names.map(() => '?').join(',')}, ?)
        ON CONFLICT(user_id) DO UPDATE SET ${names.map((name) => `${name}=excluded.${name}`).join(',')}, updated_at=excluded.updated_at`,
        )
        .bind(input.userId, ...values, now),
      audit.prepare({
        id: systemIds.uuid(),
        actorUserId: input.userId,
        action: avatar === undefined ? 'user.preferences_updated' : 'user.avatar_updated',
        resourceType: 'user',
        resourceId: input.userId,
        requestId: input.requestId,
        metadata: null,
        createdAt: now,
      }).statement as D1PreparedStatement,
    ]);
  } catch (cause) {
    // Also handles an ambiguous successful D1 acknowledgement. Never remove its live R2 object.
    const replay = await replayPersonalSettings(db, input);
    if (replay) return replay;
    throw cause;
  }
  return responseJson;
}
