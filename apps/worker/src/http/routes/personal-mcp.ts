import { Hono, type Context } from 'hono';
import { createMcpTokenSchema, uuidSchema } from '@unimailbox/contracts';
import {
  getPersonalMcpSettings,
  getPersonalMcpTokenPage,
  issueMcpToken,
  revokeMcpToken,
} from '../../modules/admin';
import { DomainError } from '../../platform/errors';
import { sha256Hex } from '../../platform/idempotency';
import type { AppEnv } from '../../platform/env';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';
import { mcpEndpoint } from './admin-mcp';

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
export function personalMcpRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('/auth/me/mcp*', async (c, next) => {
    actor(c);
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.get('/auth/me/mcp', async (c) =>
    c.json({
      data: await getPersonalMcpSettings(
        c.env.DB,
        actor(c),
        mcpEndpoint(c).href,
        c.req.header('X-MCP-Token-Pagination') === '1',
      ),
    }),
  );
  routes.get('/auth/me/mcp/tokens', async (c) => {
    const raw = c.req.query('cursor');
    const cursor = raw === undefined ? undefined : uuidSchema.parse(raw);
    return c.json({ data: await getPersonalMcpTokenPage(c.env.DB, actor(c), cursor) });
  });
  routes.use('/auth/me/mcp*', requireIdempotencyKey);
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
  routes.post('/auth/me/mcp/tokens', async (c) => {
    const raw = await c.req.text();
    const request = parseJsonBody(raw, createMcpTokenSchema, {
      event: 'personal-mcp.invalid_json',
    });
    return response(await issueMcpToken(c.env.DB, { ...(await mutation(c, raw)), request }));
  });
  routes.post('/auth/me/mcp/tokens/:id/revoke', async (c) => {
    const id = uuidSchema.parse(c.req.param('id'));
    return response(await revokeMcpToken(c.env.DB, { ...(await mutation(c, '')), id }));
  });
  return routes;
}
