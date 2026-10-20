import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { aiGovernancePolicySchema, reconcileAiAttemptSchema } from '@unimailbox/contracts';
import { createAiGovernance } from '../../modules/ai';
import { checkPermission } from '../../modules/admin';
import { buildAppContext } from '../../app-context';
import type { AppEnv } from '../../platform/env';
import { DomainError } from '../../platform/errors';
import { sha256Hex } from '../../platform/idempotency';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';

function userId(c: Context<AppEnv>): string {
  const id = c.get('userId');
  if (!id)
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  return id;
}
function mutationKey(c: Context<AppEnv>): string {
  const key = c.get('idempotencyKey');
  if (!key) throw new Error('Missing idempotency context');
  return key;
}
export function aiGovernanceRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('/admin/ai-governance*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  const governance = (env: AppEnv['Bindings']) =>
    createAiGovernance(env.DB, buildAppContext(env).auditEventWriter);
  routes.get('/auth/me/ai-usage', async (c) => {
    const userId = c.get('userId');
    if (!userId)
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: await governance(c.env).usage(userId) });
  });
  routes.get('/admin/ai-governance', requirePermission('settings.read'), async (c) =>
    c.json({
      data: {
        ...(await governance(c.env).policy()),
        canManage: await checkPermission(c.env.DB, userId(c), 'settings.manage'),
      },
    }),
  );
  routes.get('/admin/ai-governance/usage', requirePermission('analytics.read'), async (c) => {
    const userId = c.req.query('userId');
    if (userId !== undefined && !z.string().uuid().safeParse(userId).success)
      throw new DomainError({
        code: 'VALIDATION_ERROR',
        message: 'Invalid user filter',
        httpStatus: 400,
      });
    return c.json({ data: await governance(c.env).usage(userId) });
  });
  routes.put(
    '/admin/ai-governance',
    requirePermission('settings.manage'),
    requireIdempotencyKey,
    async (c) => {
      const revision = c.req.header('If-Match');
      if (revision === undefined)
        throw new DomainError({
          code: 'IF_MATCH_REQUIRED',
          message: 'If-Match required',
          httpStatus: 400,
        });
      if (!/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision)))
        throw new DomainError({
          code: 'IF_MATCH_INVALID',
          message: 'Invalid revision',
          httpStatus: 400,
        });
      const raw = await c.req.text();
      const policy = parseJsonBody(raw, aiGovernancePolicySchema, {
        event: 'ai.policy.invalid_json',
        actorUserId: userId(c),
      });
      const json = await governance(c.env).updatePolicy({
        policy,
        expectedRevision: Number(revision),
        actorUserId: userId(c),
        idempotencyKey: mutationKey(c),
        requestHash: await sha256Hex(raw),
        requestId: c.get('requestId') ?? '<unknown>',
      });
      return new Response(json, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    },
  );
  routes.post(
    '/admin/ai-governance/attempts/:attemptId/reconcile',
    requirePermission('settings.manage'),
    requirePermission('analytics.read'),
    requireIdempotencyKey,
    async (c) => {
      const attemptId = c.req.param('attemptId');
      if (!z.string().uuid().safeParse(attemptId).success)
        throw new DomainError({
          code: 'VALIDATION_ERROR',
          message: 'Invalid attempt',
          httpStatus: 400,
        });
      const raw = await c.req.text();
      const request = parseJsonBody(raw, reconcileAiAttemptSchema, {
        event: 'ai.reconcile.invalid_json',
        actorUserId: userId(c),
      });
      const json = await governance(c.env).reconcile({
        ...request,
        attemptId,
        actorUserId: userId(c),
        idempotencyKey: mutationKey(c),
        requestHash: await sha256Hex(raw),
        requestId: c.get('requestId') ?? '<unknown>',
      });
      return new Response(json, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    },
  );
  return routes;
}
