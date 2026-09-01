// apps/web — AdminLandingPage.
//
// CAP-044 Slice 2 (AC 13): the /admin section entry. Session-guarded by
// the router's beforeLoad (same pattern as /mailbox). The landing is a
// static index of the admin pages; every linked page enforces its own
// permission server-side and renders the not-authorized state for
// members (the session descriptor carries no role signal — see
// admin-queries.ts for the authorization note).
import type { ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { Card } from '../../components/ui/Card';

export function AdminLandingPage(): ReactElement {
  return (
    <main className="admin-page" data-testid="admin-landing">
      <header className="admin-header">
        <h1>Admin</h1>
      </header>
      <Card title="Administration" description="Administrative surfaces for this deployment.">
        <ul className="admin-index">
          <li>
            <Link to="/admin/audit-events" data-testid="admin-audit-events-link">
              Audit events
            </Link>
          </li>
          <li>
            <Link to="/admin/users" data-testid="admin-users-link">
              Users
            </Link>
          </li>
          <li>
            <Link to="/admin/connections" data-testid="admin-connections-link">
              Connections
            </Link>
          </li>
          <li>
            <Link to="/admin/webhook-events" data-testid="admin-webhook-events-link">
              Webhook events
            </Link>
          </li>
          <li>
            <Link to="/admin/domains" data-testid="admin-domains-link">
              Domains
            </Link>
          </li>
          <li>
            <Link to="/admin/roles" data-testid="admin-roles-link">
              Roles
            </Link>
          </li>
          <li>
            <Link to="/admin/signatures" data-testid="admin-signatures-link">
              Signatures
            </Link>
          </li>
          <li>
            <Link to="/admin/settings" data-testid="admin-settings-link">
              General settings
            </Link>
          </li>
        </ul>
      </Card>
    </main>
  );
}
