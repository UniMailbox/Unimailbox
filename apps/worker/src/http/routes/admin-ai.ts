import { Hono } from 'hono';
import { updateAiConfigurationSchema } from '@unimailbox/contracts';
import { checkPermission, getAiConfiguration, updateAiConfiguration } from '../../modules/admin';
import { importEncryptionKey } from '../../platform/crypto';
import { readSecret } from '../../platform/secrets';
import { DomainError } from '../../platform/errors';
import { sha256Hex } from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';

export function adminAiRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('/admin/ai', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.get('/admin/ai', requirePermission('settings.read'), async (c) => {
    const userId = c.get('userId');
    if (!userId)
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    return c.json({
      data: await getAiConfiguration(
        c.env.DB,
        await checkPermission(c.env.DB, userId, 'settings.manage'),
        !!c.env.AI,
      ),
    });
  });
  routes.put(
    '/admin/ai',
    requirePermission('settings.manage'),
    requireIdempotencyKey,
    async (c) => {
      const actorUserId = c.get('userId');
      const idempotencyKey = c.get('idempotencyKey');
      if (!actorUserId || !idempotencyKey)
        throw new Error('Missing authenticated mutation context');
      const revision = c.req.header('If-Match');
      if (revision === undefined)
        throw new DomainError({
          code: 'IF_MATCH_REQUIRED',
          message: 'If-Match revision required',
          httpStatus: 400,
        });
      if (!/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision)))
        throw new DomainError({
          code: 'IF_MATCH_INVALID',
          message: 'If-Match must be a nonnegative integer revision',
          httpStatus: 400,
        });
      const raw = await c.req.text();
      const request = parseJsonBody(raw, updateAiConfigurationSchema, {
        event: 'admin.ai.invalid_json',
        actorUserId,
      });
      const responseJson = await updateAiConfiguration(
        c.env.DB,
        async () => importEncryptionKey(await readSecret(c.env.CREDENTIAL_ENCRYPTION_KEY)),
        {
          request,
          actorUserId,
          idempotencyKey,
          expectedRevision: Number(revision),
          requestHash: await sha256Hex(raw),
          requestId: c.get('requestId') ?? null,
          workersAiAvailable: !!c.env.AI,
        },
      );
      return new Response(responseJson, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    },
  );
  return routes;
}
