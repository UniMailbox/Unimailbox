import { Hono } from 'hono';
import { adminOverviewQuerySchema } from '@unimailbox/contracts';
import { readAdminOverview } from '../../modules/admin';
import { requirePermission } from '../middleware/authz';
import type { AppEnv } from '../../platform/env';

export function adminOverviewRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/admin/overview', requirePermission('domain.read'), async (c) => {
    const query = adminOverviewQuerySchema.parse(c.req.query());
    const overview = await readAdminOverview(c.env.DB, query.domainId);
    return c.json({ data: overview });
  });

  return routes;
}
