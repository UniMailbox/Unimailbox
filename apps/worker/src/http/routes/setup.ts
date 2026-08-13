// http/routes/setup — setup API routes.
// Hono sub-app for /api/v1/setup/* endpoints. GET /status, POST /claim, POST /preflight, POST /administrator.

import { Hono } from 'hono';
import {
  setupClaimRequestSchema,
  setupAdministratorRequestSchema,
} from '@unimailbox/contracts';
import { claimSetup, getSetupStatus, runPreflight, createAdministrator } from '../../modules/onboarding';
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

  // POST /administrator — session-protected endpoint that creates the first user
  // (the initial administrator) with a PBKDF2-hashed password. After successful
  // creation, the installation step advances from 'administrator' to 'domain'.
  routes.post('/administrator', setupSession, async (c) => {
    const body = setupAdministratorRequestSchema.parse(await c.req.json());
    const result = await createAdministrator(
      {
        db: c.env.DB,
        email: body.email,
        password: body.password,
        displayName: body.displayName ?? null,
      },
      { clock: systemClock, ids: systemIds },
    );
    return c.json({ data: result });
  });

  return routes;
}
