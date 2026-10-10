// http/routes/admin — retired invitation compatibility surface.
//
// Accounts are created and managed by administrators through /admin/users.
// Keep the old paths as explicit, unauthenticated rejects so stale clients
// cannot accidentally reopen public or invite-based registration. The
// registration_keys table remains migration-only data and has no runtime
// write/read path.

import { Hono } from 'hono';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';

export function adminRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  const rejectInvitations = (): never => {
    throw new DomainError({
      code: 'REGISTRATION_DISABLED',
      message: 'Invitation-based registration is disabled',
      httpStatus: 403,
    });
  };

  routes.post('/invite-codes', rejectInvitations);
  routes.get('/invite-codes', rejectInvitations);

  return routes;
}
