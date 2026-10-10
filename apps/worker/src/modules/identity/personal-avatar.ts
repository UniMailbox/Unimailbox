import { AVATAR_MAX_BYTES, type AuditEventWriter } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import { systemIds } from '../../platform/ids';
import {
  personalAvatarKey,
  replayPersonalSettings,
  savePersonalSettings,
  type PersonalSettingsWrite,
} from './personal-settings';
export function validateAvatar(bytes: Uint8Array, type: string): void {
  if (bytes.length > AVATAR_MAX_BYTES)
    throw new DomainError({
      code: 'BODY_TOO_LARGE',
      message: 'Avatar exceeds 2 MiB',
      httpStatus: 413,
    });
  const png =
    type === 'image/png' &&
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  const jpeg =
    type === 'image/jpeg' &&
    bytes.length >= 12 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255;
  const webp =
    type === 'image/webp' &&
    bytes.length >= 16 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  if (!png && !jpeg && !webp)
    throw new DomainError({
      code: 'AVATAR_INVALID',
      message: 'Use a PNG, JPEG or WebP avatar',
      httpStatus: 400,
    });
}
export async function updatePersonalAvatar(
  db: Database,
  bucket: R2Bucket,
  audit: AuditEventWriter,
  input: PersonalSettingsWrite,
  upload: { bytes: Uint8Array; contentType: string } | null,
): Promise<string> {
  const replay = await replayPersonalSettings(db, input);
  if (replay) return replay;
  const previous = await personalAvatarKey(db, input.userId);
  const version = systemIds.uuid();
  const avatar = upload
    ? { key: `user-avatars/${input.userId}/${version}`, contentType: upload.contentType, version }
    : null;
  if (upload && avatar) {
    validateAvatar(upload.bytes, upload.contentType);
    await bucket.put(avatar.key, upload.bytes, {
      httpMetadata: { contentType: upload.contentType },
    });
  }
  // A failed/ambiguous D1 batch leaves an immutable orphan for the bounded sweeper.
  const result = await savePersonalSettings(db, audit, input, {}, avatar);
  if (previous && previous !== (await personalAvatarKey(db, input.userId))) {
    try {
      await bucket.delete(previous);
    } catch {
      console.warn('[avatar] replaced object queued for sweep');
    }
  }
  return result;
}
export async function readPersonalAvatar(
  db: Database,
  bucket: R2Bucket,
  userId: string,
): Promise<R2ObjectBody> {
  const key = await personalAvatarKey(db, userId);
  const object = key ? await bucket.get(key) : null;
  if (!object)
    throw new DomainError({
      code: 'AVATAR_NOT_FOUND',
      message: 'Avatar not found',
      httpStatus: 404,
    });
  return object;
}
// Covers abandoned uploads, concurrent replacements and deletion of users without touching mail objects.
export async function sweepPersonalAvatars(
  db: Database,
  bucket: R2Bucket,
  cache: KVNamespace,
): Promise<void> {
  const cursor = await cache.get('avatar-sweep-cursor');
  const page = await bucket.list({
    prefix: 'user-avatars/',
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  for (const object of page.objects) {
    if (Date.now() - object.uploaded.getTime() < 86400000) continue;
    const live = await db
      .prepare('SELECT 1 AS live FROM user_preferences WHERE avatar_object_key=?')
      .bind(object.key)
      .first();
    if (!live) await bucket.delete(object.key);
  }
  if (page.truncated) await cache.put('avatar-sweep-cursor', page.cursor);
  else if (cursor !== null) await cache.delete('avatar-sweep-cursor');
}
