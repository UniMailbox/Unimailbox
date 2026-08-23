// apps/web — MailboxShell.
//
// CAP-042 (Batch 5) AC 20. The authorized mailbox shell. Reached only
// after `/mailbox`'s `beforeLoad` confirms a valid session via
// `queryClient.ensureQueryData(authQueryKeys.session(), fetchAuthSession)`;
// the same cache feeds this component's read via `authSessionQuery`,
// so the descriptor is already in memory by the time we render (one
// HTTP GET per navigation, not two — D-CAP-041-1).
//
// The full inbox + thread + compose shell lands with CAP-043/044. For
// Batch 5 we render the placeholder body so a reviewer can navigate
// /login → /mailbox end-to-end and exercise the LogoutButton.
import type { ReactElement } from 'react';
import { authSessionQuery } from '../auth/auth-queries';
import { LogoutButton } from '../auth/LogoutButton';
import { Card } from '../../components/ui/Card';
import { MailboxLoading } from './MailboxLoading';

export function MailboxShell(): ReactElement {
  const sessionQuery = authSessionQuery();
  if (sessionQuery.data === undefined) {
    // Cache is empty (rare: a fresh navigation with a never-loaded
    // session descriptor). Show the loading state and let the query
    // hydrate. In practice the router's `beforeLoad` already ran
    // `ensureQueryData` so this branch is unreachable under normal
    // navigation.
    return <MailboxLoading />;
  }
  const descriptor = sessionQuery.data;
  // The router's `beforeLoad` guarantees `descriptor !== null`; the
  // null branch here exists only so the type narrows without a cast.
  if (descriptor === null) {
    return <MailboxLoading />;
  }
  return (
    <main className="mailbox-shell" data-testid="mailbox-shell">
      <header className="mailbox-header">
        <h1 className="mailbox-title">Mailbox</h1>
        <div className="mailbox-header-meta">
          <span data-testid="mailbox-user-email">{descriptor.email}</span>
          <LogoutButton />
        </div>
      </header>
      <Card
        title="Authorized"
        description="You are signed in. The full inbox lands with CAP-043."
      >
        <p data-testid="mailbox-placeholder">
          Authorized mailbox shell. Inbox, threads, and compose land with
          CAP-043 and CAP-044.
        </p>
        {descriptor.displayName !== null ? (
          <p className="mailbox-subtitle" data-testid="mailbox-display-name">
            Display name: {descriptor.displayName}
          </p>
        ) : null}
      </Card>
    </main>
  );
}