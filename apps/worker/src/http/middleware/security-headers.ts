import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';

// Keep these defaults in sync with apps/web/public/_headers. More restrictive
// attachment headers (such as CSP sandbox) take precedence.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
};
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    if (!c.res.headers.has(name)) c.header(name, value);
  if (c.env.ENVIRONMENT !== 'production') c.header('X-Robots-Tag', 'noindex, nofollow');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
};
