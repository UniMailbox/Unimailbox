import { Hono, type Context } from 'hono';
import { AVATAR_MAX_BYTES, updatePersonalPreferencesSchema } from '@unimailbox/contracts';
import { buildAppContext } from '../../app-context';
import {
  readPersonalSettings,
  savePersonalSettings,
  updatePersonalAvatar,
  readPersonalAvatar,
  type PersonalSettingsWrite,
} from '../../modules/identity';
import { assertCan, findMailboxById } from '../../modules/tenancy';
import { DomainError } from '../../platform/errors';
import { sha256Hex } from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';
function actor(c: Context<AppEnv>): string {
  const id = c.get('userId');
  if (!id)
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  if (c.get('mustChangePassword'))
    throw new DomainError({
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'Change password first',
      httpStatus: 403,
    });
  return id;
}
function writeInput(
  c: Context<AppEnv>,
  userId: string,
  requestHash: string,
): PersonalSettingsWrite {
  const key = c.get('idempotencyKey');
  if (!key)
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency key required',
      httpStatus: 400,
    });
  return {
    userId,
    operation: `${c.req.method} ${c.req.path}`,
    idempotencyKey: key,
    requestHash,
    requestId: c.get('requestId') ?? null,
  };
}
export function personalSettingsRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get('/auth/me/preferences', async (c) =>
    c.json({ data: await readPersonalSettings(c.env.DB, actor(c)) }),
  );
  routes.patch('/auth/me/preferences', requireIdempotencyKey, async (c) => {
    const userId = actor(c);
    const body = await c.req.text();
    const patch = parseJsonBody(body, updatePersonalPreferencesSchema, {
      event: 'personal-settings.invalid_json',
      actorUserId: userId,
    });
    if (patch.defaultMailboxId) {
      await assertCan(c.env.DB, userId, patch.defaultMailboxId, 'read');
      const mailbox = await findMailboxById(c.env.DB, patch.defaultMailboxId);
      if (mailbox?.status !== 'active')
        throw new DomainError({
          code: 'MAILBOX_NOT_FOUND',
          message: 'Active mailbox required',
          httpStatus: 404,
        });
    }
    const ctx = buildAppContext(c.env);
    const result = await savePersonalSettings(
      ctx.db,
      ctx.auditEventWriter,
      writeInput(c, userId, await sha256Hex(body)),
      Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    );
    return new Response(result, { headers: { 'Content-Type': 'application/json' } });
  });
  return routes;
}
export function personalAvatarRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get('/auth/me/avatar', async (c) => {
    const object = await readPersonalAvatar(c.env.DB, c.env.ATTACHMENTS, actor(c));
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    });
  });
  routes.on(['POST', 'DELETE'], '/auth/me/avatar', requireIdempotencyKey, async (c) => {
    const userId = actor(c);
    const length = Number(c.req.header('Content-Length') ?? 0);
    if (length > AVATAR_MAX_BYTES)
      throw new DomainError({
        code: 'BODY_TOO_LARGE',
        message: 'Avatar exceeds 2 MiB',
        httpStatus: 413,
      });
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > AVATAR_MAX_BYTES)
      throw new DomainError({
        code: 'BODY_TOO_LARGE',
        message: 'Avatar exceeds 2 MiB',
        httpStatus: 413,
      });
    const contentType = c.req.header('Content-Type') ?? '';
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = await sha256Hex(contentType + Array.from(new Uint8Array(digest)).join(','));
    const ctx = buildAppContext(c.env);
    const result = await updatePersonalAvatar(
      ctx.db,
      c.env.ATTACHMENTS,
      ctx.auditEventWriter,
      writeInput(c, userId, hash),
      c.req.method === 'DELETE' ? null : { bytes, contentType },
    );
    return new Response(result, { headers: { 'Content-Type': 'application/json' } });
  });
  return routes;
}
