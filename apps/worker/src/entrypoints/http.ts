// HTTP entry — Hono app. CAP-001 stub.
// The composition root (`src/worker.ts`) is what the deployed bundle exports.
// This module owns the `fetch` handler only — see `buildRouter()` for routes.
import { DomainError } from '../platform/errors';
import { Hono } from 'hono';
import { buildRouter } from '../http/router';
import { errorMiddleware } from '../http/middleware/error';
import { securityHeaders } from '../http/middleware/security-headers';
import { maintenanceHealth, readiness, releaseIdentity } from '../platform/health';
import type { AppEnv } from '../platform/env';

export const app: Hono<AppEnv> = new Hono<AppEnv>();
app.use('*', securityHeaders);
app.get('/healthz', (c) => c.json({ ok: true, surface: 'router', ...releaseIdentity(c.env) }));
app.get('/readyz', async (c) => {
  const status = await readiness(c.env);
  return c.json({ ...status, ...releaseIdentity(c.env) }, status.ok ? 200 : 503);
});
app.get('/healthz/maintenance', async (c) => {
  const ok = await maintenanceHealth(c.env);
  return c.json({ ok }, ok ? 200 : 503);
});
// Missing files and bare API roots must never become an HTML shell or setup redirect.
app.use('*', async (c, next) => {
  if (c.req.path === '/api' || c.req.path === '/api/') return c.notFound();
  // SELF.fetch and requests routed through the Worker still need the same
  // real-file behavior as the platform's asset-first path.
  if (c.req.path.startsWith('/assets/')) {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.notFound();
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    return asset.status === 404 ? c.notFound() : asset;
  }
  await next();
});
app.route('/', buildRouter());
app.onError(errorMiddleware);

app.notFound(() => {
  throw new DomainError({ code: 'NOT_FOUND', message: 'Resource not found', httpStatus: 404 });
});
