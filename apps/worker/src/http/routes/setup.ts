// http/routes/setup — setup API routes.
// Hono sub-app for /api/v1/setup/* endpoints. GET /status, POST /claim, POST /preflight,
// POST /administrator, POST /domain, POST /cloudflare/dashboard-link, POST /cloudflare/verify,
// POST /inbound-smoke-test, POST /inbound-smoke-test/check, POST /brevo, POST /outbound-smoke-test,
// POST /complete.

import { Hono } from 'hono';
import {
  setupClaimRequestSchema,
  setupAdministratorRequestSchema,
  setupDomainRequestSchema,
  setupBrevoRequestSchema,
} from '@unimailbox/contracts';
import {
  claimSetup,
  getSetupStatus,
  runPreflight,
  createAdministrator,
  createDomainStep,
  getCloudflareDashboardLink,
  verifyCloudflareEmailRouting,
  startInboundSmokeTest,
  checkInboundSmokeTest,
  setupBrevo,
  runOutboundSmokeTest,
  completeSetup,
} from '../../modules/onboarding';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { readSecret } from '../../platform/secrets';
import type { AppEnv } from '../../platform/env';
import { setupSession } from '../middleware/setup-session';
import { brevoAdapter } from '../../integrations/providers/brevo';

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

  // POST /domain — session-protected endpoint that creates a managed domain.
  // After successful creation, the installation step advances from 'domain' to 'cloudflare-verify'.
  routes.post('/domain', setupSession, async (c) => {
    const body = setupDomainRequestSchema.parse(await c.req.json());
    const result = await createDomainStep(
      {
        db: c.env.DB,
        name: body.name,
      },
      { clock: systemClock, ids: systemIds },
    );
    return c.json({ data: result });
  });

  // POST /cloudflare/dashboard-link — session-protected endpoint that returns
  // an allowlisted Cloudflare dashboard URL. Does NOT advance the installation step.
  routes.post('/cloudflare/dashboard-link', setupSession, async (c) => {
    const result = await getCloudflareDashboardLink();
    return c.json({ data: result });
  });

  // POST /cloudflare/verify — session-protected endpoint that confirms a managed
  // domain exists and advances the installation step to 'inbound-smoke'.
  // If no domain exists, returns 409 SETUP_DOMAIN_REQUIRED.
  routes.post('/cloudflare/verify', setupSession, async (c) => {
    const result = await verifyCloudflareEmailRouting(
      { db: c.env.DB },
      { clock: systemClock },
    );
    return c.json({ data: result });
  });

  // POST /inbound-smoke-test — session-protected endpoint that starts the inbound
  // smoke test. Generates a unique smoke+<token>@<domain> address and stores the token in KV.
  // Returns { smokeTestAddress: "smoke+<token>@<domain>" }.
  routes.post('/inbound-smoke-test', setupSession, async (c) => {
    const result = await startInboundSmokeTest(
      { db: c.env.DB, cache: c.env.CACHE },
      { ids: systemIds },
    );
    return c.json({ data: result });
  });

  // POST /inbound-smoke-test/check — session-protected endpoint that checks whether
  // the smoke test email has been received. Returns { status: "pending" | "received" }.
  // If received, advances the installation step to 'brevo'.
  routes.post('/inbound-smoke-test/check', setupSession, async (c) => {
    const result = await checkInboundSmokeTest(
      { db: c.env.DB, cache: c.env.CACHE },
      { clock: systemClock },
    );
    return c.json({ data: result });
  });

  // POST /brevo — session-protected endpoint that validates and stores the Brevo
  // API key. Validates via Brevo API, encrypts with AES-GCM, stores credential and
  // connection, links to managed domain, and advances step to 'outbound-smoke'.
  routes.post('/brevo', setupSession, async (c) => {
    const body = setupBrevoRequestSchema.parse(await c.req.json());
    const encryptionKey = await readSecret(c.env.CREDENTIAL_ENCRYPTION_KEY);
    const result = await setupBrevo(
      {
        db: c.env.DB,
        encryptionKey,
        apiKey: body.apiKey,
        adapter: brevoAdapter,
      },
      { clock: systemClock, ids: systemIds },
    );
    return c.json({ data: result });
  });

  // POST /outbound-smoke-test — session-protected endpoint that sends a test email
  // via Brevo. Decrypts the stored API key, constructs a test message from
  // noreply@<domain> to the admin's email, sends it, and advances step to 'complete'.
  routes.post('/outbound-smoke-test', setupSession, async (c) => {
    const encryptionKey = await readSecret(c.env.CREDENTIAL_ENCRYPTION_KEY);
    const result = await runOutboundSmokeTest(
      { db: c.env.DB, encryptionKey, adapter: brevoAdapter },
      { clock: systemClock, ids: systemIds },
    );
    return c.json({ data: result });
  });

  // POST /complete — session-protected endpoint that marks installation as complete.
  // Sets status='complete' and current_step='complete'. After this, the setup gate
  // passes through to the app instead of redirecting to /setup.
  routes.post('/complete', setupSession, async (c) => {
    const result = await completeSetup({ db: c.env.DB }, { clock: systemClock });
    return c.json({ data: result });
  });

  return routes;
}
