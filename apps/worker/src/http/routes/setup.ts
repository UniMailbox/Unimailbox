// http/routes/setup — setup API routes.
// Hono sub-app for /api/v1/setup/* endpoints. GET /status is the first endpoint.

import { Hono } from 'hono';
import { getSetupStatus } from '../../modules/onboarding';
import type { AppEnv } from '../../platform/env';

export function setupRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/status', async (c) => {
    const status = await getSetupStatus(c.env.DB);
    return c.json({ data: status });
  });

  return routes;
}
