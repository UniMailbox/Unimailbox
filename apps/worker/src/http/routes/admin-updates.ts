import { Hono } from 'hono';
import { checkForUpdates } from '../../platform/updates';
import { requirePermission } from '../middleware/authz';
import type { AppEnv } from '../../platform/env';

export function adminUpdateRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get('/admin/updates', requirePermission('settings.read'), async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ data: await checkForUpdates(c.env) });
  });
  return routes;
}
