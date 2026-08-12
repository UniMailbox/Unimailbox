// setup-gate middleware — R-SETUP-001 through R-SETUP-004.
//
// While installation_state.status !== 'complete', every non-setup route
// redirects 302 to /setup. This is the gate that forces the operator through
// the setup wizard before any other route is reachable.
//
// Exempt paths:
// - /healthz — always reachable (R-SETUP-003)
// - /setup and /setup/* — the React client routes
// - /api/v1/setup/* — the setup API endpoints (note: bare /api/v1/setup without
//   a trailing slash is NOT exempt — but no endpoint exists at that exact path,
//   so redirecting it is harmless)
//
// A fresh DB (no installation_state row) is treated as incomplete (R-SETUP-002).
// A DB query failure is treated as incomplete (R-SETUP-004, fail-closed).

import type { MiddlewareHandler } from 'hono';
import type { InstallationStateInfo } from '@unimailbox/contracts';
import type { AppEnv } from '../../platform/env';
import { getSetupStatus } from '../../modules/onboarding';

/**
 * Setup-gate middleware. Reads installation state on every request and redirects
 * to /setup when status !== 'complete' (including when the row is absent).
 *
 * R-SETUP-003: /healthz is exempt and always reachable.
 * R-SETUP-001, R-SETUP-002: all other non-exempt paths redirect while incomplete.
 * R-SETUP-004: DB query failure redirects (fail-closed) and logs a warning.
 */
export const setupGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;

  // Exempt paths — these are always reachable regardless of installation state.
  // R-SETUP-003: /healthz must not be gated.
  if (path === '/healthz') {
    return await next();
  }

  // Exempt /setup and its subpaths (React client routes and setup API).
  if (
    path === '/setup' ||
    path.startsWith('/setup/') ||
    path.startsWith('/api/v1/setup/')
  ) {
    return await next();
  }

  // Read installation state. A missing row means the DB is fresh — getSetupStatus
  // returns { status: 'setup', currentStep: 'claim' } for a fresh DB (R-SETUP-002).
  let state: InstallationStateInfo;
  try {
    state = await getSetupStatus(c.env.DB);
  } catch (err) {
    // R-SETUP-004: fail-closed — a broken DB must not expose the app.
    // Log the error so a DB outage is distinguishable from a genuine fresh
    // install. TODO: replace with structured logger once request-id middleware
    // is real (currently a CAP-001 stub) and requestId is available on `c`.
    console.warn(
      '[setup-gate] installation_state read failed — redirecting to /setup (fail-closed)',
      err,
    );
    return c.redirect('/setup', 302);
  }

  // If status is not 'complete', redirect to /setup.
  if (state.status !== 'complete') {
    return c.redirect('/setup', 302);
  }

  // Installation is complete — proceed to the actual handler.
  return await next();
};
