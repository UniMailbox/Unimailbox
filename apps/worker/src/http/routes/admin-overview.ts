import { Hono } from 'hono';
import { adminOverviewQuerySchema, resourceUsageQuerySchema } from '@unimailbox/contracts';
import { readAdminOverview, readResourceUsage, readMailProcessing } from '../../modules/admin';
import { buildAppContext } from '../../app-context';
import { requirePermission } from '../middleware/authz';
import type { AppEnv } from '../../platform/env';

export function adminOverviewRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/admin/mail-processing', requirePermission('analytics.read'), async (c) => {
    const query = resourceUsageQuerySchema.parse(c.req.query());
    const data = await readMailProcessing(c.env.DB, query.days as 7 | 30, new Date());
    c.header('Cache-Control', 'no-store');
    return c.json({ data });
  });

  routes.get('/admin/resource-usage', requirePermission('analytics.read'), async (c) => {
    const query = resourceUsageQuerySchema.parse(c.req.query());
    const ctx = buildAppContext(c.env);
    const data = await readResourceUsage(ctx.resourceUsage, query.days as 7 | 30, ctx.clock.now());
    c.header('Cache-Control', 'no-store');
    return c.json({ data });
  });

  routes.get('/admin/overview', requirePermission('domain.read'), async (c) => {
    const query = adminOverviewQuerySchema.parse(c.req.query());
    const overview = await readAdminOverview(c.env.DB, query.domainId);
    return c.json({ data: overview });
  });

  return routes;
}
