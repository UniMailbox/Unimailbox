import { useT } from '../infrastructure/i18n/locale';
// apps/web — AppNav.
//
// CAP-044 Slice 3 amendment item 1 (D-CAP-044-K): the mailbox-surface
// link into the /admin section. Current sessions carry a D1-derived
// canAccessAdmin UI hint; older sessions fall back to one
// `GET /api/v1/admin/audit-events?limit=1` probe. This is only a
// client-side VISIBILITY signal, not an authorization
// check: the server re-checks permission on every admin request
// (R-AUTHZ-002), so this link decides only what is SHOWN, never what is
// ALLOWED — a revocation blocks immediately, and a mid-session grant
// needs only a page reload to surface here. Legacy sessions make one probe per signed-in
// userId (retry + retryOnMount off, staleTime + gcTime Infinity) keeps
// the link stable across route changes; a member's denial costs one 403
// for the whole session, not one per navigation.
//
// This component deliberately renders NOTHING while the probe is pending
// or failed — no skeleton, no "Admin (unavailable)". A link that appears
// and disappears would read as a flicker bug; absence is the member's
// normal state.
//
// Presentational composition only: the probe hook owns the query; this
// file owns the link. Kept in components/ (not features/admin/) because
// it mounts inside the mailbox feature's headers — the task contract
// pins the location (D-CAP-044-K).
import type { ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { useAdminNavProbe } from '../features/admin/admin-queries';
import { authSessionQuery } from '../features/auth/auth-queries';

export function AppNav(): ReactElement | null {
  const t = useT();
  const session = authSessionQuery().data;
  const probe = useAdminNavProbe();
  if (session?.canAccessAdmin === false || (session?.canAccessAdmin !== true && !probe.data)) {
    // Pending, errored (403 member / network), or disabled (no session):
    // no link. The member case is the common one and must look identical
    // to "no probe yet" — a member never learns the admin area exists.
    return null;
  }
  return (
    <nav className="app-nav" aria-label={t('Application')} data-testid="app-nav">
      <Link to="/admin" data-testid="app-nav-admin-link">
        {t('Admin')}
      </Link>
    </nav>
  );
}
