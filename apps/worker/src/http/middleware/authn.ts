// Application-owned authentication middleware.
//
// A request is authenticated only by a token issued by /auth/login or
// /auth/refresh. The token is an opaque KV key whose payload contains the D1
// session id. D1 remains the revocation and account-status authority; KV is
// only a short-lived lookup cache. No Cloudflare Access headers, Better Auth
// cookies, or external identity assertions are accepted here.

import type { MiddlewareHandler } from 'hono';
import { findAuthenticatedPrincipal } from '../../modules/identity';
import type { AppEnv } from '../../platform/env';
import { systemClock } from '../../platform/clock';

interface AccessTokenPayload {
  readonly userId: string;
  readonly sessionId: string;
}

export const authn: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  let payload: AccessTokenPayload | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (token.length > 0) {
      const raw = await c.env.CACHE.get(`auth:${token}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (
            typeof parsed.userId === 'string' &&
            parsed.userId.length > 0 &&
            typeof parsed.sessionId === 'string' &&
            parsed.sessionId.length > 0
          ) {
            payload = { userId: parsed.userId, sessionId: parsed.sessionId };
          }
        } catch {
          // A corrupt cache entry is equivalent to an absent credential.
        }
      }
    }
  }

  if (payload) {
    const principal = await findAuthenticatedPrincipal(
      c.env.DB,
      payload.sessionId,
      payload.userId,
      Math.floor(systemClock.unixMs() / 1000),
    );
    if (principal) {
      c.set('principal', principal);
      c.set('userId', principal.userId);
      c.set('sessionId', principal.sessionId);
      c.set('mustChangePassword', principal.mustChangePassword);
    }
  }

  await next();
};
