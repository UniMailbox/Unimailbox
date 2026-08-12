// http/routes/setup — setup API routes.
// Hono sub-app for /api/v1/setup/* endpoints. GET /status, POST /claim, POST /preflight.

import { Hono } from 'hono';
import { setupClaimRequestSchema } from '@unimailbox/contracts';
import { claimSetup, getSetupStatus, runPreflight } from '../../modules/onboarding';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { readSecret } from '../../platform/secrets';
import type { AppEnv } from '../../platform/env';
import { setupSession } from '../middleware/setup-session';

export function setupRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/status', async (c) => {
    const status = await getSetupStatus(c.env.DB);
    return c.json({ data: status });
  });

  routes.post('/claim', async (c) => {
    const body = setupClaimRequestSchema.parse(await c.req.json());
    const expectedToken = await readSecret(c.env.INSTALLATION_TOKEN);
    const result = await claimSetup(
      {
        db: c.env.DB,
        setupSessionStore: c.env.SETUP_SESSION,
        expectedToken,
        providedToken: body.token,
      },
      { clock: systemClock, ids: systemIds },
    );
    return c.json({ data: result });
  });

  // POST /preflight — session-protected endpoint that reports binding presence
  // and schema version. Requires a valid session token from /claim.
  routes.post('/preflight', setupSession, async (c) => {
    const result = await runPreflight(c.env.DB, c.env);
    return c.json({ data: result });
  });

  return routes;
}
