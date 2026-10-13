import { Hono, type Context } from 'hono';
import { mcpConfigurationSchema } from '@unimailbox/contracts';
import { getMcpAdministration, updateMcpConfiguration } from '../../modules/admin';
import { DomainError } from '../../platform/errors';
import { sha256Hex } from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';

export function mcpEndpoint(c: Context<AppEnv>): URL {
  const appOrigin = c.env.APP_ORIGIN ?? c.get('config')?.betterAuthUrl;
  if (!appOrigin) throw new Error('Missing validated application origin');
  const origin = new URL(appOrigin);
  if (
    origin.protocol !== 'https:' &&
    !(
      c.get('config')?.environment === 'local' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    )
  )
    throw new DomainError({
      code: 'INTERNAL',
      message: 'MCP requires an HTTPS application origin',
      httpStatus: 500,
    });
  return new URL('/api/mcp', origin.origin);
}

function actor(c: Context<AppEnv>): string {
  const id = c.get('userId');
  if (!id)
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  return id;
}

export function adminMcpRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('/admin/mcp*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.get('/admin/mcp', requirePermission('settings.read'), async (c) =>
    c.json({ data: await getMcpAdministration(c.env.DB, actor(c), mcpEndpoint(c).href) }),
  );
  routes.use('/admin/mcp*', requirePermission('settings.manage'));
  routes.use('/admin/mcp*', requireIdempotencyKey);
  const mutation = async (c: Context<AppEnv>, raw: string) => {
    const key = c.get('idempotencyKey');
    if (!key) throw new Error('Missing mutation context');
    return {
      actorUserId: actor(c),
      idempotencyKey: key,
      requestHash: await sha256Hex(raw),
      requestId: c.get('requestId') ?? null,
    };
  };
  const response = (json: string) =>
    new Response(json, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  routes.put('/admin/mcp', async (c) => {
    const revision = c.req.header('If-Match');
    if (revision === undefined)
      throw new DomainError({
        code: 'IF_MATCH_REQUIRED',
        message: 'Revision required',
        httpStatus: 400,
      });
    if (!/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision)))
      throw new DomainError({
        code: 'IF_MATCH_INVALID',
        message: 'Invalid revision',
        httpStatus: 400,
      });
    const raw = await c.req.text();
    const configuration = parseJsonBody(raw, mcpConfigurationSchema, {
      event: 'admin.mcp.invalid_json',
    });
    return response(
      await updateMcpConfiguration(c.env.DB, {
        ...(await mutation(c, raw)),
        configuration,
        revision: Number(revision),
      }),
    );
  });
  return routes;
}
